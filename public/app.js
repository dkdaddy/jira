// ─── Strong-typed fetch wrapper ───────────────────────────────────────────────

/** @template T */
async function fetchJSON(/** @type {string} */ url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return /** @type {Promise<T>} */ (res.json());
}

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ dashboards: Array<DashboardDef>, org: Record<string,unknown>, initiatives: Record<string,unknown> } | null} */
let appConfig = null;

/** @type {Record<string, FieldMapping>} */
let fieldMappings = {};

/** @type {Array<Record<string, unknown>>} */
let allIssues = [];

/** @type {string} */
let activeDashboardId = '';

/** @type {Record<string, unknown>} */
let filterValues = {};

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const [config, fields, issues, health] = await Promise.all([
      fetchJSON('/api/config'),
      fetchJSON('/api/fields'),
      fetch('/api/data', { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetchJSON('/api/health'),
    ]);

    appConfig = /** @type {typeof appConfig} */ (config);
    fieldMappings = /** @type {typeof fieldMappings} */ (fields);
    allIssues = /** @type {typeof allIssues} */ (issues);

    renderSyncIndicator(/** @type {Record<string,unknown>} */ (health));
    renderHeaderStats();
    renderTabs();

    if (appConfig.dashboards.length > 0) {
      switchTab(appConfig.dashboards[0].id);
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }

  // Wire global buttons
  document.getElementById('btn-sync')?.addEventListener('click', syncFromJira);
  document.getElementById('btn-clear')?.addEventListener('click', clearFilters);
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    window.location.href = '/api/export/csv';
  });
  document.getElementById('btn-export-json')?.addEventListener('click', () => {
    window.location.href = '/api/export/json';
  });
  document.getElementById('search-input')?.addEventListener('input', () => renderCurrentTab());
});

// ─── Error Display ────────────────────────────────────────────────────────────

