import * as fs from 'fs';
import * as path from 'path';

interface JiraConfig {
  jiraUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
  port: number;
}

const CONFIG_FILE = 'jira-config.json';

export function loadConfig(): JiraConfig {
  const configPath = path.join(process.cwd(), CONFIG_FILE);

  if (!fs.existsSync(configPath)) {
    const defaultConfig: JiraConfig = {
      jiraUrl: 'https://your-instance.atlassian.net',
      email: 'your-email@example.com',
      apiToken: 'your-api-token',
      projectKey: 'PROJ',
      port: 3000,
    };

    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log(`Config file created at ${configPath}`);
    console.log('Please update it with your Jira credentials and run again.');
    process.exit(1);
  }

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent) as JiraConfig;

    // Validate required fields
    const required: (keyof JiraConfig)[] = [
      'jiraUrl',
      'email',
      'apiToken',
      'projectKey',
    ];
    for (const field of required) {
      if (!config[field] || config[field] === `your-${field}`) {
        throw new Error(`Missing or invalid configuration: ${field}`);
      }
    }

    return config;
  } catch (error) {
    console.error('Failed to load config:', error);
    process.exit(1);
  }
}
