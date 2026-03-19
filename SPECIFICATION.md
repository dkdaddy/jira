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
8.  **Rate Limiting:** Implement 100ms delay between API bursts to avoid Atlassian 429 errors.

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
- **Clock Skew:** Subtract 1 minute from `lastSync` when querying to avoid missing issues due to clock differences.

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
    
    allIssues.push(...response.issues);
    
    // Progress logging
    console.log(`Fetched ${allIssues.length}/${response.total} issues`);
    
    // Check if done
    if (startAt + maxResults >= response.total) {
      break;
    }
    
    startAt += maxResults;
    
    // Rate limiting
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
* `GET /api/data`: Streams the combined JSON cache from disk to the browser.
* `GET /api/snapshots`: Lists all available timestamped snapshots.
* `GET /api/snapshots/:timestamp`: Loads data from a specific historical snapshot.
* `GET /api/fields`: Returns field mapping configuration from `field-mappings.yaml`.
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
  "syncDuration": 23.4
}
```

**field-definitions.json schema:**
```json
{
  "fields": [
    {
      "id": "customfield_10016",
      "name": "Story Points",
      "custom": true,
      "schema": {
        "type": "number"
      }
    }
  ],
  "lastUpdated": "2026-03-19T14:30:00.000Z"
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
        "customfield_10016": 5,  // Story points
        "customfield_10001": { "value": "Platform Team" }
      }
    }
    
    // Normalized issue (after mapping)
    {
      "key": "PLAT-123",
      "summary": "Implement caching",
      "storyPoints": 5,
      "team": "Platform Team"
    }
    ```
3.  **Handle Missing Fields:** If a configured field doesn't exist in Jira, log a warning and use `null`.
4.  **Type Coercion:** Apply appropriate type conversions (dates, numbers, nested objects).

**Benefits:**
- UI code uses consistent logical names (`storyPoints`, `team`) instead of cryptic IDs.
- Easy to adapt when Jira custom field IDs change.
- Configuration-driven: no code changes needed for new fields.

### 4.1 Virtual Calculated Fields
Before the data is rendered, the client-side engine must "hydrate" the issues with these computed properties:
* **`daysInStatus`**: Current Date minus the date of the last status change.
* **`scopeCreep`**: Boolean; `true` if `createdDate > sprintStartDate`.
* **`workRatio`**: Calculated as `timeSpent / originalEstimate`.
* **`healthStatus`**: A string (`red`, `yellow`, `green`) based on the Health Rules.

### 4.2 Hierarchy Mapping & Roll-ups
The engine must map issues to two external dimensions and aggregate metrics upward:

#### 4.2.1 The Org Axis (`config/org.yaml`)
Maps individual issues to Team → Department structure:

**Mapping Logic:**
1.  **Issue → Team:** Match using `project_key` or `members` list
    ```yaml
    teams:
      - id: "platform"
        project_keys: ["PLAT", "INFRA"]  # Match by project
        members: ["alice", "bob"]         # Match by assignee
    ```
2.  **Team → Department:** Hierarchical parent relationship defined in YAML
3.  **Orphan Handling:** Issues not matching any team go to "Unassigned" bucket

**Roll-up Aggregations:**
- **Story Points:** Sum all issue story points within team/department
- **Task Count:** Count of issues
- **Completion %:** `(closed issues / total issues) * 100`
- **Health Distribution:** Count of red/yellow/green issues

**Example Output:**
```javascript
{
  department: "Engineering",
  teams: [
    {
      id: "platform",
      name: "Platform",
      metrics: {
        totalPoints: 125,
        completedPoints: 78,
        completionPct: 62.4,
        issueCount: 45,
        healthCounts: { red: 3, yellow: 12, green: 30 }
      }
    }
  ],
  metrics: {  // Rolled up from all teams
    totalPoints: 340,
    completionPct: 58.2
  }
}
```

#### 4.2.2 The Strategic Axis (`config/initiatives.yaml`)
Maps issues to Initiative hierarchy using Epic relationships and labels:

**Mapping Logic:**
1.  **Issue → Epic:** Use Jira's native `parent` relationship or `epicLink` custom field
2.  **Epic → Initiative:** Match epic keys or labels against `initiatives.yaml`:
    ```yaml
    initiatives:
      - id: "cloud-migration"
        mapping:
          epic_keys: ["PLAT-101"]      # Direct epic mapping
          labels: ["cloud-priority"]    # Label-based mapping
          project_keys: ["INFRA"]       # All issues from project
    ```
3.  **Multi-Initiative Assignment:** Issues can belong to multiple initiatives via labels
4.  **Unassigned Handling:** Issues without epic/label go to "No Initiative" view

**Roll-up Aggregations:**
- **Progress:** Weighted by story points: `sum(completed_points) / sum(total_points)`
- **Budget:** Sum of custom `costCenter` field values
- **At Risk:** Count of issues with `healthStatus === 'red'`
- **Timeline:** Earliest `startDate` and latest `targetDate` across all issues

**Example Output:**
```javascript
{
  initiative: "Cloud Migration",
  epics: [
    {
      key: "PLAT-101",
      summary: "Migrate Auth Service",
      metrics: {
        totalPoints: 55,
        completedPoints: 40,
        progress: 72.7,
        issueCount: 12,
        atRisk: 2
      }
    }
  ],
  metrics: {  // Rolled up from all epics
    totalPoints: 220,
    progress: 65.4,
    budget: 850000,
    atRisk: 7
  }
}
```

#### 4.2.3 Cross-Hierarchy Views
The UI can display matrices combining both hierarchies:

**Example: Initiative × Department Heatmap**
```
                Platform  Mobile  Data