function showError(/** @type {string} */ msg) {
  const el = document.getElementById('error-banner');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError() {
  const el = document.getElementById('error-banner');
  if (el) el.classList.add('hidden');
}

// ─── Header Stats ─────────────────────────────────────────────────────────────

function renderHeaderStats() {
  const el = document.getElementById('header-stats');
  if (!el || !appConfig) return;

  const issueCount = allIssues.length;

  const projects = new Set(allIssues.map((i) => String(i.key ?? '').split('-')[0]).filter(Boolean));

  const teams = new Set(allIssues.map((i) => i.team).filter(Boolean));

  const initiatives = new Set(allIssues.map((i) => i.initiative).filter(Boolean));

  let redCount = 0;
  let yellowCount = 0;
  for (const issue of allIssues) {
    if (issue.healthStatus === 'red') redCount++;
    else if (issue.healthStatus === 'yellow') yellowCount++;
  }

  const stats = [
    { label: 'Issues', value: issueCount },
    { label: 'Projects', value: projects.size },
    { label: 'Teams', value: teams.size },
    { label: 'Initiatives', value: initiatives.size },
    { label: 'At Risk', value: redCount },
    { label: 'Needs Attention', value: yellowCount },
  ];

  el.innerHTML = '';
  for (const s of stats) {
    const span = document.createElement('span');
    span.className = 'stat';
    span.innerHTML = `<span class="stat-value">${s.value}</span> ${s.label}`;
    el.appendChild(span);
  }
}

// ─── Sync Indicator ───────────────────────────────────────────────────────────

function renderSyncIndicator(/** @type {Record<string,unknown>} */ health) {
  const el = document.getElementById('sync-indicator');
  if (!el) return;

  const cache = /** @type {Record<string,unknown> | null} */ (health.cache);
  if (!cache?.lastSync) {
    el.textContent = 'No sync data';
    return;
  }

  const syncDate = new Date(/** @type {string} */ (cache.lastSync));
  const ageMin = /** @type {number} */ (cache.ageMinutes);
  let ageText;
  if (ageMin < 1) ageText = 'just now';
  else if (ageMin < 60) ageText = `${Math.round(ageMin)}m ago`;
  else if (ageMin < 1440) ageText = `${Math.round(ageMin / 60)}h ago`;
  else ageText = `${Math.round(ageMin / 1440)}d ago`;

  el.textContent = `Data as of: ${syncDate.toLocaleString()} (${ageText})`;

  // Stale warning
  if (ageMin > 1440) {
    const content = document.getElementById('content-area');
    if (content) {
      const warn = document.createElement('div');
      warn.className = 'stale-warning';
      warn.textContent = `Warning: Cache is ${Math.round(ageMin / 60)} hours old. Click "Sync from Jira" to fetch fresh data.`;
      content.parentElement?.insertBefore(warn, content);
    }
  }
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

async function refreshData() {
  try {
    const [issues, health] = await Promise.all([
      fetch('/api/data', { cache: 'reload' }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetchJSON('/api/health'),
    ]);
    allIssues = issues;
    renderSyncIndicator(/** @type {Record<string,unknown>} */ (health));
    renderHeaderStats();
    renderCurrentTab();
    hideError();
  } catch (err) {
    showError('Refresh failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}

async function syncFromJira() {
  const btn = document.getElementById('btn-sync');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
  }
  try {
    const resp = await fetch('/api/sync?full=true', { method: 'POST' });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }
    await refreshData();
  } catch (err) {
    showError('Sync failed: ' + (err instanceof Error ? err.message : String(err)));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Sync from Jira';
    }
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function renderTabs() {
  const bar = document.getElementById('tab-bar');
  if (!bar || !appConfig) return;
  bar.innerHTML = '';

  for (const dash of appConfig.dashboards) {
    const btn = document.createElement('button');
    btn.textContent = dash.title;
    btn.dataset.id = dash.id;
    btn.addEventListener('click', () => switchTab(dash.id));
    bar.appendChild(btn);
  }
}

function switchTab(/** @type {string} */ id) {
  activeDashboardId = id;
  filterValues = {};

  // Update active state
  document.querySelectorAll('#tab-bar button').forEach((btn) => {
    const b = /** @type {HTMLButtonElement} */ (btn);
    b.classList.toggle('active', b.dataset.id === id);
  });

  // Clear search
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('search-input'));
  if (searchInput) searchInput.value = '';

  renderFilterBar();
  renderCurrentTab();
}

function getActiveDashboard() {
  if (!appConfig) return null;
  return appConfig.dashboards.find((d) => d.id === activeDashboardId) ?? null;
}

// ─── Base Filter Parser ──────────────────────────────────────────────────────

/**
 * Parses baseFilter expressions like:
 *   status = "In Progress"
 *   status IN ("A", "B")
 *   status = "X" AND type IN ("Story", "Epic")
 *   priority != "Low"
 */
function parseBaseFilter(/** @type {string} */ expr) {
  if (!expr.trim()) return () => true;

  const conditions = [];
  // Split on AND (case-insensitive), respecting quoted strings
  const parts = expr.split(/\s+AND\s+/i);

  for (const part of parts) {
    const trimmed = part.trim();

    // field IN ("val1", "val2", ...)
    const inMatch = trimmed.match(/^(\w+)\s+IN\s*\((.+)\)$/i);
    if (inMatch) {
      const field = inMatch[1];
      const values = [...inMatch[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      conditions.push((/** @type {Record<string,unknown>} */ issue) => {
        const v = issue[field];
        return v !== null && v !== undefined && values.includes(String(v));
      });
      continue;
    }

    // field != "value"
    const neqMatch = trimmed.match(/^(\w+)\s*!=\s*"([^"]+)"$/);
    if (neqMatch) {
      const field = neqMatch[1];
      const value = neqMatch[2];
      conditions.push((/** @type {Record<string,unknown>} */ issue) => String(issue[field] ?? '') !== value);
      continue;
    }

    // field = "value"
    const eqMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]+)"$/);
    if (eqMatch) {
      const field = eqMatch[1];
      const value = eqMatch[2];
      conditions.push((/** @type {Record<string,unknown>} */ issue) => String(issue[field] ?? '') === value);
      continue;
    }
  }

  return (/** @type {Record<string,unknown>} */ issue) => conditions.every((fn) => fn(issue));
}

// ─── Filter Widgets ──────────────────────────────────────────────────────────

function renderFilterBar() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  bar.innerHTML = '';

  const dash = getActiveDashboard();
  if (!dash) return;

  const baseFilterFn = parseBaseFilter(dash.baseFilter);
  const baseData = allIssues.filter(baseFilterFn);

  for (const fieldName of dash.filterWidgets) {
    const mapping = fieldMappings[fieldName];
    if (!mapping) continue;

    const widget = document.createElement('div');
    widget.className = 'filter-widget';

    const label = document.createElement('label');
    label.textContent = mapping.label;
    widget.appendChild(label);

    switch (mapping.type) {
      case 'dropdown': {
        const select = document.createElement('select');
        select.dataset.field = fieldName;

        const optAll = document.createElement('option');
        optAll.value = '';
        optAll.textContent = `All ${mapping.label}`;
        select.appendChild(optAll);

        const values = [...new Set(baseData.map((i) => i[fieldName]).filter((v) => v !== null && v !== undefined).map(String))].sort();
        for (const v of values) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          select.appendChild(opt);
        }

        select.addEventListener('change', () => {
          filterValues[fieldName] = select.value || null;
          renderCurrentTab();
        });

        widget.appendChild(select);
        break;
      }

      case 'text': {
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = `Filter ${mapping.label}...`;
        input.dataset.field = fieldName;

        input.addEventListener('input', () => {
          filterValues[fieldName] = input.value || null;
          renderCurrentTab();
        });

        widget.appendChild(input);
        break;
      }

      case 'number': {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '0.25rem';

        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.placeholder = 'Min';
        minInput.style.width = '60px';

        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.placeholder = 'Max';
        maxInput.style.width = '60px';

        const onChange = () => {
          filterValues[fieldName] = {
            min: minInput.value ? Number(minInput.value) : null,
            max: maxInput.value ? Number(maxInput.value) : null,
          };
          renderCurrentTab();
        };
        minInput.addEventListener('input', onChange);
        maxInput.addEventListener('input', onChange);

        wrap.appendChild(minInput);
        wrap.appendChild(maxInput);
        widget.appendChild(wrap);
        break;
      }

      case 'date': {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '0.25rem';

        const fromInput = document.createElement('input');
        fromInput.type = 'date';
        fromInput.title = 'From';

        const toInput = document.createElement('input');
        toInput.type = 'date';
        toInput.title = 'To';

        const onChange = () => {
          filterValues[fieldName] = {
            from: fromInput.value || null,
            to: toInput.value || null,
          };
          renderCurrentTab();
        };
        fromInput.addEventListener('input', onChange);
        toInput.addEventListener('input', onChange);

        wrap.appendChild(fromInput);
        wrap.appendChild(toInput);
        widget.appendChild(wrap);
        break;
      }

      case 'multiselect': {
        const select = document.createElement('select');
        select.multiple = true;
        select.dataset.field = fieldName;
        select.style.minHeight = '60px';

        const allValues = new Set();
        for (const issue of baseData) {
          const val = issue[fieldName];
          if (Array.isArray(val)) {
            for (const v of val) allValues.add(String(v));
          } else if (val !== null && val !== undefined) {
            allValues.add(String(val));
          }
        }

        for (const v of [...allValues].sort()) {
          const opt = document.createElement('option');
          opt.value = /** @type {string} */ (v);
          opt.textContent = /** @type {string} */ (v);
          select.appendChild(opt);
        }

        select.addEventListener('change', () => {
          const selected = [...select.selectedOptions].map((o) => o.value);
          filterValues[fieldName] = selected.length > 0 ? selected : null;
          renderCurrentTab();
        });

        widget.appendChild(select);
        break;
      }
    }

    bar.appendChild(widget);
  }
}

// ─── Filtering Pipeline ──────────────────────────────────────────────────────

function getFilteredIssues() {
  const dash = getActiveDashboard();
  if (!dash) return [];

  // 1. Base filter
  const baseFilterFn = parseBaseFilter(dash.baseFilter);
  let result = allIssues.filter(baseFilterFn);

  // 2. Search input
  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('search-input'));
  const searchText = searchInput?.value?.toLowerCase() ?? '';
  if (searchText) {
    result = result.filter((issue) => {
      const key = String(issue.key ?? '').toLowerCase();
      const summary = String(issue.summary ?? '').toLowerCase();
      return key.includes(searchText) || summary.includes(searchText);
    });
  }

  // 3. Filter widgets
  for (const [fieldName, value] of Object.entries(filterValues)) {
    if (value === null || value === undefined) continue;

    const mapping = fieldMappings[fieldName];
    if (!mapping) continue;

    switch (mapping.type) {
      case 'dropdown':
        if (typeof value === 'string' && value) {
          result = result.filter((i) => String(i[fieldName] ?? '') === value);
        }
        break;

      case 'text':
        if (typeof value === 'string' && value) {
          const lower = value.toLowerCase();
          result = result.filter((i) => String(i[fieldName] ?? '').toLowerCase().includes(lower));
        }
        break;

      case 'number': {
        const range = /** @type {{ min: number | null, max: number | null }} */ (value);
        result = result.filter((i) => {
          const num = Number(i[fieldName]);
          if (isNaN(num)) return false;
          if (range.min !== null && num < range.min) return false;
          if (range.max !== null && num > range.max) return false;
          return true;
        });
        break;
      }

      case 'date': {
        const range = /** @type {{ from: string | null, to: string | null }} */ (value);
        result = result.filter((i) => {
          const dateStr = i[fieldName];
          if (!dateStr) return false;
          const d = new Date(String(dateStr));
          if (range.from && d < new Date(range.from)) return false;
          if (range.to && d > new Date(range.to + 'T23:59:59')) return false;
          return true;
        });
        break;
      }

      case 'multiselect': {
        const selected = /** @type {string[]} */ (value);
        if (selected.length > 0) {
          result = result.filter((i) => {
            const val = i[fieldName];
            if (Array.isArray(val)) {
              return val.some((v) => selected.includes(String(v)));
            }
            return selected.includes(String(val ?? ''));
          });
        }
        break;
      }
    }
  }

  return result;
}

