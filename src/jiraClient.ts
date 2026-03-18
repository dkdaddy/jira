interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: string;
    status: {
      name: string;
    };
    priority?: {
      name: string;
    };
    assignee?: {
      displayName: string;
      emailAddress: string;
    };
    created: string;
    updated: string;
    issuetype: {
      name: string;
    };
    labels?: string[];
    customfield_10000?: string;
    [key: string]: unknown;
  };
}

interface JiraSearchResults {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
}

export class JiraClient {
  private baseUrl: string;
  private auth: string;

  constructor(jiraUrl: string, email: string, apiToken: string) {
    this.baseUrl = jiraUrl.replace(/\/$/, '');
    const credentials = Buffer.from(`${email}:${apiToken}`).toString('base64');
    this.auth = `Basic ${credentials}`;
  }

  private async request(endpoint: string, options: RequestInit = {}): Promise<unknown> {
    const url = `${this.baseUrl}/rest/api/3${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.auth,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Jira API error ${response.status}: ${errorText}`
      );
    }

    const data = await response.json();
    return data;
  }

  async getProjectIssues(projectKey: string): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let startAt = 0;
    const maxResults = 50;
    const fields = [
      'summary',
      'description',
      'status',
      'priority',
      'assignee',
      'created',
      'updated',
      'issuetype',
      'labels',
    ];

    do {
      const jql = `project = "${projectKey}" ORDER BY updated DESC`;
      try {
        const url = `/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=${fields.join(',')}`;
        const result = (await this.request(url)) as any;

        if (!result.issues || result.issues.length === 0) {
          break;
        }

        issues.push(...result.issues);
        startAt += maxResults;

        const isLast = result.isLast ?? true;
        console.log(
          `Fetched ${issues.length} issues...`
        );

        if (isLast) {
          break;
        }
      } catch (error) {
        console.error(`Error fetching issues at startAt=${startAt}:`, error);
        throw error;
      }
    } while (true);

    return issues;
  }

  async getStatuses(): Promise<Array<{ id: string; name: string }>> {
    const result = (await this.request('/status')) as Array<{
      id: string;
      name: string;
    }>;
    return result;
  }

  async getPriorities(): Promise<Array<{ id: string; name: string }>> {
    const result = (await this.request('/priority')) as Array<{
      id: string;
      name: string;
    }>;
    return result;
  }
}
