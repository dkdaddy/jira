This is the comprehensive **Technical Requirements Document (TRD)** for the Jira Custom Dashboard. It is designed to provide an LLM agent with all the architectural constraints, data schemas, and feature logic required to build the system from scratch.

---

# Specification: Jira Strategic Roll-up Dashboard (JSRD)

## Table of Contents

- [1. Project Vision](#1-project-vision)
- [2. Technical Constraints](#2-technical-constraints)
  - [2.1 Coding Style](#21-coding-style)
- [3. Server-Side Architecture](#3-server-side-architecture-serverts)
  - [3.1 The Sync Engine (Startup Logic)](#31-the-sync-engine-startup-logic)
    - [3.1.1 Incremental Sync Strategy](#311-incremental-sync-strategy)
    - [3.1.2 Pagination Implementation](#312-pagination-implementation)
  - [3.2 The API Endpoints](#32-the-api-endpoints)
  - [3.3 Cache Structure & Metadata](#33-cache-structure--metadata)
- [4. Data Layer & Logic](#4-data-layer--logic)
  - [4.0 Field Mapping & Normalization](#40-field-mapping--normalization)
  - [4.1 Computed Fields (Server-Side)](#41-computed-fields-server-side)
  - [4.2 Hierarchy Mapping & Roll-ups](#42-hierarchy-mapping--roll-ups)
    - [4.2.1 The Org Axis](#421-the-org-axis-configorgyaml)
    - [4.2.2 The Strategic Axis](#422-the-strategic-axis-configinitiativesyaml)
    - [4.2.3 The Parent Link Hierarchy](#423-the-parent-link-hierarchy)
- [5. Frontend & UI Requirements](#5-frontend--ui-requirements)
  - [5.1 Tabbed Container System](#51-tabbed-container-system)
  - [5.2 Interactive Features](#52-interactive-features)
  - [5.3 Client-Side Caching & Performance](#53-client-side-caching--performance)
- [6. Configuration Schemas (Examples)](#6-configuration-schemas-examples)
- [7. Suggested Dashboards to Build](#7-suggested-dashboards-to-build)
- [8. Deployment & Execution](#8-deployment--execution)
  - [8.1 Directory Structure](#81-directory-structure)
  - [8.2 Configuration](#82-configuration)
  - [8.3 Startup Command](#83-startup-command)
  - [8.4 Execution Flow](#84-execution-flow)
  - [8.5 Sync Strategies](#85-sync-strategies)
- [9. Error Handling & Recovery](#9-error-handling--recovery)
  - [9.1 API Error Handling](#91-api-error-handling)
  - [9.2 Data Integrity](#92-data-integrity)
  - [9.3 Configuration Errors](#93-configuration-errors)
- [10. Monitoring & Observability](#10-monitoring--observability)
  - [10.1 Structured Logging](#101-structured-logging)
  - [10.2 Metrics Collection](#102-metrics-collection)
  - [10.3 Health Checks](#103-health-checks)
- [11. Future Enhancements (Optional)](#11-future-enhancements-optional)
  - [11.1 Multi-User Authentication](#111-multi-user-authentication)
  - [11.2 Advanced Export Features](#112-advanced-export-features)

---

## 1. Project Vision
A high-performance, **offline-first** Jira reporting tool that runs as a Node.js service. It bypasses Jira's UI limitations and API latency by caching issues locally and using YAML-based "pivots" to map flat Jira data into Organizational and Strategic hierarchies.

## 2. Technical Constraints
* **Runtime:** Node.js using `tsx` (TypeScript Execute) CLI.
* **Module System:** Pure ES Modules (ESM) for both Server and Client.
* **No Heavy Frameworks:** No React, Vue, or Angular. Use Vanilla JS for the UI.
* **Styling:** Pure CSS with CSS Variables for themes.
* **File Separation:** HTML, CSS, and JavaScript must be in separate files. `public/index.html` must contain only markup — no `<style>` blocks and no inline `<script>` blocks. All styles go in `public/styles.css`; all JavaScript goes in `public/app.js`.
* **Database:** None. The Filesystem (`/cache/*.json`) is the source of truth.
* **Cache Format:** Timestamped JSON files (`cache/YYYY-MM-DD_HH-mm-ss/{project_key}.json`)
* **Field Retrieval:** Fetch ALL available fields from Jira (standard + custom)
* **Configuration Format:** YAML for all configuration files (human-readable, supports comments)
* **Secrets Management:** All credentials stored in `config/jira.yaml` (gitignored); never commit `config/jira.yaml` to version control
* **Scale Limits:** Optimized for up to 10,000 issues
* **Browser Support:** Modern browsers with ES2020+ support (Chrome 90+, Firefox 88+, Safari 14+)

---

## 2.1 Coding Style

* **Readability first:** Code must be written for humans. Prefer clear, descriptive names over brevity. Avoid clever one-liners that obscure intent.
* **Well-structured:** Each file, function, and module has a single, clear responsibility. Keep functions short and focused. Group related logic together.
* **No `any`:** TypeScript's `any` type is forbidden everywhere — server and client. Every value must have an explicit, accurate type. Use `unknown` with a type guard when the shape is genuinely uncertain.
* **Strong typing throughout:** Define explicit interfaces or type aliases for all data shapes — API responses, config objects, normalized issues, roll-up metrics, and UI state. Do not rely on inferred `any` from external libraries; type-assert or wrap them.
* **Error handling — server:** All async operations must be wrapped in `try/catch`. Errors must be logged with context (operation name, relevant IDs) before being re-thrown or handled. Never silently swallow errors.
* **Error handling — UI:** All `fetch` calls must check `response.ok` before parsing JSON. Network and parse errors must be caught and displayed to the user in the UI (e.g., an error banner), never logged-only. The UI must never show a blank page or silently fail.
* **Assertions:** Use assertion functions (or `console.assert` in the UI) to enforce invariants that should never be violated — e.g., that a required config field is present after validation, or that a field mapping resolves to a known type. An assertion failure should throw immediately with a descriptive message rather than propagating corrupted state.

```typescript
// Example: assertion helper (server)
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// Example: strong-typed fetch wrapper (UI)
async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json() as Promise<T>;
}
```

---

## 3. Server-Side Architecture (`server.ts`)

### 3.1 The Sync Engine (Startup Logic)
Upon execution, the server must:
1.  **Connect to Jira:** Establish connection using credentials from `config/jira.yaml`.
2.  **Load Project Configuration:** Read `config/projects.yaml` to get the list of projects to sync.
3.  **Load Metadata:** Read `cache/meta.json` to get the `lastSync` timestamp (ISO 8601 format).
    * If no `meta.json` exists, perform a **full sync** (all historical data).
    * If `meta.json` exists, perform an **incremental sync** (changes since last run).
4.  **Fetch All Fields:** Query `/rest/api/3/field` to retrieve ALL standard and custom field definitions.
    * Cache field metadata in `cache/field-definitions.json` for field mapping.
5.  **Delta Fetch:** Call Jira REST API for issues updated since `lastSync`.
    * *JQL:* `project IN (PROJ1, PROJ2, ...) AND updated >= "${lastSync}"`
    * Request **ALL fields** using `fields=*all` parameter.
6.  **Pagination:** Handle Jira pagination with 100-issue chunks using `startAt` offset.
    * Continue fetching until `startAt + maxResults >= total`.
7.  **File Persistence:** 
    * Create timestamped directory: `cache/YYYY-MM-DD_HH-mm-ss/`
    * Save each project as: `cache/YYYY-MM-DD_HH-mm-ss/{project_key}.json`
    * Update `cache/meta.json` with current timestamp and snapshot location.
8.  **Rate Limiting:** Implement exponential backoff (starting at 100ms) between API bursts to avoid Atlassian 429 errors.
9.  **Error Recovery:** On sync failure, preserve previous snapshot and log error details for manual intervention.

### 3.1.1 Incremental Sync Strategy
The system maintains state across runs to minimize API calls:

**Initial Run (Full Sync):**
- No `meta.json` exists
- Fetch all issues: `project IN (PROJ1, PROJ2, ...) ORDER BY updated DESC`
- Create first timestamped snapshot
- Write `meta.json` with current timestamp

**Subsequent Runs (Incremental Sync):**
- Read `lastSync` from `meta.json`
- Fetch only changed issues: `project IN (...) AND updated >= "${lastSync}"`
- Merge updates into new timestamped snapshot:
  - Load previous snapshot
  - Update changed issues
  - Add new issues
  - Exclude deleted issues (issues no longer returned by Jira are omitted from the new snapshot)
- Write new `meta.json` with updated timestamp

**Handling Edge Cases:**
- **Deleted Issues:** Issues present in the previous snapshot but absent from the current fetch are excluded from the new snapshot entirely and dropped from `/api/data` responses.
- **Field Schema Changes:** Re-fetch field definitions if custom fields have been added/removed.
- **Time Zone Handling:** Always use UTC ISO 8601 format for timestamps.
- **Clock Skew:** Subtract dynamic buffer (max of 60s or 2x last sync duration) from `lastSync` to avoid missing issues.
- **Long-Running Syncs:** If sync exceeds 5 minutes, use overlap buffer of sync_duration * 2 to ensure no missed updates.
- **Eventual Consistency:** Jira's search index may lag; buffer compensates for replication delays.

**Clock Skew Calculation:**
```javascript
const lastSyncDuration = meta.syncDuration || 60; // seconds
const bufferSeconds = Math.max(60, lastSyncDuration * 2);
const safeLastSync = new Date(meta.lastSync.getTime() - bufferSeconds * 1000);
```

**Example JQL:**
```jql
project IN (PLAT, MOBILE, DATA) 
AND updated >= "2026-03-19 14:29:00" 
ORDER BY updated ASC
```

### 3.1.2 Pagination Implementation
Jira Cloud REST API v3 returns a maximum of 100 issues per request:

**API Response Structure:**
```json
{
  "startAt": 0,
  "maxResults": 100,
  "total": 547,
  "issues": [...]
}
```

**Pagination Algorithm:**
```javascript
async function fetchAllIssues(jql) {
  let allIssues = [];
  let startAt = 0;
  const maxResults = 100;
  
  while (true) {
    const response = await jiraClient.searchJira(jql, {
      startAt,
      maxResults,
      fields: "*all"  // Fetch ALL fields
    });
    
    // Edge case: empty result set
    if (response.total === 0) {
      console.log('No issues found matching JQL query');
      return [];
    }
    
    // Edge case: API returned no issues on first page
    if (response.issues.length === 0 && startAt === 0) {
      throw new Error('Jira API returned 0 issues - check JQL syntax and permissions');
    }
    
    allIssues.push(...response.issues);
    
    // Progress logging
    console.log(`Fetched ${allIssues.length}/${response.total} issues`);
    
    // Check if done
    if (startAt + maxResults >= response.total) {
      break;
    }
    
    // Edge case: API changed total mid-pagination (rare but possible)
    if (allIssues.length > response.total) {
      console.warn('Warning: Issue count exceeded total - Jira data changed during sync');
      break;
    }
    
    startAt += maxResults;
    
    // Rate limiting with exponential backoff
    await sleep(100);
  }
  
  return allIssues;
}
```

**Key Points:**
- Always request `fields=*all` to get standard + custom fields
- Implement progress logging for user feedback
- Handle rate limiting between pages
- Store page size in configuration for easy tuning

### 3.2 The API Endpoints

> All `/api/*` endpoints respond with `Content-Type: application/json` unless noted otherwise.

All filtering, searching, and aggregation is done **client-side** against the in-memory dataset loaded from `/api/data`. The server exposes only the endpoints the UI actually needs:

| Method | Path | Description |
|--------|------|--------------|
| `GET` | `/api/config` | Returns merged JSON from `dashboards.yaml`, `org.yaml`, and `initiatives.yaml`. Bootstraps the UI on load. |
| `GET` | `/api/data` | Returns all normalized issues as a flat JSON array. Includes `healthStatus` for every issue. Deleted issues are excluded. |
| `GET` | `/api/fields` | Returns the parsed `field-mappings.yaml` as JSON. Used to resolve `type` and `label` for each field when rendering filter widgets and columns. |
| `GET` | `/api/health` | Returns sync status, cache age, last error (if any), and issue count as JSON. Used by the UI's "Last updated" indicator. |
| `GET` | `/api/export/csv` | Streams a `text/csv` download of the current cached dataset. |
| `GET` | `/api/export/json` | Streams a downloadable JSON file of the current cached dataset. |
| `GET` | `/` | Serves `public/index.html`. |

### 3.3 Cache Structure & Metadata
The cache directory structure:
```
cache/
├── meta.json                          # Metadata about last sync (includes latest snapshot path)
├── field-definitions.json             # All Jira field definitions
├── 2026-03-19_14-30-00/              # Latest timestamped snapshot
│   ├── PLAT.json                      # Project data
│   ├── MOBILE.json
│   └── DATA.json
├── 2026-03-19_08-15-00/              # Previous snapshot
│   ├── PLAT.json
│   ├── MOBILE.json
│   └── DATA.json
```

**meta.json schema:**
```json
{
  "lastSync": "2026-03-19T14:30:00.000Z",
  "latestSnapshot": "2026-03-19_14-30-00",
  "snapshotPath": "cache/2026-03-19_14-30-00",
  "projects": ["PLAT", "MOBILE", "DATA"],
  "issueCount": 1547,
  "syncDuration": 23.4,
  "syncType": "incremental",
  "lastError": null,
  "cacheSize": "12.4MB"
}
```


---

## 4. Data Layer & Logic

### 4.0 Field Mapping & Normalization
The system uses `field-mappings.yaml` to abstract Jira's field complexity:

**Process Flow:**
1.  **Load Field Mappings:** Read `config/field-mappings.yaml` to get field definitions. Each entry maps a logical name to a `path` (dot-notation into `issue.fields`), a `type` (determines UI widget and filter behaviour), and a `label` (column header). Example:
    ```yaml
    team:
      path: "customfield_10001.value"
      type: dropdown
      label: "Team"
    ```
2.  **Validate Mappings (optional):** Cross-reference the mapped field IDs against `cache/field-definitions.json`; log a warning for any mapped field that does not exist in the Jira instance.
3.  **Apply Mappings:** For each raw Jira issue, resolve every entry in the mapping table by walking the dot-notation path into `issue.fields` and writing the result under the logical name:
    ```javascript
    // Raw Jira issue
    {
      "key": "PLAT-123",
      "fields": {
        "summary": "Implement caching",
        "description": "Add Redis caching layer",
        "issuetype": { "name": "Story" },
        "priority": { "name": "High" },
        "customfield_10001": { "value": "Platform Team" },  // Team
        "customfield_10016": 8,  // Estimate
        "customfield_10020": "M",  // T-shirt size
        "customfield_10014": "Platform Modernization",  // Epic name
        "customfield_10025": "Q2 2026",  // Quarter
        "assignee": { "displayName": "Alice" },
        "customfield_10030": { "displayName": "Bob" },  // Eng lead
        "status": { "name": "In Progress" },
        "duedate": "2026-05-15",  // Due date
        "customfield_10040": "2026-04-30",  // Beta date
        "customfield_10015": "2026-03-01"  // Start date
      }
    }
    
    // Normalized issue (after mapping)
    {
      "key": "PLAT-123",
      "summary": "Implement caching",
      "description": "Add Redis caching layer",
      "type": "Story",
      "priority": "High",
      "parent": "PLAT-100",
      "team": "Platform Team",
      "estimate": 8,
      "tShirtSize": "M",
      "epicName": "Platform Modernization",
      "quarter": "Q2 2026",
      "initiative": "Bug fixes",
      "assignee": "Alice",
      "engLead": "Bob",
      "status": "In Progress",
      "healthStatus": "green",
      "dueDate": "2026-05-15",
      "betaDate": "2026-04-30",
      "startDate": "2026-03-01"
    }
    ```
4.  **Handle Missing Fields:** If a configured field doesn't exist in Jira, log a warning and use `null` or configured default.
5.  **Type Coercion:** Apply appropriate type conversions:
    - **Dates:** ISO 8601 strings → Date objects
    - **Numbers:** Parse story points, numeric custom fields
    - **Arrays:** Multi-select fields
    - **Nested Objects:** Extract nested paths like `status.name`, `assignee.displayName`

**Benefits:**
- UI code uses consistent logical names (`estimate`, `team`, `engLead`) instead of cryptic IDs.
- Easy to adapt when Jira custom field IDs change.
- Configuration-driven: no code changes needed for new fields.

### 4.1 Computed Fields (Server-Side)
After field mapping, the server computes `healthStatus` for every issue before writing normalized data to disk. The `healthStatus` property is included in every normalized issue returned by `/api/data`.

* **`healthStatus`**: A string (`red`, `yellow`, `green`) determined by the following rules, evaluated in priority order:

| Priority | Value | Condition |
|----------|-------|-----------|
| 1 | `green` | `status` is in `closedStatuses` (regardless of dates) |
| 2 | `red` | `status` is `"Blocked"` |
| 3 | `red` | `dueDate` is in the past and issue is not closed |
| 4 | `yellow` | `dueDate` is within the next 7 days and issue is not closed |
| 5 | `yellow` | `assignee` is `null` |
| 6 | `green` | All other open issues |

```javascript
function computeHealthStatus(issue, closedStatuses) {
  if (closedStatuses.includes(issue.status)) return 'green';
  if (issue.status === 'Blocked') return 'red';
  const today = new Date();
  const due = issue.dueDate ? new Date(issue.dueDate) : null;
  if (due && due < today) return 'red';
  if (due && (due - today) < 7 * 24 * 60 * 60 * 1000) return 'yellow';
  if (!issue.assignee) return 'yellow';
  return 'green';
}
```

> `closedStatuses` is read from the `closedStatuses` list in `config/jira.yaml`, defaulting to `["Done", "Closed", "Resolved", "Won't Do"]`.

### 4.2 Hierarchy Mapping & Roll-ups
The engine must map issues to two external dimensions and aggregate metrics upward:

#### 4.2.1 The Org Axis (`config/org.yaml`)
Maps individual issues to Team → Group → Org structure:

**Mapping Logic:**
1.  **Issue → Team:** Match the team name to a leaf node in a YAML config file
    ```yaml
    Applications:
      - UI:
          - red
          - green
          - blue
      - Server:
          - pink
          - white
          - black
      - Network Connectivity:
          - London
          - New York
    ```
2.  **Team → Group:** Hierarchical parent relationship defined in YAML
3.  **Group → Org:** Top-level organizational unit
4.  **Orphan Handling:** Issues not matching any team go to "Unassigned" bucket

**Roll-up Aggregations:**
- **Estimate:** Sum all issue estimates within team/group/org
- **Task Count:** Count of issues
- **Completion %:** `(closed issues / total issues) * 100`
- **Health Distribution:** Count of red/yellow/green issues

**Example Output:**
```javascript
{
  org: "Applications",
  groups: [
    {
      id: "ui",
      name: "UI",
      teams: [
        {
          id: "red",
          name: "Red",
          metrics: {
            totalEstimate: 45,
            completedEstimate: 28,
            completionPct: 62.2,
            issueCount: 15,
            healthCounts: { red: 1, yellow: 4, green: 10 }
          }
        },
        {
          id: "green",
          name: "Green",
          metrics: {
            totalEstimate: 52,
            completedEstimate: 40,
            completionPct: 76.9,
            issueCount: 18,
            healthCounts: { red: 0, yellow: 3, green: 15 }
          }
        },
        {
          id: "blue",
          name: "Blue",
          metrics: {
            totalEstimate: 38,
            completedEstimate: 22,
            completionPct: 57.9,
            issueCount: 12,
            healthCounts: { red: 2, yellow: 2, green: 8 }
          }
        }
      ],
      metrics: {  // Rolled up from UI teams
        totalEstimate: 135,
        completedEstimate: 90,
        completionPct: 66.7,
        issueCount: 45
      }
    },
    {
      id: "server",
      name: "Server",
      teams: [
        {
          id: "pink",
          name: "Pink",
          metrics: {
            totalEstimate: 60,
            completedEstimate: 45,
            completionPct: 75.0,
            issueCount: 20,
            healthCounts: { red: 1, yellow: 5, green: 14 }
          }
        },
        {
          id: "white",
          name: "White",
          metrics: {
            totalEstimate: 72,
            completedEstimate: 50,
            completionPct: 69.4,
            issueCount: 25,
            healthCounts: { red: 2, yellow: 6, green: 17 }
          }
        },
        {
          id: "black",
          name: "Black",
          metrics: {
            totalEstimate: 55,
            completedEstimate: 38,
            completionPct: 69.1,
            issueCount: 18,
            healthCounts: { red: 0, yellow: 4, green: 14 }
          }
        }
      ],
      metrics: {  // Rolled up from Server teams
        totalEstimate: 187,
        completedEstimate: 133,
        completionPct: 71.1,
        issueCount: 63
      }
    },
    {
      id: "network-connectivity",
      name: "Network Connectivity",
      teams: [
        {
          id: "london",
          name: "London",
          metrics: {
            totalEstimate: 42,
            completedEstimate: 30,
            completionPct: 71.4,
            issueCount: 14,
            healthCounts: { red: 1, yellow: 3, green: 10 }
          }
        },
        {
          id: "new-york",
          name: "New York",
          metrics: {
            totalEstimate: 48,
            completedEstimate: 36,
            completionPct: 75.0,
            issueCount: 16,
            healthCounts: { red: 0, yellow: 2, green: 14 }
          }
        }
      ],
      metrics: {  // Rolled up from Network Connectivity teams
        totalEstimate: 90,
        completedEstimate: 66,
        completionPct: 73.3,
        issueCount: 30
      }
    }
  ],
  metrics: {  // Rolled up from all groups in Applications org
    totalEstimate: 412,
    completedEstimate: 289,
    completionPct: 70.1,
    issueCount: 138
  }
}
```

#### 4.2.2 The Strategic Axis (`config/initiatives.yaml`)
Maps issues to Initiative → Goal hierarchy using the initiative field:

**Mapping Logic:**
1.  **Issue → Initiative:** Map using the `initiative` custom field value to a leaf node
    ```yaml
    KTLO:
      - Support
      - Bug fixes

    Stability:
      - Logging
      - Telemetry

    Investment:
      - Development
      - Testing
      - QA
    ```
2.  **Initiative → Goal:** The list key is the top-level goal; each list item is a leaf initiative
3.  **Unassigned Handling:** Issues without initiative field go to "No Initiative" view

**Roll-up Aggregations:**
- **Progress:** Weighted by estimate: `sum(completed_estimate) / sum(total_estimate)`
- **Total Estimate:** Sum of `estimate` field values for all issues in the group
- **At Risk:** Count of issues with `healthStatus === 'red'`
- **Timeline:** Earliest `startDate` and latest `dueDate` across all issues

**Example Output:**
```javascript
{
  goal: "KTLO",
  initiatives: [
    {
      id: "support",
      name: "Support",
      metrics: {
        totalEstimate: 40,
        completedEstimate: 28,
        progress: 70.0,
        issueCount: 15,
        atRisk: 2
      }
    },
    {
      id: "bug-fixes",
      name: "Bug fixes",
      metrics: {
        totalEstimate: 25,
        completedEstimate: 18,
        progress: 72.0,
        issueCount: 10,
        atRisk: 1
      }
    }
  ],
  metrics: {  // Rolled up from all initiatives in KTLO goal
    totalEstimate: 65,
    completedEstimate: 46,
    progress: 70.8,
    issueCount: 25,
    atRisk: 3
  }
}
```

#### 4.2.3 The Parent Link Hierarchy
Maps issues using Jira's native parent-child relationships to build a dynamic hierarchy:

**Mapping Logic:**
1.  **Issue → Parent:** Use Jira's `parent` field to establish direct parent-child relationships
2.  **Recursive Traversal:** Walk up the parent chain to find root issues (epics, stories without parents)
3.  **Multi-Level Support:** Automatically builds tree of arbitrary depth (Epic → Story → Task → Subtask)
4.  **Orphan Handling:** Issues without parents appear as root-level nodes
5.  **Cycle Detection:** Detect and break circular parent references; log warnings for data quality issues

**Edge Case Handling:**
```javascript
// Cycle detection algorithm
function detectCycles(issueKey, visited = new Set()) {
  if (visited.has(issueKey)) {
    console.error(`Circular parent reference detected: ${Array.from(visited).join(' → ')} → ${issueKey}`);
    return true;
  }
  visited.add(issueKey);
  const parent = getParent(issueKey);
  if (parent) {
    return detectCycles(parent, visited);
  }
  return false;
}
```

**Hierarchy Characteristics:**
- **Dynamic Structure:** No YAML configuration required; hierarchy emerges from Jira links
- **Issue Types:** Typically Epic → Story → Task → Subtask, but supports any parent-child combination
- **Cross-Project:** Can span multiple Jira projects if parent links exist

**Roll-up Aggregations:**
- **Estimate:** Sum all descendant estimates
- **Task Count:** Count of all descendant issues
- **Completion %:** `(closed descendants / total descendants) * 100`
- **Health Propagation:** Parent inherits worst health status from any child

**Example Output:**
```javascript
{
  key: "PLAT-100",
  summary: "Platform Modernization Epic",
  issueType: "Epic",
  children: [
    {
      key: "PLAT-101",
      summary: "Migrate Auth Service",
      issueType: "Story",
      children: [
        {
          key: "PLAT-102",
          summary: "Update OAuth library",
          issueType: "Task",
          children: [],
          metrics: {
            totalEstimate: 5,
            completedEstimate: 5,
            completionPct: 100,
            issueCount: 1,
            healthStatus: "green"
          }
        },
        {
          key: "PLAT-103",
          summary: "Add SSO support",
          issueType: "Task",
          children: [],
          metrics: {
            totalEstimate: 8,
            completedEstimate: 3,
            completionPct: 37.5,
            issueCount: 1,
            healthStatus: "yellow"
          }
        }
      ],
      metrics: {  // Rolled up from child tasks
        totalEstimate: 13,
        completedEstimate: 8,
        completionPct: 61.5,
        issueCount: 3,
        healthStatus: "yellow"  // Inherited from worst child
      }
    },
    {
      key: "PLAT-110",
      summary: "Upgrade Database",
      issueType: "Story",
      children: [],
      metrics: {
        totalEstimate: 21,
        completedEstimate: 21,
        completionPct: 100,
        issueCount: 1,
        healthStatus: "green"
      }
    }
  ],
  metrics: {  // Rolled up from all descendants
    totalEstimate: 34,
    completedEstimate: 29,
    completionPct: 85.3,
    issueCount: 5,
    healthStatus: "yellow"
  }
}
```

---

## 5. Frontend & UI Requirements

### 5.1 Tabbed Container System
The UI fetches `GET /api/config` on load to get the full dashboard configuration. Each entry in `dashboards.yaml` generates one tab in the navigation bar.

**Per-tab behaviour:**
1. **Base Filter:** The `baseFilter` expression (e.g., `status = "Ideation"`) is applied client-side to the full in-memory dataset before any filter widget is evaluated. An empty string shows all issues.
2. **Filter Widgets:** The `filterWidgets` list specifies which fields render as interactive filter controls above the table. The widget UI is determined by the field's `type` in `field-mappings.yaml`.
3. **Columns:** The `columns` list specifies which fields appear as table columns, in order. Column headers use the field's `label` from `field-mappings.yaml`.
4. **Tab Switching:** Switching tabs applies the new `baseFilter`, rebuilds the filter widget bar, and re-renders columns — all client-side with no network request.


### 5.2 Interactive Features
* **Search-as-you-type:** A global text input that filters by `key` and `summary` across the current tab's base-filtered dataset.
* **Filter Widgets:** Rendered dynamically from the current dashboard's `filterWidgets` list. Widget type is read from `field-mappings.yaml`:

| Type | Widget | Behaviour |
|------|--------|-----------|
| `text` | Text input | Substring match (case-insensitive) |
| `dropdown` | Single-select `<select>` | Exact match; options populated from distinct values in current dataset |
| `multiselect` | Multi-value select | OR-match: issue passes if its value is in the selected set |
| `date` | From / To date inputs | Inclusive date-range filter |
| `number` | Min / Max numeric inputs | Inclusive range filter |

* **Filter Interaction:** All active filters (base filter + search input + filter widgets) are ANDed together.
* **Clear Button:** Resets search input and all filter widgets for the current tab; `baseFilter` remains active.
* **Health Formatting:** Rows where `healthStatus === 'red'` have a red background tint; `'yellow'` have a yellow tint.
* **Export Buttons:** CSV and JSON export for the current fully-filtered view.
* **Refresh Indicator:** Visual timestamp showing cache age (e.g., "Last updated: 2 hours ago").

### 5.3 Client-Side Caching & Performance
**Caching Strategy:**
```javascript
// HTTP caching headers
app.get('/api/data', (req, res) => {
  const etag = generateETag(cacheData);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=300');  // 5 minutes
  
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();  // Not Modified
  }
  
  res.json(cacheData);
});
```

**UI Cache Indicators:**
- Display snapshot timestamp in header: "Data as of: Mar 19, 2026 2:30 PM"
- "Refresh" button forces cache bypass: `fetch('/api/data', { cache: 'reload' })`
- Stale data warning if cache > 24 hours old

---

## 6. Configuration Schemas (Examples)

### `config/jira.yaml`
Jira connection settings and server configuration. **This file is gitignored and must never be committed.**
```yaml
host: "https://yourinstance.atlassian.net"
email: "you@example.com"
apiToken: "your-api-token-here"    # from id.atlassian.com/manage-profile/security/api-tokens
port: 3000                          # HTTP server port
maxResults: 100                     # Issues per API page (Jira max: 100)
closedStatuses:                     # Statuses treated as "done" for healthStatus & completion %
  - Done
  - Closed
  - Resolved
  - "Won't Do"
```

### `config/projects.yaml`
Defines which Jira projects to sync:
```yaml
projects:
  - PLAT
  - MOBILE
  - DATA
```

### `config/field-mappings.yaml`
Maps logical field names to Jira field paths. Each entry has three properties:
- `path` — dot-notation path into `issue.fields` (use `"key"` for the top-level issue key; use `"_computed"` for server-generated synthetic fields)
- `type` — determines the filter widget rendered in the UI (see widget type table in Section 5.2)
- `label` — human-readable column header

```yaml
# Standard fields
key:
  path: "key"
  type: text
  label: "Key"

summary:
  path: "summary"
  type: text
  label: "Summary"

description:
  path: "description"
  type: text
  label: "Description"

type:
  path: "issuetype.name"
  type: dropdown
  label: "Type"

status:
  path: "status.name"
  type: dropdown
  label: "Status"

priority:
  path: "priority.name"
  type: dropdown
  label: "Priority"

assignee:
  path: "assignee.displayName"
  type: dropdown
  label: "Assignee"

parent:
  path: "parent.key"
  type: text
  label: "Parent"

created:
  path: "created"
  type: date
  label: "Created"

updated:
  path: "updated"
  type: date
  label: "Updated"

dueDate:
  path: "duedate"
  type: date
  label: "Due Date"

healthStatus:
  path: "_computed"            # Set by server after normalization; not a Jira field
  type: dropdown
  label: "Health"

# Custom fields (adjust IDs for your Jira instance)
team:
  path: "customfield_10001.value"
  type: dropdown
  label: "Team"

estimate:
  path: "customfield_10016"
  type: number
  label: "Estimate"

tShirtSize:
  path: "customfield_10020"
  type: dropdown
  label: "T-Shirt Size"

epicName:
  path: "customfield_10014"
  type: text
  label: "Epic"

quarter:
  path: "customfield_10025"
  type: dropdown
  label: "Quarter"

engLead:
  path: "customfield_10030.displayName"
  type: dropdown
  label: "Eng Lead"

initiative:
  path: "customfield_10050"    # Verify field ID for your Jira instance
  type: dropdown
  label: "Initiative"

startDate:
  path: "customfield_10015"
  type: date
  label: "Start Date"

betaDate:
  path: "customfield_10040"
  type: date
  label: "Beta Date"
```

### `config/org.yaml`
Defines organizational hierarchy (Org → Group → Team):
```yaml
Applications:
  UI:
    - red
    - green
    - blue
  Server:
    - pink
    - white
    - black
  Network Connectivity:
    - London
    - New York

Infrastructure:
  Cloud:
    - AWS Team
    - Azure Team
  Data:
    - Analytics
    - Data Warehouse
```

### `config/initiatives.yaml`
Defines strategic initiative hierarchy (Goal → Initiative). Top-level keys are goals; each list item is a leaf initiative matched against the issue's `initiative` field.
```yaml
KTLO:
  - Support
  - Bug fixes

Stability:
  - Logging
  - Telemetry

Investment:
  - Development
  - Testing
  - QA
```

### `config/dashboards.yaml`
Each dashboard entry has:
- `id` — unique identifier used in client routing
- `title` — tab label shown in the navigation bar
- `view` — rendering mode: `flat` (table), `org` (team roll-up tree), `initiative` (strategic roll-up tree), `hierarchy` (parent-child tree)
- `baseFilter` — client-side filter expression applied before filter widgets. Supports `=`, `!=`, `IN (...)`, and `AND` to combine conditions. Empty string shows all issues. Examples:
  - Single value: `status = "In Progress"`
  - List match: `status IN ("In Progress", "In Review", "Blocked")`
  - Combined: `status IN ("In Progress", "Blocked") AND team = "Platform"`
  - Multi-field: `quarter = "Q2 2026" AND type IN ("Story", "Task") AND priority != "Low"`
- `filterWidgets` — ordered list of field names (from `field-mappings.yaml`) to render as filter controls
- `columns` — ordered list of field names to display as table columns

```yaml
dashboards:
  - id: "all-issues"
    title: "All Issues"
    view: "flat"
    baseFilter: ""
    filterWidgets:
      - status
      - priority
      - team
      - assignee
      - quarter
    columns:
      - key
      - summary
      - type
      - status
      - priority
      - assignee
      - team
      - estimate
      - dueDate
      - healthStatus

  - id: "ideation"
    title: "Ideation"
    view: "flat"
    baseFilter: "status IN (\"Ideation\", \"Discovery\") AND type IN (\"Story\", \"Epic\")"
    filterWidgets:
      - priority
      - team
      - quarter
      - assignee
    columns:
      - key
      - summary
      - priority
      - team
      - quarter
      - assignee
      - healthStatus

  - id: "by-team"
    title: "By Team"
    view: "org"
    baseFilter: ""
    filterWidgets:
      - status
      - quarter
    columns:
      - team
      - issueCount
      - totalEstimate
      - completionPct
      - healthCounts

  - id: "by-initiative"
    title: "By Initiative"
    view: "initiative"
    baseFilter: ""
    filterWidgets:
      - status
      - quarter
    columns:
      - initiative
      - issueCount
      - totalEstimate
      - progress
      - atRisk

  - id: "hierarchy"
    title: "Parent-Child Hierarchy"
    view: "hierarchy"
    baseFilter: ""
    filterWidgets:
      - status
      - team
      - type
    columns:
      - key
      - summary
      - type
      - status
      - totalEstimate
      - completionPct
      - healthStatus
```

---

## 7. Suggested Dashboards to Build
1.  **Executive Portfolio:** Grouped by Initiative. Shows % completion and "due date" vs "estimated completion."
2.  **Squad Health:** Grouped by Team. Shows current quarter velocity, bug count, and stale tickets.
3.  **Dependency Map:** Filters for "Blocked" tickets. Shows which Team is blocking another Team.

---

## 8. Deployment & Execution

### 8.1 Directory Structure
```
jira-dashboard/
├── config/
│   ├── jira.yaml              # Jira credentials & connection
│   ├── projects.yaml          # List of projects to sync
│   ├── field-mappings.yaml    # Logical field → Jira field mappings
│   ├── org.yaml               # Org hierarchy roll-up rules
│   ├── initiatives.yaml       # Initiative hierarchy roll-up rules
│   └── dashboards.yaml        # Dashboard view definitions
├── cache/
│   ├── meta.json              # Sync metadata
│   ├── field-definitions.json # Jira field schema
│   ├── latest -> ...          # Symlink to latest snapshot
│   └── YYYY-MM-DD_HH-mm-ss/  # Timestamped snapshots
├── public/
│   ├── index.html             # Markup only — no inline styles or scripts
│   ├── styles.css             # All CSS (linked via <link> in index.html)
│   └── app.js                 # All JavaScript (linked via <script src> in index.html)
├── server.ts                  # Main server
└── package.json
```

### 8.2 Configuration

All credentials and connection settings live in `config/jira.yaml`. Add `config/jira.yaml` to `.gitignore` — never commit credentials to version control.

See the `config/jira.yaml` schema in Section 6 for the full structure.

### 8.3 Startup Command
```bash
npx tsx server.ts
```

### 8.4 Execution Flow
1.  **Startup:** Server connects to Jira and performs sync (full or incremental).
2.  **Progress:** Console logs show sync progress (`Fetching PLAT: 100/500 issues...`).
3.  **Completion:** Server starts HTTP listener after sync completes.
4.  **Access:** Browser opens `http://localhost:3000` to view dashboards.
5.  **Refresh:** Restart the server to trigger a new sync (incremental if `cache/meta.json` exists, full if not).

### 8.5 Sync Strategies
- **Full Sync:** Runs when `cache/meta.json` doesn't exist. Downloads entire project history.
- **Incremental Sync:** Runs when `cache/meta.json` exists. Downloads only changed issues.
- **Field Discovery:** Automatic on first run; re-run when `?forceFieldRefresh=true` is detected.

---

## 9. Error Handling & Recovery

### 9.1 API Error Handling

**Rate Limiting (429 errors):**
```javascript
async function fetchWithRetry(url, options, maxRetries = 3) {
  let delay = 100;  // Start with 100ms
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After') || delay / 1000;
        console.warn(`Rate limited. Retrying after ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        delay *= 2;  // Exponential backoff
        continue;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return response;
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
      console.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
      delay *= 2;
    }
  }
}
```

**Network Failures:**
- Preserve previous snapshot on sync failure
- Update `meta.json` with error details:
  ```json
  {
    "lastSync": "2026-03-19T14:30:00Z",
    "lastError": {
      "timestamp": "2026-03-19T16:45:00Z",
      "message": "Network timeout after 30s",
      "type": "NetworkError"
    }
  }
  ```
- Server remains operational with stale data; display warning in UI

### 9.2 Data Integrity

**Cache Corruption Detection:**
```javascript
function validateCacheIntegrity(snapshot) {
  try {
    // Check JSON structure
    if (!snapshot.issues || !Array.isArray(snapshot.issues)) {
      throw new Error('Invalid snapshot structure');
    }
    
    // Validate required fields
    for (const issue of snapshot.issues) {
      if (!issue.key || !issue.fields) {
        throw new Error(`Corrupt issue data: ${JSON.stringify(issue)}`);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Cache validation failed:', error);
    return false;
  }
}
```

**Recovery Actions:**
1. If current snapshot is corrupt → fallback to previous snapshot
2. If all snapshots corrupt → trigger full resync
3. Log all corruption events to `cache/errors.log`

### 9.3 Configuration Errors

**YAML Parse Errors:**
```javascript
try {
  const config = yaml.load(fs.readFileSync('config/dashboards.yaml', 'utf8'));
} catch (error) {
  console.error('Failed to parse dashboards.yaml:', error.message);
  console.error('Check YAML syntax at line', error.mark?.line);
  process.exit(1);  // Fail fast
}
```

**Missing Configuration Fields:**
```javascript
function validateConfig(config) {
  const required = ['host', 'email', 'apiToken'];
  const missing = required.filter(key => !config[key]);

  if (missing.length > 0) {
    console.error('ERROR: Missing required fields in config/jira.yaml:');
    missing.forEach(key => console.error(`  - ${key}`));
    process.exit(1);
  }
}
```

---

## 10. Monitoring & Observability

### 10.1 Structured Logging

**Log Format (JSON):**
```javascript
function log(level, message, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...metadata
  }));
}

// Usage examples
log('info', 'Starting sync', { projects: ['PLAT', 'MOBILE'] });
log('warn', 'Rate limit approaching', { remaining: 10, resetAt: '2026-03-19T15:00:00Z' });
log('error', 'Sync failed', { error: err.message, stack: err.stack });
```

**Log Events to Track:**
- Sync start/completion (duration, issue count)
- API calls (endpoint, duration, status code)
- Cache operations (read, write, validation)
- Configuration changes
- All errors and warnings

### 10.2 Metrics Collection

**Key Metrics:**
```javascript
const metrics = {
  sync: {
    duration: 23.4,        // seconds
    issuesProcessed: 1547,
    apiCalls: 16,
    avgApiLatency: 245,    // ms
    errorsEncountered: 0
  },
  cache: {
    sizeBytes: 12_400_000,
    snapshotCount: 5,
    oldestSnapshot: '2026-03-15_08-00-00'
  },
  api: {
    requestsLast24h: 230,
    avgResponseTime: 312,  // ms
    errorRate: 0.02        // 2%
  }
};
```

**Note:** Metrics are for internal observability (logging/console) only. No `/api/metrics` endpoint is exposed.

### 10.3 Health Checks

**Health Check:**
```javascript
app.get('/api/health', async (req, res) => {
  const health = {
    status: 'healthy',  // healthy, degraded, unhealthy
    timestamp: new Date().toISOString(),
    cache: {
      lastSync: meta.lastSync,
      ageMinutes: (Date.now() - new Date(meta.lastSync)) / 60000,
      issueCount: meta.issueCount,
      sizeBytes: meta.cacheSize
    },
    errors: meta.lastError ? [meta.lastError] : []
  };
  
  // Degrade status if cache is stale
  if (health.cache.ageMinutes > 60) {
    health.status = 'degraded';
    health.warnings = ['Cache is over 1 hour old'];
  }
  
  res.json(health);
});
```

---

## 11. Future Enhancements (Optional)

### 11.1 Multi-User Authentication

**OAuth Integration:**
- Support Jira OAuth 2.0 for multi-user deployments
- Per-user JQL filters (only see tickets you have permission to view)
- Role-based dashboard visibility (exec dashboards for leadership only)

**Session Management:**
- Store user preferences (favorite dashboards, default filters)
- Audit log of who viewed what data

### 11.2 Advanced Export Features

**PDF Report Generation:**
- Generate executive-ready PDF reports with charts
- Schedule automated weekly reports via email
- Template system for custom report layouts

**Data Warehouse Integration:**
- Export to PostgreSQL/MySQL for historical trending
- BigQuery integration for advanced analytics
- Webhook support for real-time event streaming