// ─── Clear Filters ────────────────────────────────────────────────────────────

function clearFilters() {
  filterValues = {};

  const searchInput = /** @type {HTMLInputElement | null} */ (document.getElementById('search-input'));
  if (searchInput) searchInput.value = '';

  // Reset all filter widgets
  document.querySelectorAll('.filter-widget select').forEach((el) => {
    const s = /** @type {HTMLSelectElement} */ (el);
    if (s.multiple) {
      [...s.options].forEach((o) => (o.selected = false));
    } else {
      s.value = '';
    }
  });
  document.querySelectorAll('.filter-widget input').forEach((el) => {
    const inp = /** @type {HTMLInputElement} */ (el);
    inp.value = '';
  });

  renderCurrentTab();
}

// ─── Render Controller ────────────────────────────────────────────────────────

function renderCurrentTab() {
  const dash = getActiveDashboard();
  const content = document.getElementById('content-area');
  if (!content || !dash) return;

  content.innerHTML = '';

  switch (dash.view) {
    case 'flat':
      renderFlatTable(content, dash);
      break;
    case 'org':
      renderOrgView(content);
      break;
    case 'initiative':
      renderInitiativeView(content);
      break;
    case 'project':
      renderProjectView(content);
      break;
    case 'hierarchy':
      renderHierarchyView(content);
      break;
    default:
      renderFlatTable(content, dash);
  }
}

