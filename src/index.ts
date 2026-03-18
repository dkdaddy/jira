import express, { Request, Response } from 'express';
import { loadConfig } from './config';
import { JiraClient } from './jiraClient';
import { DataStore } from './dataStore';

const app = express();
let dataStore: DataStore;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API Routes
app.get('/api/issues', (req: Request, res: Response) => {
  const data = dataStore.getData();
  res.json(data);
});

app.get('/api/search', (req: Request, res: Response) => {
  const query = (req.query.q as string) || '';
  const field = (req.query.field as string) || 'all';

  if (!query) {
    res.json(dataStore.getData().issues);
    return;
  }

  const results = dataStore.search(query, field);
  res.json({
    query,
    field,
    results,
    count: results.length,
  });
});

app.get('/api/status/:status', (req: Request, res: Response) => {
  const { status } = req.params;
  const results = dataStore.filterByStatus(status);
  res.json({
    status,
    results,
    count: results.length,
  });
});

app.get('/api/assignee/:assignee', (req: Request, res: Response) => {
  const { assignee } = req.params;
  const results = dataStore.filterByAssignee(decodeURIComponent(assignee));
  res.json({
    assignee,
    results,
    count: results.length,
  });
});

app.get('/api/stats', (req: Request, res: Response) => {
  const stats = dataStore.getStats();
  res.json(stats);
});

app.get('/api/health', (req: Request, res: Response) => {
  const data = dataStore.getData();
  res.json({
    status: 'ok',
    lastUpdated: data.lastUpdated,
    totalIssues: data.totalIssues,
  });
});

app.post('/api/refresh', async (req: Request, res: Response) => {
  try {
    await initializeData();
    const data = dataStore.getData();
    res.json({ status: 'ok', lastUpdated: data.lastUpdated, totalIssues: data.totalIssues });
  } catch (error) {
    res.status(500).json({ status: 'error', message: String(error) });
  }
});

async function initializeData(): Promise<void> {
  try {
    const config = loadConfig();
    console.log(`Connecting to Jira: ${config.jiraUrl}`);

    const jiraClient = new JiraClient(config.jiraUrl, config.email, config.apiToken);

    // Discover custom field IDs
    const allFields = await jiraClient.getFields();
    const colorwayField = allFields.find(
      (f) => f.name.toLowerCase() === 'colorway'
    );
    const colorwayFieldId = colorwayField?.id;
    if (colorwayFieldId) {
      console.log(`Found colorway field: ${colorwayFieldId}`);
    } else {
      console.log('colorway field not found in this project');
    }

    const storyPointsField = allFields.find(
      (f) => f.name.toLowerCase() === 'story points' || f.name.toLowerCase() === 'story point estimate'
    );
    const storyPointsFieldId = storyPointsField?.id ?? 'customfield_10016';
    console.log(`Using story points field: ${storyPointsFieldId} (${storyPointsField?.name ?? 'default'})`);

    console.log(`Fetching issues from project: ${config.projectKey}`);
    const extraFields = [storyPointsFieldId];
    if (colorwayFieldId) extraFields.push(colorwayFieldId);
    const issues = await jiraClient.getProjectIssues(config.projectKey, extraFields);

    dataStore.storeIssues(issues, colorwayFieldId, storyPointsFieldId);
    console.log('Data loaded successfully');
  } catch (error) {
    console.error('Failed to initialize data:', error);
    throw error;
  }
}

async function start(): Promise<void> {
  dataStore = new DataStore();

  try {
    await initializeData();

    const config = loadConfig();
    const port = config.port || 3000;

    app.listen(port, () => {
      console.log(`\n✓ Jira Explorer running at http://localhost:${port}`);
      console.log(`\nAPI endpoints:`);
      console.log(`  GET /api/issues          - All issues`);
      console.log(`  GET /api/search?q=text   - Search issues`);
      console.log(`  GET /api/status/:status  - Filter by status`);
      console.log(`  GET /api/assignee/:name  - Filter by assignee`);
      console.log(`  GET /api/stats           - Statistics`);
      console.log(`  GET /api/health          - Server health`);
      console.log();
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
