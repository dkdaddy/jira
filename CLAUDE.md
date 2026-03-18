# Jira Explorer

A Node.js/TypeScript web app that fetches issues from a Jira Cloud project and displays them in a browser UI.

## Architecture

- **`src/config.ts`** — loads `jira-config.json` from the working directory; exits if credentials are missing
- **`src/jiraClient.ts`** — Jira Cloud REST API v3 client; paginates through all issues via `/search/jql`
- **`src/dataStore.ts`** — in-memory store; maps raw Jira fields to a flat `StoredIssue` shape
- **`src/index.ts`** — Express server; fetches data at startup and serves it via REST endpoints
- **`public/index.html`** — single-file frontend (vanilla JS); two tabs: Search and Hierarchy

## Commands

```bash
npm run build   # tsc compile → dist/
npm start       # node dist/index.js  (requires a prior build)
npm run dev     # build + start in one step
```

## Configuration

`jira-config.json` (gitignored) at the project root:

```json
{
  "jiraUrl": "https://your-instance.atlassian.net",
  "email": "you@example.com",
  "apiToken": "your-api-token",
  "projectKey": "PROJ",
  "port": 3000
}
```

Generate an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/issues` | All cached issues |
| GET | `/api/search?q=text&field=all` | Full-text search |
| GET | `/api/status/:status` | Filter by status name |
| GET | `/api/assignee/:name` | Filter by assignee display name |
| GET | `/api/stats` | Counts by status, type, assignee |
| GET | `/api/health` | Last updated timestamp |

## Jira Fields Fetched

| Field | Jira API name |
|-------|---------------|
| Summary, Description, Status, Priority | standard |
| Assignee | standard |
| Issue type | `issuetype` |
| Labels | `labels` |
| Parent | `parent` |
| Start date | `customfield_10015` |
| Team | `customfield_10001` |

> `customfield_10001` / `customfield_10015` IDs are common Jira Cloud defaults. If team or start date appear empty, verify the correct field IDs via `GET /rest/api/3/field`.

## Frontend Tabs

- **Search** — live-filter by text + field selector + status dropdown; Clear button resets all filters
- **Hierarchy** — tree view built client-side from `parent` relationships; Epics at the top, children nested beneath their parent; collapse/expand nodes with the ▾ toggle