Cloud Migration    45%     20%    35%
Mobile Refresh     10%     85%     5%
```

Shows what % of each initiative is owned by which department.

---

## 5. Frontend & UI Requirements

### 5.1 Tabbed Container System
The UI must parse `dashboards.yaml` to generate a dynamic navigation bar. Switching tabs must filter the in-memory dataset instantly without a network request.

### 5.2 The Hierarchical Grid
Issues must be renderable in a "Drill-down" format using native HTML:
```html
<details class="level-1-initiative">
  <summary>Initiative: Mobile Refresh (65%)</summary>
  <details class="level-2-team">
    <summary>Team: iOS Squad (40%)</summary>
    <table></table>
  </details>
</details>
```

### 5.3 Interactive Features
* **Search-as-you-type:** A global input that filters the current view's `issue.key` and `issue.fields.summary`.
* **Multi-Select Widgets:** Dropdowns for Status, Priority, and Team as defined in the YAML.
* **Health Formatting:** Rows where `healthStatus === 'red'` must have a distinct background color.

---

## 6. Configuration Schemas (Examples)

### `config/projects.yaml`
Defines which Jira projects to sync:
```yaml
projects:
  - key: "PLAT"
    name: "Platform Engineering"
  - key: "MOBILE"
    name: "Mobile Apps"
  - key: "DATA"
    name: "Data Platform"
```

### `config/field-mappings.yaml`
Maps logical UI field names to Jira standard and custom fields:
```yaml
field_mappings:
  # Standard fields (no mapping needed, listed for reference)
  key: "key"
  summary: "summary"
  description: "description"
  status: "status.name"
  priority: "priority.name"
  assignee: "assignee.displayName"
  reporter: "reporter.displayName"
  created: "created"
  updated: "updated"
  
  # Custom field mappings (Jira Cloud defaults)
  storyPoints: "customfield_10016"
  sprint: "customfield_10020"
  epicLink: "customfield_10014"
  team: "customfield_10001"
  startDate: "customfield_10015"
  targetDate: "customfield_10017"
  
  # Additional custom fields
  costCenter: "customfield_12345"
  technicalOwner: "customfield_12346"
  
  # Hierarchy roll-up mappings
  orgHierarchy:
    department: "customfield_10001"  # Team field
    division: "project.name"          # Project name as division
  
  initiativeHierarchy:
    initiative: "parent.key"          # Epic/Initiative key
    theme: "customfield_11001"        # Strategic theme custom field
```

### `config/org.yaml`
Defines organizational structure roll-ups:
```yaml
departments:
  - id: "engineering"
    name: "Engineering"
    teams:
      - id: "platform"
        name: "Platform"
        project_keys: ["PLAT", "INFRA"]
        members: ["alice", "bob"]
      - id: "mobile"
        name: "Mobile"
        project_keys: ["MOBILE", "IOS", "ANDROID"]
        members: ["charlie", "diana"]
  
  - id: "product"
    name: "Product"
    teams:
      - id: "growth"
        name: "Growth"
        project_keys: ["GROWTH"]
        members: ["eve", "frank"]

# Roll-up rules
rollup_rules:
  # How to aggregate from issue → team → department
  aggregation:
    storyPoints: "sum"
    taskCount: "count"
    completionPercentage: "weighted_average"
```

### `config/initiatives.yaml`
Defines strategic initiative structure roll-ups:
```yaml
initiatives:
  - id: "cloud-migration"
    title: "2026 Cloud Migration"
    owner: "CTO"
    mapping:
      epic_keys: ["PLAT-101", "INFRA-105"]
      labels: ["cloud-priority"]
    
  - id: "mobile-refresh"
    title: "Mobile App Redesign"
    owner: "VP Product"
    mapping:
      epic_keys: ["MOBILE-200", "MOBILE-201"]
      project_keys: ["MOBILE"]

# Roll-up rules for initiatives
rollup_rules:
  # How to aggregate from task → epic → initiative
  aggregation:
    progress: "weighted_by_story_points"
    budget_consumed: "sum"
    at_risk_count: "count"
```

### `config/dashboards.yaml`
```yaml
dashboards:
  - id: "exec-view"
    title: "Executive Portfolio"
    viewBy: "initiative" # Grouping axis
    columns: ["key", "summary", "status", "health"]
    summaryStats:
      - label: "Total Points"
        calc: "sum"
        field: "storyPoints"
    health_rules:
      - condition: "status == 'Blocked'"
        result: "red"
      - condition: "daysInStatus > 10"
        result: "yellow"
```

---

## 7. Suggested Dashboards to Build
1.  **Executive Portfolio:** Grouped by Initiative. Shows % completion and "target date" vs "estimated completion."
2.  **Squad Health:** Grouped by Team. Shows current sprint velocity, bug count, and stale tickets.
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
1.  **Environment variables:** `JIRA_HOST`, `JIRA_EMAIL`, `JIRA_TOKEN`
    * Alternatively, configure in `config/jira.yaml`:
    ```yaml
    jira:
      host: "https://yourinstance.atlassian.net"
      email: "you@example.com"
      apiToken: "your-api-token"
    ```
2.  **Required config files:** All YAML files in `config/` directory must exist on first run.
3.  **Auto-create directories:** Server creates `cache/` if it doesn't exist.

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
