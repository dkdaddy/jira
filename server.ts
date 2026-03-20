import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level: 'info' | 'warn' | 'error', message: string, metadata: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...metadata }));
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface JiraConfig {
  host: string;
  email: string;
  apiToken: string;
  port: number;
  maxResults: number;
  closedStatuses: string[];
}

interface ProjectsConfig {
  projects: string[];
}

interface FieldMapping {
  path: string;
  type: string;
  label: string;
}

type FieldMappings = Record<string, FieldMapping>;

interface DashboardDef {
  id: string;
  title: string;
  view: string;
  baseFilter: string;
  filterWidgets: string[];
  columns: string[];
}

interface DashboardsConfig {
  dashboards: DashboardDef[];
}

type OrgConfig = Record<string, Record<string, string[]>>;
type InitiativesConfig = Record<string, string[]>;

interface SyncMeta {
  lastSync: string;
  latestSnapshot: string;
  snapshotPath: string;
  projects: string[];
  issueCount: number;
  syncDuration: number;
  syncType: string;
  lastError: { timestamp: string; message: string; type: string } | null;
  cacheSize: string;
}

interface NormalizedIssue {
  [field: string]: unknown;
  key: string;
  healthStatus: string;
}

interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraRawIssue[];
}

interface JiraRawIssue {
  key: string;
  fields: Record<string, unknown>;
}

interface HealthCounts {
  red: number;
  yellow: number;
  green: number;
}

interface RollupMetrics {
  totalEstimate: number;
  completedEstimate: number;
  completionPct: number;
  issueCount: number;
  healthCounts: HealthCounts;
}

interface TeamNode {
  id: string;
  name: string;
  metrics: RollupMetrics;
}

interface GroupNode {
  id: string;
  name: string;
  teams: TeamNode[];
  metrics: RollupMetrics;
}

interface OrgNode {
  org: string;
  groups: GroupNode[];
  metrics: RollupMetrics;
}

interface InitiativeNode {
  id: string;
  name: string;
  metrics: {
    totalEstimate: number;
    completedEstimate: number;
    progress: number;
    issueCount: number;
    atRisk: number;
  };
}

interface GoalNode {
  goal: string;
  initiatives: InitiativeNode[];
  metrics: {
    totalEstimate: number;
    completedEstimate: number;
    progress: number;
    issueCount: number;
    atRisk: number;
  };
}

interface HierarchyNode {
  key: string;
  summary: string;
  issueType: string;
  children: HierarchyNode[];
  metrics: {
    totalEstimate: number;
    completedEstimate: number;
    completionPct: number;
    issueCount: number;
    healthStatus: string;
  };
}

// ─── Configuration Loading ────────────────────────────────────────────────────