// ─── Flat Table View ──────────────────────────────────────────────────────────

function renderFlatTable(/** @type {HTMLElement} */ container, /** @type {DashboardDef} */ dash) {
  const issues = getFilteredIssues();

  if (issues.length === 0) {
    container.innerHTML = '<div class="empty-state">No issues match the current filters.</div>';
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'data-table-wrap';

  const table = document.createElement('table');
  table.className = 'data-table';

  // Header
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of dash.columns) {
    const th = document.createElement('th');
    const mapping = fieldMappings[col];
    th.textContent = mapping ? mapping.label : col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  for (const issue of issues) {
    const tr = document.createElement('tr');
    const health = issue.healthStatus;

    for (const col of dash.columns) {
      const td = document.createElement('td');

      if (col === 'healthStatus') {
        const badge = document.createElement('span');
        badge.className = `health-badge ${health}`;
        td.appendChild(badge);
        const reason = issue.healthReason;
        td.append(String(reason ?? ''));
      } else {
        const val = issue[col];
        td.textContent = formatCellValue(val);
      }

      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function formatCellValue(/** @type {unknown} */ val) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.join(', ');
  return String(val);
}

// ─── Shared: build an issue table from dashboard columns ─────────────────────

function buildIssueTable(/** @type {Array<Record<string,unknown>>} */ issues, /** @type {string[]} */ columns) {
  const wrap = document.createElement('div');
  wrap.className = 'data-table-wrap';

  const table = document.createElement('table');
  table.className = 'data-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    const mapping = fieldMappings[col];
    th.textContent = mapping ? mapping.label : col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const issue of issues) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      if (col === 'healthStatus') {
        const badge = document.createElement('span');
        badge.className = `health-badge ${issue.healthStatus}`;
        td.appendChild(badge);
        td.append(String(issue.healthReason ?? ''));
      } else {
        td.textContent = formatCellValue(issue[col]);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

// ─── Shared: build a stats header bar ────────────────────────────────────────

function buildStatsHeader(/** @type {Array<Record<string,unknown>>} */ issues) {
  const statsDiv = document.createElement('div');
  statsDiv.className = 'rollup-metrics';

  let totalEstimate = 0;
  let redCount = 0;
  let yellowCount = 0;
  let greenCount = 0;
  for (const issue of issues) {
    totalEstimate += typeof issue.estimate === 'number' ? issue.estimate : 0;
    if (issue.healthStatus === 'red') redCount++;
    else if (issue.healthStatus === 'yellow') yellowCount++;
    else greenCount++;
  }

  const statItems = [
    { label: 'Issues', value: issues.length },
    { label: 'Estimate', value: totalEstimate },
  ];

  for (const s of statItems) {
    const m = document.createElement('div');
    m.className = 'metric';
    const mv = document.createElement('span');
    mv.className = 'metric-value';
    mv.textContent = String(s.value);
    const ml = document.createElement('span');
    ml.className = 'metric-label';
    ml.textContent = s.label;
    m.appendChild(mv);
    m.appendChild(ml);
    statsDiv.appendChild(m);
  }

  const healthMetric = document.createElement('div');
  healthMetric.className = 'metric health-summary';
  const counts = [
    { color: 'green', count: greenCount },
    { color: 'yellow', count: yellowCount },
    { color: 'red', count: redCount },
  ];
  for (const c of counts) {
    const pair = document.createElement('span');
    pair.className = 'health-pair';
    const badge = document.createElement('span');
    badge.className = `health-badge ${c.color}`;
    pair.appendChild(badge);
    pair.append(String(c.count));
    healthMetric.appendChild(pair);
  }
  statsDiv.appendChild(healthMetric);

  return statsDiv;
}

// ─── Org Roll-up View ─────────────────────────────────────────────────────────

async function renderOrgView(/** @type {HTMLElement} */ container) {
  const dash = getActiveDashboard();
  if (!dash) return;

  const issues = getFilteredIssues();

  if (issues.length === 0) {
    container.innerHTML = '<div class="empty-state">No issues match the current filters.</div>';
    return;
  }

  // Fetch org config to get the org → group → team hierarchy
  let orgData;
  try {
    orgData = await fetchJSON('/api/rollup/org');
  } catch (_) {
    orgData = [];
  }
  const orgNodes = /** @type {Array<Record<string,unknown>>} */ (orgData);

  // Build team → issues lookup from filtered issues
  /** @type {Map<string, Array<Record<string,unknown>>>} */
  const byTeam = new Map();
  for (const issue of issues) {
    const team = String(issue.team ?? '').toLowerCase();
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(issue);
  }

  if (orgNodes.length > 0) {
    // Render using org hierarchy structure
    for (const org of orgNodes) {
      const orgCard = document.createElement('div');
      orgCard.className = 'rollup-card';

      const h2 = document.createElement('h2');
      h2.textContent = /** @type {string} */ (org.org);
      orgCard.appendChild(h2);

      // Collect all issues for this org
      const orgIssues = [];
      const groups = /** @type {Array<Record<string,unknown>>} */ (org.groups);
      for (const group of groups) {
        const teams = /** @type {Array<Record<string,unknown>>} */ (group.teams);
        for (const team of teams) {
          const teamName = /** @type {string} */ (team.name).toLowerCase();
          const teamIssues = byTeam.get(teamName) ?? [];
          orgIssues.push(...teamIssues);
        }
      }
      orgCard.appendChild(buildStatsHeader(orgIssues));

      for (const group of groups) {
        const h3 = document.createElement('h3');
        h3.textContent = /** @type {string} */ (group.name);
        orgCard.appendChild(h3);

        const teams = /** @type {Array<Record<string,unknown>>} */ (group.teams);
        for (const team of teams) {
          const teamName = /** @type {string} */ (team.name);
          const teamIssues = byTeam.get(teamName.toLowerCase()) ?? [];
          if (teamIssues.length === 0) continue;

          const teamSection = document.createElement('div');
          teamSection.className = 'team-section';

          const h4 = document.createElement('h4');
          h4.textContent = teamName;
          teamSection.appendChild(h4);
          teamSection.appendChild(buildStatsHeader(teamIssues));
          teamSection.appendChild(buildIssueTable(teamIssues, dash.columns));

          orgCard.appendChild(teamSection);
        }
      }

      container.appendChild(orgCard);
    }
  } else {
    // Fallback: group by team field directly
    const sortedTeams = [...byTeam.keys()].sort();
    for (const teamKey of sortedTeams) {
      const teamIssues = byTeam.get(teamKey);
      const card = document.createElement('div');
      card.className = 'rollup-card';

      const h2 = document.createElement('h2');
      h2.textContent = teamKey || '(No Team)';
      card.appendChild(h2);
      card.appendChild(buildStatsHeader(teamIssues));
      card.appendChild(buildIssueTable(teamIssues, dash.columns));

      container.appendChild(card);
    }
  }
}

// ─── Initiative Roll-up View ──────────────────────────────────────────────────

async function renderInitiativeView(/** @type {HTMLElement} */ container) {
  const dash = getActiveDashboard();
  if (!dash) return;

  const issues = getFilteredIssues();

  if (issues.length === 0) {
    container.innerHTML = '<div class="empty-state">No issues match the current filters.</div>';
    return;
  }

  // Fetch initiative config to get goal → initiative hierarchy
  let goalData;
  try {
    goalData = await fetchJSON('/api/rollup/initiative');
  } catch (_) {
    goalData = [];
  }
  const goals = /** @type {Array<Record<string,unknown>>} */ (goalData);

  // Build initiative → issues lookup from filtered issues
  /** @type {Map<string, Array<Record<string,unknown>>>} */
  const byInitiative = new Map();
  const unmatched = [];
  for (const issue of issues) {
    const init = String(issue.initiative ?? '').toLowerCase();
    if (init) {
      if (!byInitiative.has(init)) byInitiative.set(init, []);
      byInitiative.get(init).push(issue);
    } else {
      unmatched.push(issue);
    }
  }

  // Track which byInitiative keys have been rendered
  const rendered = new Set();

  if (goals.length > 0) {
    for (const goal of goals) {
      const goalCard = document.createElement('div');
      goalCard.className = 'rollup-card';

      const goalName = /** @type {string} */ (goal.goal);
      const h2 = document.createElement('h2');
      h2.textContent = goalName;
      goalCard.appendChild(h2);

      // Collect issues matching sub-initiative names OR the goal name itself
      const goalIssues = [];
      const initiatives = /** @type {Array<Record<string,unknown>>} */ (goal.initiatives);
      for (const init of initiatives) {
        const initName = /** @type {string} */ (init.name).toLowerCase();
        const initIssues = byInitiative.get(initName) ?? [];
        goalIssues.push(...initIssues);
        if (initIssues.length > 0) rendered.add(initName);
      }
      // Also include issues whose initiative value matches the goal name
      const goalDirectIssues = byInitiative.get(goalName.toLowerCase()) ?? [];
      goalIssues.push(...goalDirectIssues);
      if (goalDirectIssues.length > 0) rendered.add(goalName.toLowerCase());

      goalCard.appendChild(buildStatsHeader(goalIssues));

      // Render sub-initiative sections
      for (const init of initiatives) {
        const initName = /** @type {string} */ (init.name);
        const initIssues = byInitiative.get(initName.toLowerCase()) ?? [];
        if (initIssues.length === 0) continue;

        const initSection = document.createElement('div');
        initSection.className = 'team-section';

        const h3 = document.createElement('h3');
        h3.textContent = initName;
        initSection.appendChild(h3);
        initSection.appendChild(buildStatsHeader(initIssues));
        initSection.appendChild(buildIssueTable(initIssues, dash.columns));

        goalCard.appendChild(initSection);
      }

      // Render issues matching the goal name directly (not a sub-initiative)
      if (goalDirectIssues.length > 0) {
        const directSection = document.createElement('div');
        directSection.className = 'team-section';

        const h3 = document.createElement('h3');
        h3.textContent = goalName + ' (General)';
        directSection.appendChild(h3);
        directSection.appendChild(buildStatsHeader(goalDirectIssues));
        directSection.appendChild(buildIssueTable(goalDirectIssues, dash.columns));

        goalCard.appendChild(directSection);
      }

      container.appendChild(goalCard);
    }

    // Show issues with initiative values that didn't match any goal or sub-initiative
    const otherKeys = [...byInitiative.keys()].filter((k) => !rendered.has(k)).sort();
    if (otherKeys.length > 0) {
      for (const initKey of otherKeys) {
        const initIssues = byInitiative.get(initKey);
        const card = document.createElement('div');
        card.className = 'rollup-card';

        const h2 = document.createElement('h2');
        h2.textContent = initKey;
        card.appendChild(h2);
        card.appendChild(buildStatsHeader(initIssues));
        card.appendChild(buildIssueTable(initIssues, dash.columns));

        container.appendChild(card);
      }
    }
  } else {
    // Fallback: group by initiative field directly
    const sortedInits = [...byInitiative.keys()].sort();
    for (const initKey of sortedInits) {
      const initIssues = byInitiative.get(initKey);
      const card = document.createElement('div');
      card.className = 'rollup-card';

      const h2 = document.createElement('h2');
      h2.textContent = initKey || '(No Initiative)';
      card.appendChild(h2);
      card.appendChild(buildStatsHeader(initIssues));
      card.appendChild(buildIssueTable(initIssues, dash.columns));

      container.appendChild(card);
    }
  }

  // Show issues with no initiative value
  if (unmatched.length > 0) {
    const card = document.createElement('div');
    card.className = 'rollup-card';

    const h2 = document.createElement('h2');
    h2.textContent = '(No Initiative)';
    card.appendChild(h2);
    card.appendChild(buildStatsHeader(unmatched));
    card.appendChild(buildIssueTable(unmatched, dash.columns));

    container.appendChild(card);
  }
}

// ─── Hierarchy View ───────────────────────────────────────────────────────────

// ─── Project Roll-up View ─────────────────────────────────────────────────────

async function renderProjectView(/** @type {HTMLElement} */ container) {
  const dash = getActiveDashboard();
  if (!dash) return;

  const issues = getFilteredIssues();

  if (issues.length === 0) {
    container.innerHTML = '<div class="empty-state">No issues match the current filters.</div>';
    return;
  }

  // Group issues by project key
  /** @type {Map<string, Array<Record<string,unknown>>>} */
  const byProject = new Map();
  for (const issue of issues) {
    const proj = String(issue.key ?? '').split('-')[0];
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(issue);
  }

  const sortedProjects = [...byProject.keys()].sort();

  for (const proj of sortedProjects) {
    const projectIssues = byProject.get(proj);

    const section = document.createElement('div');
    section.className = 'rollup-card';

    const h2 = document.createElement('h2');
    h2.textContent = proj;
    section.appendChild(h2);

    section.appendChild(buildStatsHeader(projectIssues));
    section.appendChild(buildIssueTable(projectIssues, dash.columns));

    container.appendChild(section);
  }
}

// ─── Hierarchy View ───────────────────────────────────────────────────────────

async function renderHierarchyView(/** @type {HTMLElement} */ container) {
  const dash = getActiveDashboard();
  if (!dash) return;

  const issues = getFilteredIssues();

  if (issues.length === 0) {
    container.innerHTML = '<div class="empty-state">No issues match the current filters.</div>';
    return;
  }

  // Build parent→children map from filtered issues
  /** @type {Map<string, Record<string,unknown>>} */
  const issueMap = new Map();
  for (const issue of issues) issueMap.set(String(issue.key), issue);

  /** @type {Map<string, string[]>} */
  const childrenMap = new Map();
  /** @type {Set<string>} */
  const hasParent = new Set();

  for (const issue of issues) {
    const parentKey = issue.parent ? String(issue.parent) : null;
    if (parentKey && issueMap.has(parentKey)) {
      hasParent.add(String(issue.key));
      if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
      childrenMap.get(parentKey).push(String(issue.key));
    }
  }

  const rootKeys = issues.filter((i) => !hasParent.has(String(i.key))).map((i) => String(i.key));

  // Build table
  const wrap = document.createElement('div');
  wrap.className = 'data-table-wrap';

  const table = document.createElement('table');
  table.className = 'data-table hierarchy-table';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const col of dash.columns) {
    const th = document.createElement('th');
    const mapping = fieldMappings[col];
    th.textContent = mapping ? mapping.label : col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  function addHierarchyRows(/** @type {string} */ key, /** @type {number} */ depth) {
    const issue = issueMap.get(key);
    if (!issue) return;

    const children = childrenMap.get(key) ?? [];
    const hasChildren = children.length > 0;

    const tr = document.createElement('tr');
    tr.dataset.depth = String(depth);

    for (let i = 0; i < dash.columns.length; i++) {
      const col = dash.columns[i];
      const td = document.createElement('td');

      if (col === 'healthStatus') {
        const badge = document.createElement('span');
        badge.className = `health-badge ${issue.healthStatus}`;
        td.appendChild(badge);
        td.append(String(issue.healthReason ?? ''));
      } else {
        // First column gets indentation and toggle
        if (i === 0) {
          const indent = document.createElement('span');
          indent.style.paddingLeft = `${depth * 1.2}rem`;
          td.appendChild(indent);

          if (hasChildren) {
            const toggle = document.createElement('span');
            toggle.className = 'hierarchy-toggle';
            toggle.textContent = '▾';
            toggle.addEventListener('click', (e) => {
              e.stopPropagation();
              const isCollapsed = toggle.textContent === '▸';
              toggle.textContent = isCollapsed ? '▾' : '▸';
              // Show/hide descendant rows
              let sibling = tr.nextElementSibling;
              while (sibling) {
                const sibDepth = Number(/** @type {HTMLElement} */ (sibling).dataset.depth);
                if (sibDepth <= depth) break;
                /** @type {HTMLElement} */ (sibling).style.display = isCollapsed ? '' : 'none';
                // When expanding, only show immediate children (not collapsed subtrees)
                if (isCollapsed && sibDepth > depth + 1) {
                  /** @type {HTMLElement} */ (sibling).style.display = 'none';
                }
                sibling = sibling.nextElementSibling;
              }
              // Reset child toggles when collapsing
              if (!isCollapsed) {
                let s = tr.nextElementSibling;
                while (s) {
                  const sDepth = Number(/** @type {HTMLElement} */ (s).dataset.depth);
                  if (sDepth <= depth) break;
                  const childToggle = s.querySelector('.hierarchy-toggle');
                  if (childToggle) childToggle.textContent = '▸';
                  s = s.nextElementSibling;
                }
              }
            });
            td.appendChild(toggle);
          } else {
            const spacer = document.createElement('span');
            spacer.style.display = 'inline-block';
            spacer.style.width = '1rem';
            td.appendChild(spacer);
          }

          const text = document.createElement('span');
          text.textContent = formatCellValue(issue[col]);
          td.appendChild(text);
        } else {
          td.textContent = formatCellValue(issue[col]);
        }
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);

    for (const childKey of children) {
      addHierarchyRows(childKey, depth + 1);
    }
  }

  for (const rootKey of rootKeys) {
    addHierarchyRows(rootKey, 0);
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

// ─── Render Helpers ───────────────────────────────────────────────────────────

function addCell(/** @type {HTMLTableRowElement} */ tr, /** @type {string} */ text) {
  const td = document.createElement('td');
  td.textContent = text;
  tr.appendChild(td);
}

function renderMetrics(/** @type {Record<string,unknown>} */ metrics) {
  const div = document.createElement('div');
  div.className = 'rollup-metrics';

  const items = [
    ['Issues', metrics.issueCount],
    ['Estimate', metrics.totalEstimate],
    ['Complete', `${metrics.completionPct}%`],
  ];

  for (const [label, value] of items) {
    const m = document.createElement('div');
    m.className = 'metric';
    const mv = document.createElement('span');
    mv.className = 'metric-value';
    mv.textContent = String(value);
    const ml = document.createElement('span');
    ml.className = 'metric-label';
    ml.textContent = /** @type {string} */ (label);
    m.appendChild(mv);
    m.appendChild(ml);
    div.appendChild(m);
  }

  return div;
}

function renderProgressMetrics(/** @type {Record<string,unknown>} */ metrics) {
  const div = document.createElement('div');
  div.className = 'rollup-metrics';

  const items = [
    ['Issues', metrics.issueCount],
    ['Estimate', metrics.totalEstimate],
    ['Progress', `${metrics.progress}%`],
    ['At Risk', metrics.atRisk],
  ];

  for (const [label, value] of items) {
    const m = document.createElement('div');
    m.className = 'metric';
    const mv = document.createElement('span');
    mv.className = 'metric-value';
    mv.textContent = String(value);
    const ml = document.createElement('span');
    ml.className = 'metric-label';
    ml.textContent = /** @type {string} */ (label);
    m.appendChild(mv);
    m.appendChild(ml);
    div.appendChild(m);
  }

  return div;
}

function renderProgressBar(/** @type {number} */ pct) {
  return `<span class="progress-bar"><span class="progress-bar-fill" style="width:${Math.min(100, pct)}%"></span></span>`;
}

// ─── JSDoc Types (for IDE support in vanilla JS) ──────────────────────────────

/**
 * @typedef {{ id: string, title: string, view: string, baseFilter: string, filterWidgets: string[], columns: string[] }} DashboardDef
 * @typedef {{ path: string, type: string, label: string }} FieldMapping
 */
