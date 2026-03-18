interface StoredData {
  issues: Array<{
    id: string;
    key: string;
    summary: string;
    description?: string;
    status: string;
    priority?: string;
    assignee?: string;
    created: string;
    updated: string;
    issueType: string;
    labels?: string[];
    parent?: string;
    startDate?: string;
    team?: string;
    colorway?: string;
    storyPoints?: number;
  }>;
  lastUpdated: string;
  totalIssues: number;
}

export class DataStore {
  private data: StoredData = {
    issues: [],
    lastUpdated: '',
    totalIssues: 0,
  };

  storeIssues(
    issues: Array<{
      id: string;
      key: string;
      fields: {
        summary: string;
        description?: string;
        status: { name: string };
        priority?: { name: string };
        assignee?: { displayName: string };
        created: string;
        updated: string;
        issuetype: { name: string };
        labels?: string[];
        parent?: { key: string; fields: { summary: string; issuetype: { name: string } } };
        customfield_10015?: string;
        customfield_10001?: { name: string } | string | null;
        [key: string]: unknown;
      };
    }>,
    colorwayFieldId?: string,
    storyPointsFieldId?: string
  ): void {
    this.data.issues = issues
      .filter((issue) => issue && issue.fields && issue.fields.summary)
      .map((issue) => ({
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary || '(No summary)',
        description: issue.fields.description,
        status: issue.fields.status?.name || 'Unknown',
        priority: issue.fields.priority?.name,
        assignee: issue.fields.assignee?.displayName,
        created: issue.fields.created,
        updated: issue.fields.updated,
        issueType: issue.fields.issuetype?.name || 'Unknown',
        labels: issue.fields.labels,
        parent: issue.fields.parent?.key,
        startDate: issue.fields.customfield_10015 ?? undefined,
        team: typeof issue.fields.customfield_10001 === 'object' && issue.fields.customfield_10001 !== null
          ? (issue.fields.customfield_10001 as { name: string }).name
          : typeof issue.fields.customfield_10001 === 'string'
          ? issue.fields.customfield_10001
          : undefined,
        colorway: colorwayFieldId
          ? (issue.fields[colorwayFieldId] as string | undefined) ?? undefined
          : undefined,
        storyPoints: storyPointsFieldId
          ? (issue.fields[storyPointsFieldId] as number | undefined) ?? undefined
          : undefined,
      }));

    this.data.lastUpdated = new Date().toISOString();
    this.data.totalIssues = this.data.issues.length;

    console.log(`Stored ${this.data.issues.length} issues`);
  }

  getData(): StoredData {
    return this.data;
  }

  search(
    query: string,
    field: string = 'summary'
  ): StoredData['issues'] {
    const lowerQuery = query.toLowerCase();

    return this.data.issues.filter((issue) => {
      let searchText = '';

      if (field === 'all') {
        searchText = `${issue.key} ${issue.summary} ${
          issue.description || ''
        } ${issue.status} ${issue.assignee || ''}`.toLowerCase();
      } else if (field in issue) {
        searchText = String(issue[field as keyof typeof issue]).toLowerCase();
      }

      return searchText.includes(lowerQuery);
    });
  }

  filterByStatus(status: string): StoredData['issues'] {
    return this.data.issues.filter(
      (issue) => issue.status.toLowerCase() === status.toLowerCase()
    );
  }

  filterByAssignee(assignee: string): StoredData['issues'] {
    return this.data.issues.filter(
      (issue) =>
        issue.assignee && issue.assignee.toLowerCase() === assignee.toLowerCase()
    );
  }

  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    byIssueType: Record<string, number>;
    byAssignee: Record<string, number>;
  } {
    const stats = {
      total: this.data.issues.length,
      byStatus: {} as Record<string, number>,
      byIssueType: {} as Record<string, number>,
      byAssignee: {} as Record<string, number>,
    };

    for (const issue of this.data.issues) {
      stats.byStatus[issue.status] =
        (stats.byStatus[issue.status] || 0) + 1;
      stats.byIssueType[issue.issueType] =
        (stats.byIssueType[issue.issueType] || 0) + 1;
      if (issue.assignee) {
        stats.byAssignee[issue.assignee] =
          (stats.byAssignee[issue.assignee] || 0) + 1;
      }
    }

    return stats;
  }
}
