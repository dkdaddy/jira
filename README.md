# Jira Explorer

A lightweight Node.js application to explore and browse your Jira project data with a web interface.

## Features

- 📥 **Automatic data download** - Fetches all issues from your Jira project on startup
- 🔍 **Search & filter** - Search issues by summary, key, or assignee, filter by status
- 📊 **Statistics dashboard** - View overview of issues by status, type, and assignee
- 🌐 **Web interface** - Clean, responsive browser-based UI
- 📝 **Read-only** - Safe read-only access to your Jira data
- ⚡ **Minimal dependencies** - Only Express.js for the server

## Prerequisites

- Node.js 14+ (with npm)
- Jira Cloud account with API access
- Jira API token (generated from account settings)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Generate Jira API Token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Copy the token (you'll need it for configuration)

### 3. Configure the application

Run the app once to generate a config template:

```bash
npm run dev
```

This creates `jira-config.json`. Edit it with your Jira details:

```json
{
  "jiraUrl": "https://your-instance.atlassian.net",
  "email": "your-email@example.com",
  "apiToken": "your-api-token",
  "projectKey": "PROJ",
  "port": 3000
}
```

**Configuration fields:**
- `jiraUrl`: Your Jira Cloud URL (e.g., https://mycompany.atlassian.net)
- `email`: Email associated with your Jira account
- `apiToken`: API token generated from account settings
- `projectKey`: Your Jira project key (e.g., PROJ, MYPROJ)
- `port`: Port to run the server on (default: 3000)

### 4. Run the application

```bash
npm run dev
```

Or build and run:

```bash
npm run build
npm start
```

Open your browser to `http://localhost:3000`

## Usage

### Web Interface

- **Search box**: Search issues across all fields
- **Search field selector**: Choose specific field (summary, key, assignee, or all)
- **Status filter**: Filter issues by status
- **Statistics**: View overview of issues by status, type, and assignee

### API Endpoints

All API endpoints are read-only:

- `GET /api/issues` - Get all issues with metadata
- `GET /api/search?q=text&field=all` - Search issues
  - `q` - search query
  - `field` - search field (all, summary, key, assignee)
- `GET /api/status/:status` - Filter issues by status
- `GET /api/assignee/:assignee` - Filter issues by assignee
- `GET /api/stats` - Get statistics summary
- `GET /api/health` - Server health status

### Example API calls

```bash
# Search for issues with "bug" in summary
curl "http://localhost:3000/api/search?q=bug&field=summary"

# Get all "To Do" issues
curl "http://localhost:3000/api/status/To%20Do"

# Get statistics
curl "http://localhost:3000/api/stats"
```

## Development

Project structure:

```
├── src/
│   ├── index.ts          # Main server
│   ├── config.ts         # Configuration loader
│   ├── jiraClient.ts     # Jira API client
│   └── dataStore.ts      # In-memory data store
├── public/
│   └── index.html        # Web interface
├── package.json
├── tsconfig.json
└── jira-config.json      # Configuration (generated)
```

### Build

```bash
npm run build
```

Compiles TypeScript to `dist/` directory.

### Clean

```bash
npm run clean
```

Removes the `dist/` directory.

## Notes

- All data is stored in-memory while the server runs
- Restart the server to refresh Jira data
- The application only has read-only access to your Jira project
- Large projects may take a few minutes to download on startup

## Limitations

- Data is fetched on startup and cached in memory (no real-time sync)
- No user authentication - runs locally
- Custom fields are not specially handled (only standard fields are displayed)

## Troubleshooting

### Failed to load config

Make sure you've created and properly configured `jira-config.json` with valid credentials.

### Jira API error 401

Check that your API token and email are correct in `jira-config.json`.

### Connection timeout

Verify that:
- Your Jira URL is correct (e.g., `https://mycompany.atlassian.net`)
- Your network can reach Jira
- There's no firewall blocking the connection

### Issues not loading

- Check that the project key is correct in `jira-config.json`
- Verify you have access to the project in Jira
- Check the console output for error messages

## License

MIT
