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
- **Story Points:** Sum all issue story points within team/group/org
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
            totalPoints: 45,
            completedPoints: 28,
            completionPct: 62.2,
            issueCount: 15,
            healthCounts: { red: 1, yellow: 4, green: 10 }
          }
        },
        {
          id: "green",
          name: "Green",
          metrics: {
            totalPoints: 52,
            completedPoints: 40,
            completionPct: 76.9,
            issueCount: 18,
            healthCounts: { red: 0, yellow: 3, green: 15 }
          }
        },
        {
          id: "blue",
          name: "Blue",
          metrics: {
            totalPoints: 38,
            completedPoints: 22,
            completionPct: 57.9,
            issueCount: 12,
            healthCounts: { red: 2, yellow: 2, green: 8 }
          }
        }
      ],
      metrics: {  // Rolled up from UI teams
        totalPoints: 135,
        completedPoints: 90,
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
            totalPoints: 60,
            completedPoints: 45,
            completionPct: 75.0,
            issueCount: 20,
            healthCounts: { red: 1, yellow: 5, green: 14 }
          }
        },
        {
          id: "white",
          name: "White",
          metrics: {
            totalPoints: 72,
            completedPoints: 50,
            completionPct: 69.4,
            issueCount: 25,
            healthCounts: { red: 2, yellow: 6, green: 17 }
          }
        },
        {
          id: "black",
          name: "Black",
          metrics: {
            totalPoints: 55,
            completedPoints: 38,
            completionPct: 69.1,
            issueCount: 18,
            healthCounts: { red: 0, yellow: 4, green: 14 }
          }
        }
      ],
      metrics: {  // Rolled up from Server teams
        totalPoints: 187,
        completedPoints: 133,
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
            totalPoints: 42,
            completedPoints: 30,
            completionPct: 71.4,
            issueCount: 14,
            healthCounts: { red: 1, yellow: 3, green: 10 }
          }
        },
        {
          id: "new-york",
          name: "New York",
          metrics: {
            totalPoints: 48,
            completedPoints: 36,
            completionPct: 75.0,
            issueCount: 16,
            healthCounts: { red: 0, yellow: 2, green: 14 }
          }
        }
      ],
      metrics: {  // Rolled up from Network Connectivity teams
        totalPoints: 90,
        completedPoints: 66,
        completionPct: 73.3,
        issueCount: 30
      }
    }
  ],
  metrics: {  // Rolled up from all groups in Applications org
    totalPoints: 412,
    completedPoints: 289,
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
- **Progress:** Weighted by story points: `sum(completed_points) / sum(total_points)`
- **Budget:** Sum of custom `costCenter` field values
- **At Risk:** Count of issues with `healthStatus === 'red'`
- **Timeline:** Earliest `startDate` and latest `targetDate` across all issues

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
            totalPoints: 85,
            completedPoints: 60,
            progress: 70.6,
            issueCount: 28,
            atRisk: 3,
            budget: 450000
          }
        }
      ],
      metrics: {  // Rolled up from expand Asia initiatives
        totalPoints: 85,
        completedPoints: 60,
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
            totalPoints: 120,
            completedPoints: 85,
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
            totalPoints: 95,
            completedPoints: 72,
            progress: 75.8,
            issueCount: 35,
            atRisk: 2,
            budget: 520000
          }
        }
      ],
      metrics: {  // Rolled up from expand Europe initiatives
        totalPoints: 215,
        completedPoints: 157,
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
        totalPoints: 0,
        completedPoints: 0,
        progress: 0,
        issueCount: 0,
        atRisk: 0,
        budget: 0
      }
    }
  ],
  metrics: {  // Rolled up from all sub-initiatives in Grow Business goal
    totalPoints: 300,
    completedPoints: 217,
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

**Hierarchy Characteristics:**
- **Dynamic Structure:** No YAML configuration required; hierarchy emerges from Jira links
- **Issue Types:** Typically Epic → Story → Task → Subtask, but supports any parent-child combination
- **Cross-Project:** Can span multiple Jira projects if parent links exist

**Roll-up Aggregations:**
- **Story Points:** Sum all descendant story points
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
            totalPoints: 5,
            completedPoints: 5,
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
            totalPoints: 8,
            completedPoints: 3,
            completionPct: 37.5,
            issueCount: 1,
            healthStatus: "yellow"
          }
        }
      ],
      metrics: {  // Rolled up from child tasks
        totalPoints: 13,
        completedPoints: 8,
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
        totalPoints: 21,
        completedPoints: 21,
        completionPct: 100,
        issueCount: 1,
        healthStatus: "green"
      }
    }
  ],
  metrics: {  // Rolled up from all descendants
    totalPoints: 34,
    completedPoints: 29,
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
    fixedFilter: "status!=Done AND status!=Cancelled"
    widgets: ["status", "assignee", "team", "priority"]
    columns: ["key", "summary", "status", "assignee", "priority", "storyPoints", "health"]
    view: "hierarchy"  # hierarchy or flat
    summaryStats: ["count", "sum:storyPoints", "avg:storyPoints"]
  
  - id: "team-health"
    title: "Team Health Dashboard"
    fixedFilter: "type!=Epic"
    widgets: ["status", "sprint"]
    columns: ["key", "summary", "status", "assignee", "storyPoints"]
    view: "flat"
    summaryStats: ["count", "sum:storyPoints"]
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