function loadYaml<T>(filePath: string): T {
  const fullPath = path.resolve(__dirname, filePath);
  try {
    const raw = fs.readFileSync(fullPath, 'utf8');
    return yaml.load(raw) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Failed to parse ${filePath}`, { error: msg });
    process.exit(1);
  }
}

function loadConfig(): {
  jira: JiraConfig;
  projects: ProjectsConfig;
  fieldMappings: FieldMappings;
  dashboards: DashboardsConfig;
  org: OrgConfig;
  initiatives: InitiativesConfig;
} {
  const jira = loadYaml<JiraConfig>('config/jira.yaml');
  const required: (keyof JiraConfig)[] = ['host', 'email', 'apiToken'];
  const missing = required.filter((k) => !jira[k]);
  if (missing.length > 0) {
    log('error', 'Missing required fields in config/jira.yaml', { missing });
    process.exit(1);
  }
  jira.port = jira.port ?? 3000;
  jira.maxResults = jira.maxResults ?? 100;
  jira.closedStatuses = jira.closedStatuses ?? ['Done', 'Closed', 'Resolved', "Won't Do"];

  const projects = loadYaml<ProjectsConfig>('config/projects.yaml');
  assert(Array.isArray(projects.projects) && projects.projects.length > 0, 'projects.yaml must list at least one project');

  const fieldMappings = loadYaml<FieldMappings>('config/field-mappings.yaml');
  const dashboards = loadYaml<DashboardsConfig>('config/dashboards.yaml');
  const org = loadYaml<OrgConfig>('config/org.yaml');
  const initiatives = loadYaml<InitiativesConfig>('config/initiatives.yaml');

  return { jira, projects, fieldMappings, dashboards, org, initiatives };
}

// ─── Jira API Client ──────────────────────────────────────────────────────────

function createJiraClient(config: JiraConfig) {
  const authHeader = 'Basic ' + Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  const baseUrl = config.host.replace(/\/+$/, '');

  async function fetchWithRetry(url: string, maxRetries = 3): Promise<unknown> {
    let delay = 100;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const response = await fetch(url, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : delay;
        log('warn', 'Rate limited, retrying', { retryAfterMs: waitMs });
        await sleep(waitMs);
        delay *= 2;
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} from ${url}: ${body}`);
      }

      return response.json();
    }
    throw new Error(`Exhausted ${maxRetries} retries for ${url}`);
  }

  async function fetchFields(): Promise<Array<{ id: string; name: string; custom: boolean }>> {
    const url = `${baseUrl}/rest/api/3/field`;
    return (await fetchWithRetry(url)) as Array<{ id: string; name: string; custom: boolean }>;
  }

  async function searchIssues(jql: string, startAt: number, maxResults: number): Promise<JiraSearchResponse> {
    const params = new URLSearchParams({
      jql,
      startAt: String(startAt),
      maxResults: String(maxResults),
      fields: '*all',
    });
    const url = `${baseUrl}/rest/api/3/search/jql?${params.toString()}`;
    const response = (await fetchWithRetry(url)) as any;
    
    // Handle different response structures from the new API
    const normalized: JiraSearchResponse = {
      startAt: response.startAt ?? startAt,
      maxResults: response.maxResults ?? maxResults,
      total: response.total ?? response.totalResults ?? response.issues?.length ?? 0,
      issues: response.issues ?? [],
    };
    
    return normalized;
  }

  return { fetchFields, searchIssues };
}

// ─── Field Resolution & Normalization ─────────────────────────────────────────

function resolveFieldPath(obj: unknown, dotPath: string): unknown {
  if (dotPath === 'key') return undefined; // handled separately
  if (dotPath === '_computed') return undefined; // computed server-side
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}

function normalizeIssue(raw: JiraRawIssue, mappings: FieldMappings, closedStatuses: string[]): NormalizedIssue {
  const result: NormalizedIssue = { key: raw.key, healthStatus: 'green' };

  for (const [logicalName, mapping] of Object.entries(mappings)) {
    if (logicalName === 'healthStatus') continue; // computed later
    if (mapping.path === 'key') {
      result[logicalName] = raw.key;
    } else if (mapping.path === '_computed') {
      // skip — set after normalization
    } else {
      result[logicalName] = resolveFieldPath(raw.fields, mapping.path);
    }
  }

  result.project = raw.key.split('-')[0];
  result.healthStatus = computeHealthStatus(result, closedStatuses);
  return result;
}

function computeHealthStatus(issue: NormalizedIssue, closedStatuses: string[]): string {
  const status = issue.status as string | null;
  if (status && closedStatuses.includes(status)) return 'green';
  if (status === 'Blocked') return 'red';

  const dueDateVal = issue.dueDate as string | null;
  if (dueDateVal) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDateVal);
    if (due < today) return 'red';
    if (due.getTime() - today.getTime() < 7 * 24 * 60 * 60 * 1000) return 'yellow';
  }

  if (!issue.assignee) return 'yellow';
  return 'green';
}

// ─── Cache Management ─────────────────────────────────────────────────────────

