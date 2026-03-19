This is the comprehensive **Technical Requirements Document (TRD)** for your Jira Custom Dashboard. You can save this as `SPECIFICATION.md` in your root directory. It is designed to provide an LLM agent with all the architectural constraints, data schemas, and feature logic required to build the system from scratch.

---

# Specification: Jira Strategic Roll-up Dashboard (JSRD)

## 1. Project Vision
A high-performance, **offline-first** Jira reporting tool that runs as a Node.js service. It bypasses Jira's UI limitations and API latency by caching issues locally and using YAML-based "pivots" to map flat Jira data into Organizational and Strategic hierarchies.

## 2. Technical Constraints
* **Runtime:** Node.js using `tsx` (TypeScript Execute) CLI.
* **Module System:** Pure ES Modules (ESM) for both Server and Client.
* **No Heavy Frameworks:** No React, Vue, or Angular. Use Vanilla JS for the UI.
* **Styling:** Pure CSS with CSS Variables for themes.
* **Database:** None. The Filesystem (`/cache/*.json`) is the source of truth.
* **Cache Format:** Timestamped JSON files (`cache/YYYY-MM-DD_HH-mm-ss/{project_key}.json`)
* **Field Retrieval:** Fetch ALL available fields from Jira (standard + custom)
* **Configuration Format:** YAML for all configuration files (human-readable, supports comments)
* **Secrets Management:** Environment variables for credentials; never commit secrets to YAML files
* **Scale Limits:** Optimized for up to 10,000 issues
* **Browser Support:** Modern browsers with ES2020+ support (Chrome 90+, Firefox 88+, Safari 14+)

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
  - Mark deleted issues (if issue no longer returned)
- Write new `meta.json` with updated timestamp

**Handling Edge Cases:**
- **Deleted Issues:** Compare current fetch with previous snapshot; issues not in current result set but marked deleted in API are flagged.
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
* `GET /api/config`: Merges and returns `dashboards.yaml`, `org.yaml`, and `initiatives.yaml`.
* `GET /api/data`: Streams the combined JSON cache from disk to the browser (paginated for large datasets).
* `GET /api/data?limit=1000&offset=0`: Paginated data endpoint for datasets > 5000 issues.
* `GET /api/snapshots`: Lists all available timestamped snapshots.
* `GET /api/snapshots/:timestamp`: Loads data from a specific historical snapshot.
* `GET /api/fields`: Returns field mapping configuration from `field-mappings.yaml`.
* `GET /api/health`: Returns sync status, cache age, last error (if any).
* `GET /api/health/jira`: Tests Jira connectivity (can we reach the API?).
* `GET /api/export/csv`: Exports current filtered view as CSV.
* `GET /api/export/json`: Exports current filtered view as JSON.
* `GET /`: Serves `public/index.html`.

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
1.  **Load Field Definitions:** Parse `field-definitions.json` to understand all available fields.
2.  **Apply Mappings:** Transform raw Jira issues using `field-mappings.yaml`:
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
      "team": "Platform Team",
      "estimate": 8,
      "tShirtSize": "M",
      "epicName": "Platform Modernization",
      "quarter": "Q2 2026",
      "assignee": "Alice",
      "engLead": "Bob",
      "status": "In Progress",
      "dueDate": "2026-05-15",
      "betaDate": "2026-04-30",
      "startDate": "2026-03-01"
    }
    ```
3.  **Handle Missing Fields:** If a configured field doesn't exist in Jira, log a warning and use `null` or configured default.
4.  **Type Coercion:** Apply appropriate type conversions:
    - **Dates:** ISO 8601 strings → Date objects
    - **Numbers:** Parse story points, numeric custom fields
    - **Arrays:** Multi-select fields
    - **Nested Objects:** Extract nested paths like `status.name`, `assignee.displayName`

**Benefits:**
- UI code uses consistent logical names (`estimate`, `team`, `engLead`) instead of cryptic IDs.
- Easy to adapt when Jira custom field IDs change.
- Configuration-driven: no code changes needed for new fields.

### 4.1 Virtual Calculated Fields
Before the data is rendered, the client-side engine must "hydrate" the issues with these computed properties:
* **`daysInStatus`**: Current Date minus the date of the last status change.
* **`healthStatus`**: A string (`red`, `yellow`, `green`) based on the Health Rules.

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
Maps issues to Initiative → Sub-Initiative → Goal hierarchy using the initiative field:

**Mapping Logic:**
1.  **Issue → Initiative:** Map using the `initiative` custom field value to a leaf node
    ```yaml
    Grow Business:
      - expand Asia:
          - office in Hong Kong
      - expand Europe:
          - office in Paris
          - office in London
      - expand Africa:
          - office in Cassablanca
    ```
2.  **Initiative → Sub-Initiative:** Hierarchical parent relationship defined in YAML
3.  **Sub-Initiative → Goal:** Top-level strategic goal
4.  **Unassigned Handling:** Issues without initiative field go to "No Initiative" view

**Roll-up Aggregations:**
- **Progress:** Weighted by estimate: `sum(completed_estimate) / sum(total_estimate)`
- **Budget:** Sum of custom `costCenter` field values
- **At Risk:** Count of issues with `healthStatus === 'red'`
- **Timeline:** Earliest `startDate` and latest `dueDate` across all issues

**Example Output:**
```javascript
{
  goal: "Grow Business",
  subInitiatives: [
    {
      id: "expand-asia",
      name: "expand Asia",
      initiatives: [
        {
          id: "office-hong-kong",
          name: "office in Hong Kong",
          metrics: {
            totalEstimate: 85,
            completedEstimate: 60,
            progress: 70.6,
            issueCount: 28,
            atRisk: 3,
            budget: 450000
          }
        }
      ],
      metrics: {  // Rolled up from expand Asia initiatives
        totalEstimate: 85,
        completedEstimate: 60,
        progress: 70.6,
        issueCount: 28,
        atRisk: 3,
        budget: 450000
      }
    },
    {
      id: "expand-europe",
      name: "expand Europe",
      initiatives: [
        {
          id: "office-paris",
          name: "office in Paris",
          metrics: {
            totalEstimate: 120,
            completedEstimate: 85,
            progress: 70.8,
            issueCount: 42,
            atRisk: 5,
            budget: 680000
          }
        },
        {
          id: "office-london",
          name: "office in London",
          metrics: {
            totalEstimate: 95,
            completedEstimate: 72,
            progress: 75.8,
            issueCount: 35,
            atRisk: 2,
            budget: 520000
          }
        }
      ],
      metrics: {  // Rolled up from expand Europe initiatives
        totalEstimate: 215,
        completedEstimate: 157,
        progress: 73.0,
        issueCount: 77,
        atRisk: 7,
        budget: 1200000
      }
    },
    {
      id: "expand-africa",
      name: "expand Africa",
      initiatives: [],
      metrics: {
        totalEstimate: 0,
        completedEstimate: 0,
        progress: 0,
        issueCount: 0,
        atRisk: 0,
        budget: 0
      }
    }
  ],
  metrics: {  // Rolled up from all sub-initiatives in Grow Business goal
    totalEstimate: 300,
    completedEstimate: 217,
    progress: 72.3,
    issueCount: 105,
    atRisk: 10,
    budget: 1650000
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
The UI must parse `dashboards.yaml` to generate a dynamic navigation bar. Switching tabs must filter the in-memory dataset instantly without a network request.


### 5.2 Interactive Features
* **Search-as-you-type:** A global input that filters the current view's `issue.key` and `issue.fields.summary`.
* **Multi-Select Widgets:** Dropdowns for Status, Priority, and Team as defined in the YAML.
* **Health Formatting:** Rows where `healthStatus === 'red'` must have a distinct background color.
* **Export Buttons:** CSV and JSON export for current filtered view.
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

### `config/projects.yaml`
Defines which Jira projects to sync:
```yaml
projects:
  - PLAT
  - MOBILE
  - DATA
```

### `config/field-mappings.yaml`
Maps logical UI field names to Jira field paths:
```yaml
# Standard fields
key: "key"
summary: "summary"
description: "description"
type: "issuetype.name"
status: "status.name"
priority: "priority.name"
assignee: "assignee.displayName"
created: "created"
updated: "updated"
dueDate: "duedate"

# Custom fields (adjust IDs for your Jira instance)
team: "customfield_10001.value"
estimate: "customfield_10016"
tShirtSize: "customfield_10020"
epicName: "customfield_10014"
quarter: "customfield_10025"
engLead: "customfield_10030.displayName"
startDate: "customfield_10015"
betaDate: "customfield_10040"
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
Defines strategic initiative hierarchy (Goal → Sub-Initiative → Initiative):
```yaml
Grow Business:
  expand Asia:
    - office in Hong Kong
    - office in Singapore
  expand Europe:
    - office in Paris
    - office in London
  expand Africa:
    - office in Cassablanca

Reduce Costs:
  cloud migration:
    - migrate compute
    - migrate storage
  vendor consolidation:
    - consolidate SaaS tools

Improve Quality:
  test automation:
    - UI test coverage
    - API test coverage
  technical debt:
    - legacy code refactor
```

### `config/dashboards.yaml`
```yaml
dashboards:
  - id: "exec-view"
    title: "Executive Portfolio"
    fixedFilter: "status!=Done AND status!=Cancelled"
    widgets: ["status", "assignee", "team", "priority", "quarter"]
    columns: ["key", "summary", "status", "assignee", "priority", "estimate", "epicName", "quarter", "dueDate", "health"]
    view: "hierarchy"  # hierarchy or flat
    summaryStats: ["count", "sum:estimate", "avg:estimate"]

  - id: "team-health"
    title: "Team Health Dashboard"
    fixedFilter: "type!=Epic"
    widgets: ["status", "quarter", "team"]
    columns: ["key", "summary", "status", "assignee", "team", "estimate", "tShirtSize", "startDate", "dueDate"]
    view: "flat"
    summaryStats: ["count", "sum:estimate"]
  
  - id: "engineering-view"
    title: "Engineering Dashboard"
    fixedFilter: "team IS NOT EMPTY"
    widgets: ["status", "team", "engLead", "priority"]
    columns: ["key", "summary", "type", "status", "assignee", "engLead", "estimate", "betaDate", "dueDate"]
    view: "flat"
    summaryStats: ["count", "sum:estimate", "avg:estimate"]
  
  - id: "all-issues"
    title: "All Issues"
    fixedFilter: ""
    widgets: ["status", "type", "priority", "assignee"]
    columns: ["key", "summary", "type", "status", "assignee", "priority", "estimate", "dueDate"]
    view: "flat"
    summaryStats: ["count", "sum:estimate"]
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
│   ├── index.html             # UI
│   └── app.js                 # Frontend logic
├── server.ts                  # Main server
└── package.json
```

### 8.2 Environment & Configuration

**CRITICAL - Secrets Management:**
NEVER commit credentials to version control. Use environment variables for all secrets.

**Environment variables (REQUIRED):**
```bash
export JIRA_HOST="https://yourinstance.atlassian.net"
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="your-api-token-here"
```

Alternatively, create `.env` file (gitignored):
```bash
JIRA_HOST=https://yourinstance.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=your-token-here
```

### 8.3 Startup Command
```bash
npx tsx server.ts
```

### 8.4 Execution Flow
1.  **Startup:** Server connects to Jira and performs sync (full or incremental).
2.  **Progress:** Console logs show sync progress (`Fetching PLAT: 100/500 issues...`).
3.  **Completion:** Server starts HTTP listener after sync completes.
4.  **Access:** Browser opens `http://localhost:3000` to view dashboards.
5.  **Refresh:** Restart server to trigger new sync, or implement `/api/sync` endpoint for on-demand refresh.

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

**Missing Environment Variables:**
```javascript
function validateEnvironment() {
  const required = ['JIRA_HOST', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('ERROR: Missing required environment variables:');
    missing.forEach(key => console.error(`  - ${key}`));
    console.error('\nSet them in your shell or .env file.');
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

**Export Metrics:**
- `GET /api/metrics` returns JSON metrics
- Optional: Prometheus-format export at `/metrics`

### 10.3 Health Checks

**Comprehensive Health Check:**
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
    jira: null,  // Populated by /api/health/jira
    errors: meta.lastError ? [meta.lastError] : []
  };
  
  // Degrade status if cache is stale
  if (health.cache.ageMinutes > 60) {
    health.status = 'degraded';
    health.warnings = ['Cache is over 1 hour old'];
  }
  
  res.json(health);
});

app.get('/api/health/jira', async (req, res) => {
  try {
    // Test Jira connectivity
    const response = await jiraClient.getServerInfo();
    res.json({
      status: 'connected',
      version: response.version,
      baseUrl: response.baseUrl
    });
  } catch (error) {
    res.status(503).json({
      status: 'disconnected',
      error: error.message
    });
  }
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