const CACHE_DIR = path.resolve(__dirname, 'cache');
const META_PATH = path.join(CACHE_DIR, 'meta.json');
const FIELD_DEFS_PATH = path.join(CACHE_DIR, 'field-definitions.json');

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadMeta(): SyncMeta | null {
  if (!fs.existsSync(META_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8')) as SyncMeta;
  } catch {
    log('warn', 'Corrupt meta.json — will do full sync');
    return null;
  }
}

function saveMeta(meta: SyncMeta): void {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf8');
}

function loadSnapshot(snapshotPath: string, projects: string[]): JiraRawIssue[] {
  const issues: JiraRawIssue[] = [];
  for (const proj of projects) {
    const filePath = path.join(snapshotPath, `${proj}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as JiraRawIssue[];
        issues.push(...data);
      } catch {
        log('warn', `Corrupt snapshot file ${filePath}`);
      }
    }
  }
  return issues;
}

function transformRawIssues(rawIssues: JiraRawIssue[], mappings: FieldMappings, closedStatuses: string[]): NormalizedIssue[] {
  return rawIssues.map((raw) => normalizeIssue(raw, mappings, closedStatuses));
}

function calculateDirSize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += calculateDirSize(entryPath);
    } else {
      total += fs.statSync(entryPath).size;
    }
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── Sync Engine ──────────────────────────────────────────────────────────────

async function performSync(
  config: ReturnType<typeof loadConfig>,
): Promise<JiraRawIssue[]> {
  const { jira, projects } = config;
  const client = createJiraClient(jira);
  const meta = loadMeta();
  const syncStart = Date.now();

  ensureCacheDir();

  // Fetch field definitions
  log('info', 'Fetching Jira field definitions');
  try {
    const fields = await client.fetchFields();
    fs.writeFileSync(FIELD_DEFS_PATH, JSON.stringify(fields, null, 2), 'utf8');
    log('info', 'Field definitions cached', { count: fields.length });
  } catch (err) {
    log('warn', 'Could not fetch field definitions', { error: err instanceof Error ? err.message : String(err) });
  }

  // Build JQL
  const projectList = projects.projects.map((p) => p).join(', ');
  let jql: string;
  let syncType: string;

  const projectsChanged = meta?.projects
    ? JSON.stringify([...meta.projects].sort()) !== JSON.stringify([...projects.projects].sort())
    : false;

  // Also check if any project is missing from the latest snapshot
  const snapshotMissing = meta?.snapshotPath
    ? projects.projects.some((p) => !fs.existsSync(path.resolve(__dirname, meta.snapshotPath, `${p}.json`)))
    : false;

  const needsFullSync = projectsChanged || snapshotMissing;

  if (projectsChanged) {
    log('info', 'Project list changed — forcing full sync', {
      previous: meta!.projects,
      current: projects.projects,
    });
  } else if (snapshotMissing) {
    const missing = projects.projects.filter((p) => !fs.existsSync(path.resolve(__dirname, meta!.snapshotPath, `${p}.json`)));
    log('info', 'Projects missing from snapshot — forcing full sync', { missing });
  }

  if (meta?.lastSync && !needsFullSync) {
    const lastSyncDuration = meta.syncDuration || 60;
    const bufferSeconds = Math.max(60, lastSyncDuration * 2);
    const safeLastSync = new Date(new Date(meta.lastSync).getTime() - bufferSeconds * 1000);
    const formatted = safeLastSync.toISOString().replace('T', ' ').slice(0, 19);
    jql = `project IN (${projectList}) AND updated >= "${formatted}" ORDER BY updated ASC`;
    syncType = 'incremental';
    log('info', 'Performing incremental sync', { since: formatted, buffer: bufferSeconds });
  } else {
    jql = `project IN (${projectList}) ORDER BY updated DESC`;
    syncType = 'full';
    log('info', 'Performing full sync', { projects: projects.projects });
  }

  // Paginate
  const rawIssues: JiraRawIssue[] = [];
  let startAt = 0;
  const maxResults = jira.maxResults;

  while (true) {
    const response = await client.searchIssues(jql, startAt, maxResults);

    if (response.total === 0) {
      log('info', 'No issues found matching JQL');
      break;
    }

    if (response.issues.length === 0 && startAt === 0) {
      throw new Error('Jira API returned 0 issues on first page — check JQL and permissions');
    }

    rawIssues.push(...response.issues);
    log('info', `Fetched ${rawIssues.length}/${response.total} issues`);

    if (startAt + maxResults >= response.total) break;
    if (rawIssues.length > response.total) {
      log('warn', 'Issue count exceeded total — data changed during sync');
      break;
    }

    startAt += maxResults;
    await sleep(100);
  }

  // Merge with previous snapshot for incremental syncs
  let allRawIssues: JiraRawIssue[];
  if (syncType === 'incremental' && meta) {
    const previousPath = path.resolve(__dirname, meta.snapshotPath);
    const previousIssues = loadSnapshot(previousPath, projects.projects);
    const issueMap = new Map<string, JiraRawIssue>();
    for (const issue of previousIssues) issueMap.set(issue.key, issue);
    for (const issue of rawIssues) issueMap.set(issue.key, issue);
    allRawIssues = Array.from(issueMap.values());
    log('info', 'Merged incremental sync', { previous: previousIssues.length, fresh: rawIssues.length, total: allRawIssues.length });
  } else {
    allRawIssues = rawIssues;
  }

  // Save snapshot (raw Jira data — transformation happens on load)
  const snapshotName = formatTimestamp(new Date());
  const snapshotDir = path.join(CACHE_DIR, snapshotName);
  fs.mkdirSync(snapshotDir, { recursive: true });

  // Group by project and save
  const byProject = new Map<string, JiraRawIssue[]>();
  for (const issue of allRawIssues) {
    const proj = issue.key.split('-')[0];
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj)!.push(issue);
  }
  for (const [proj, issues] of byProject) {
    fs.writeFileSync(path.join(snapshotDir, `${proj}.json`), JSON.stringify(issues, null, 2), 'utf8');
  }

  const syncDuration = (Date.now() - syncStart) / 1000;
  const cacheSize = formatBytes(calculateDirSize(CACHE_DIR));

  saveMeta({
    lastSync: new Date().toISOString(),
    latestSnapshot: snapshotName,
    snapshotPath: `cache/${snapshotName}`,
    projects: projects.projects,
    issueCount: allRawIssues.length,
    syncDuration,
    syncType,
    lastError: null,
    cacheSize,
  });

  log('info', 'Sync complete', { issues: allRawIssues.length, duration: syncDuration, snapshot: snapshotName });
  return allRawIssues;
}

// ─── Roll-up: Org Hierarchy ──────────────────────────────────────────────────

function buildOrgRollup(issues: NormalizedIssue[], orgConfig: OrgConfig, closedStatuses: string[]): OrgNode[] {
  // Build team → { group, org } lookup
  const teamLookup = new Map<string, { group: string; org: string }>();
  for (const [orgName, groups] of Object.entries(orgConfig)) {
    for (const [groupName, teams] of Object.entries(groups)) {
      for (const teamName of teams) {
        teamLookup.set(teamName.toLowerCase(), { group: groupName, org: orgName });
      }
    }
  }

  function metricsForIssues(list: NormalizedIssue[]): RollupMetrics {
    let totalEstimate = 0;
    let completedEstimate = 0;
    const healthCounts: HealthCounts = { red: 0, yellow: 0, green: 0 };
    let closedCount = 0;
    for (const issue of list) {
      const est = typeof issue.estimate === 'number' ? issue.estimate : 0;
      totalEstimate += est;
      const status = issue.status as string;
      if (closedStatuses.includes(status)) {
        completedEstimate += est;
        closedCount++;
      }
      const h = issue.healthStatus as keyof HealthCounts;
      if (h in healthCounts) healthCounts[h]++;
    }
    return {
      totalEstimate,
      completedEstimate,
      completionPct: list.length > 0 ? Math.round((closedCount / list.length) * 1000) / 10 : 0,
      issueCount: list.length,
      healthCounts,
    };
  }

  // Group issues by team
  const byTeam = new Map<string, NormalizedIssue[]>();
  const unassigned: NormalizedIssue[] = [];
  for (const issue of issues) {
    const teamVal = issue.team as string | null;
    if (teamVal && teamLookup.has(teamVal.toLowerCase())) {
      const key = teamVal.toLowerCase();
      if (!byTeam.has(key)) byTeam.set(key, []);
      byTeam.get(key)!.push(issue);
    } else {
      unassigned.push(issue);
    }
  }

  // Build tree
  const orgMap = new Map<string, Map<string, TeamNode[]>>();
  for (const [orgName, groups] of Object.entries(orgConfig)) {
    const groupMap = new Map<string, TeamNode[]>();
    for (const [groupName, teams] of Object.entries(groups)) {
      const teamNodes: TeamNode[] = [];
      for (const teamName of teams) {
        const teamIssues = byTeam.get(teamName.toLowerCase()) ?? [];
        teamNodes.push({
          id: teamName.toLowerCase().replace(/\s+/g, '-'),
          name: teamName,
          metrics: metricsForIssues(teamIssues),
        });
      }
      groupMap.set(groupName, teamNodes);
    }
    orgMap.set(orgName, groupMap);
  }

  const result: OrgNode[] = [];
  for (const [orgName, groupMap] of orgMap) {
    const groups: GroupNode[] = [];
    for (const [groupName, teams] of groupMap) {
      const groupMetrics = aggregateRollupMetrics(teams.map((t) => t.metrics));
      groups.push({
        id: groupName.toLowerCase().replace(/\s+/g, '-'),
        name: groupName,
        teams,
        metrics: groupMetrics,
      });
    }
    const orgMetrics = aggregateRollupMetrics(groups.map((g) => g.metrics));
    result.push({ org: orgName, groups, metrics: orgMetrics });
  }

  return result;
}

function aggregateRollupMetrics(metricsList: RollupMetrics[]): RollupMetrics {
  const total: RollupMetrics = {
    totalEstimate: 0,
    completedEstimate: 0,
    completionPct: 0,
    issueCount: 0,
    healthCounts: { red: 0, yellow: 0, green: 0 },
  };
  for (const m of metricsList) {
    total.totalEstimate += m.totalEstimate;
    total.completedEstimate += m.completedEstimate;
    total.issueCount += m.issueCount;
    total.healthCounts.red += m.healthCounts.red;
    total.healthCounts.yellow += m.healthCounts.yellow;
    total.healthCounts.green += m.healthCounts.green;
  }
  total.completionPct = total.issueCount > 0
    ? Math.round(((total.healthCounts.green) / total.issueCount) * 1000) / 10
    : 0;
  // Recalculate from closed counts properly
  const totalClosed = metricsList.reduce((acc, m) => {
    return acc + Math.round(m.completionPct * m.issueCount / 100);
  }, 0);
  total.completionPct = total.issueCount > 0
    ? Math.round((totalClosed / total.issueCount) * 1000) / 10
    : 0;
  return total;
}

// ─── Roll-up: Initiative Hierarchy ───────────────────────────────────────────

function buildInitiativeRollup(issues: NormalizedIssue[], initiativesConfig: InitiativesConfig, closedStatuses: string[]): GoalNode[] {
  // Build initiative → goal lookup
  const initLookup = new Map<string, string>();
  for (const [goal, initList] of Object.entries(initiativesConfig)) {
    for (const initName of initList) {
      initLookup.set(initName.toLowerCase(), goal);
    }
  }

  const result: GoalNode[] = [];
  for (const [goalName, initList] of Object.entries(initiativesConfig)) {
    const initiatives: InitiativeNode[] = [];
    for (const initName of initList) {
      const matching = issues.filter((i) => {
        const val = i.initiative as string | null;
        return val !== null && val !== undefined && val.toLowerCase() === initName.toLowerCase();
      });
      let totalEstimate = 0;
      let completedEstimate = 0;
      let atRisk = 0;
      for (const issue of matching) {
        const est = typeof issue.estimate === 'number' ? issue.estimate : 0;
        totalEstimate += est;
        if (closedStatuses.includes(issue.status as string)) completedEstimate += est;
        if (issue.healthStatus === 'red') atRisk++;
      }
      initiatives.push({
        id: initName.toLowerCase().replace(/\s+/g, '-'),
        name: initName,
        metrics: {
          totalEstimate,
          completedEstimate,
          progress: totalEstimate > 0 ? Math.round((completedEstimate / totalEstimate) * 1000) / 10 : 0,
          issueCount: matching.length,
          atRisk,
        },
      });
    }

    const goalMetrics = {
      totalEstimate: initiatives.reduce((s, i) => s + i.metrics.totalEstimate, 0),
      completedEstimate: initiatives.reduce((s, i) => s + i.metrics.completedEstimate, 0),
      progress: 0,
      issueCount: initiatives.reduce((s, i) => s + i.metrics.issueCount, 0),
      atRisk: initiatives.reduce((s, i) => s + i.metrics.atRisk, 0),
    };
    goalMetrics.progress = goalMetrics.totalEstimate > 0
      ? Math.round((goalMetrics.completedEstimate / goalMetrics.totalEstimate) * 1000) / 10
      : 0;

    result.push({ goal: goalName, initiatives, metrics: goalMetrics });
  }

  return result;
}

// ─── Roll-up: By Project ─────────────────────────────────────────────────────

interface ProjectNode {
  project: string;
  metrics: RollupMetrics;
}

function buildProjectRollup(issues: NormalizedIssue[], closedStatuses: string[]): ProjectNode[] {
  const byProject = new Map<string, NormalizedIssue[]>();
  for (const issue of issues) {
    const proj = issue.key.split('-')[0];
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj)!.push(issue);
  }

  const result: ProjectNode[] = [];
  for (const [project, projectIssues] of byProject) {
    let totalEstimate = 0;
    let completedEstimate = 0;
    const healthCounts: HealthCounts = { red: 0, yellow: 0, green: 0 };
    let closedCount = 0;
    for (const issue of projectIssues) {
      const est = typeof issue.estimate === 'number' ? issue.estimate : 0;
      totalEstimate += est;
      const status = issue.status as string;
      if (closedStatuses.includes(status)) {
        completedEstimate += est;
        closedCount++;
      }
      const h = issue.healthStatus as keyof HealthCounts;
      if (h in healthCounts) healthCounts[h]++;
    }
    result.push({
      project,
      metrics: {
        totalEstimate,
        completedEstimate,
        completionPct: projectIssues.length > 0 ? Math.round((closedCount / projectIssues.length) * 1000) / 10 : 0,
        issueCount: projectIssues.length,
        healthCounts,
      },
    });
  }

  return result.sort((a, b) => a.project.localeCompare(b.project));
}

// ─── Roll-up: Parent-Child Hierarchy ─────────────────────────────────────────

function buildParentChildHierarchy(issues: NormalizedIssue[], closedStatuses: string[]): HierarchyNode[] {
  const issueMap = new Map<string, NormalizedIssue>();
  for (const issue of issues) issueMap.set(issue.key, issue);

  // Cycle detection
  function hasCycle(key: string, visited: Set<string> = new Set()): boolean {
    if (visited.has(key)) {
      log('warn', 'Circular parent reference detected', { chain: Array.from(visited), loop: key });
      return true;
    }
    visited.add(key);
    const issue = issueMap.get(key);
    const parentKey = issue?.parent as string | null;
    if (parentKey && issueMap.has(parentKey)) {
      return hasCycle(parentKey, visited);
    }
    return false;
  }

  // Build children map
  const childrenMap = new Map<string, string[]>();
  for (const issue of issues) {
    const parentKey = issue.parent as string | null;
    if (parentKey && issueMap.has(parentKey) && !hasCycle(issue.key)) {
      if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
      childrenMap.get(parentKey)!.push(issue.key);
    }
  }

  // Identify roots (issues with no parent or whose parent is not in dataset)
  const hasParentInData = new Set<string>();
  for (const issue of issues) {
    const parentKey = issue.parent as string | null;
    if (parentKey && issueMap.has(parentKey)) {
      hasParentInData.add(issue.key);
    }
  }
  const rootKeys = issues.filter((i) => !hasParentInData.has(i.key)).map((i) => i.key);

  function buildNode(key: string): HierarchyNode {
    const issue = issueMap.get(key)!;
    const childKeys = childrenMap.get(key) ?? [];
    const children = childKeys.map((ck) => buildNode(ck));

    let totalEstimate = typeof issue.estimate === 'number' ? issue.estimate : 0;
    let completedEstimate = closedStatuses.includes(issue.status as string) ? totalEstimate : 0;
    let issueCount = 1;
    let worstHealth = issue.healthStatus as string;

    for (const child of children) {
      totalEstimate += child.metrics.totalEstimate;
      completedEstimate += child.metrics.completedEstimate;
      issueCount += child.metrics.issueCount;
      if (child.metrics.healthStatus === 'red') worstHealth = 'red';
      else if (child.metrics.healthStatus === 'yellow' && worstHealth !== 'red') worstHealth = 'yellow';
    }

    return {
      key: issue.key,
      summary: issue.summary as string,
      issueType: (issue.type as string) ?? 'Unknown',
      children,
      metrics: {
        totalEstimate,
        completedEstimate,
        completionPct: issueCount > 0 ? Math.round((completedEstimate / Math.max(totalEstimate, 1)) * 1000) / 10 : 0,
        issueCount,
        healthStatus: worstHealth,
      },
    };
  }

  return rootKeys.map((k) => buildNode(k));
}

// ─── CSV Export ────────────────────────────────────────────────────────────────

function issuesToCsv(issues: NormalizedIssue[], fieldMappings: FieldMappings): string {
  const fields = Object.keys(fieldMappings);
  const labels = fields.map((f) => fieldMappings[f].label);

  function escapeCsv(val: unknown): string {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const rows = [labels.map(escapeCsv).join(',')];
  for (const issue of issues) {
    const row = fields.map((f) => escapeCsv(issue[f]));
    rows.push(row.join(','));
  }
  return rows.join('\n');
}

// ─── ETag Generation ──────────────────────────────────────────────────────────

function generateETag(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return `"${hash.toString(36)}"`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  log('info', 'Configuration loaded', { projects: config.projects.projects });

  // Mutable state — updated on each sync
  let cachedRawIssues: JiraRawIssue[];
  let cachedIssues: NormalizedIssue[];
  let orgRollup: OrgNode[];
  let initiativeRollup: GoalNode[];
  let hierarchyRollup: HierarchyNode[];
  let projectRollup: ReturnType<typeof buildProjectRollup>;
  let syncInProgress = false;

  function recomputeFromRaw(): void {
    cachedIssues = transformRawIssues(cachedRawIssues, config.fieldMappings, config.jira.closedStatuses);
    orgRollup = buildOrgRollup(cachedIssues, config.org, config.jira.closedStatuses);
    initiativeRollup = buildInitiativeRollup(cachedIssues, config.initiatives, config.jira.closedStatuses);
    hierarchyRollup = buildParentChildHierarchy(cachedIssues, config.jira.closedStatuses);
    projectRollup = buildProjectRollup(cachedIssues, config.jira.closedStatuses);
  }

  // Initial sync
  try {
    cachedRawIssues = await performSync(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', 'Sync failed', { error: msg });

    // Try loading previous snapshot
    const meta = loadMeta();
    if (meta) {
      log('info', 'Falling back to previous snapshot', { snapshot: meta.latestSnapshot });
      cachedRawIssues = loadSnapshot(path.resolve(__dirname, meta.snapshotPath), config.projects.projects);
      saveMeta({
        ...meta,
        lastError: { timestamp: new Date().toISOString(), message: msg, type: 'SyncError' },
      });
    } else {
      log('error', 'No previous snapshot available — exiting');
      process.exit(1);
    }
  }

  recomputeFromRaw();

  // Start Express server
  const app = express();
  app.use(express.static(path.resolve(__dirname, 'public')));

  // API: Config (dashboards + org + initiatives merged)
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      dashboards: config.dashboards.dashboards,
      org: config.org,
      initiatives: config.initiatives,
    });
  });

  // API: All normalized issues
  app.get('/api/data', (req: Request, res: Response) => {
    const etag = generateETag(cachedIssues);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache');

    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.json(cachedIssues);
  });

  // API: Field mappings
  app.get('/api/fields', (_req: Request, res: Response) => {
    res.json(config.fieldMappings);
  });

  // API: Health/status
  app.get('/api/health', (_req: Request, res: Response) => {
    const meta = loadMeta();
    const ageMinutes = meta ? (Date.now() - new Date(meta.lastSync).getTime()) / 60000 : -1;
    const health: Record<string, unknown> = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      cache: meta
        ? {
            lastSync: meta.lastSync,
            ageMinutes: Math.round(ageMinutes * 10) / 10,
            issueCount: meta.issueCount,
            sizeBytes: meta.cacheSize,
          }
        : null,
      errors: meta?.lastError ? [meta.lastError] : [],
    };

    if (ageMinutes > 60) {
      health.status = 'degraded';
      health.warnings = ['Cache is over 1 hour old'];
    }

    res.json(health);
  });

  // API: Trigger re-sync from Jira
  app.post('/api/sync', async (_req: Request, res: Response) => {
    if (syncInProgress) {
      res.status(409).json({ error: 'Sync already in progress' });
      return;
    }
    syncInProgress = true;
    try {
      log('info', 'Manual sync triggered');
      cachedRawIssues = await performSync(config);
      recomputeFromRaw();
      const meta = loadMeta();
      res.json({ success: true, issueCount: cachedIssues.length, lastSync: meta?.lastSync });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('error', 'Manual sync failed', { error: msg });
      res.status(500).json({ error: msg });
    } finally {
      syncInProgress = false;
    }
  });

  // API: Org roll-up
  app.get('/api/rollup/org', (_req: Request, res: Response) => {
    res.json(orgRollup);
  });

  // API: Initiative roll-up
  app.get('/api/rollup/initiative', (_req: Request, res: Response) => {
    res.json(initiativeRollup);
  });

  // API: Parent-child hierarchy
  app.get('/api/rollup/hierarchy', (_req: Request, res: Response) => {
    res.json(hierarchyRollup);
  });

  // API: Project roll-up
  app.get('/api/rollup/project', (_req: Request, res: Response) => {
    res.json(projectRollup);
  });

  // API: CSV export
  app.get('/api/export/csv', (_req: Request, res: Response) => {
    const csv = issuesToCsv(cachedIssues, config.fieldMappings);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="jira-export.csv"');
    res.send(csv);
  });

  // API: JSON export
  app.get('/api/export/json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="jira-export.json"');
    res.json(cachedIssues);
  });

  // Fallback: serve index.html for SPA
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
  });

  app.listen(config.jira.port, () => {
    log('info', `Server running at http://localhost:${config.jira.port}`, {
      issues: cachedIssues.length,
      port: config.jira.port,
    });
  });
}

main().catch((err) => {
  log('error', 'Fatal error', { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
