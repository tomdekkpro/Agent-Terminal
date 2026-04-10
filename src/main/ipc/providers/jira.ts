import type { AppSettings, TaskManagerTask, TaskManagerList } from '../../../shared/types';
import type { ITaskManagerProvider, ProviderResult } from './types';

// 30-second cache
const taskCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 30000;

function getBaseUrl(domain: string): string {
  return `https://${domain}.atlassian.net`;
}

function getAuthHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

async function jiraFetch(settings: AppSettings, endpoint: string, options: RequestInit = {}) {
  const { jiraEmail, jiraApiToken, jiraDomain } = settings;
  if (!jiraEmail || !jiraApiToken || !jiraDomain) {
    throw new Error('Jira credentials not configured');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(`${getBaseUrl(jiraDomain)}${endpoint}`, {
    ...options,
    signal: controller.signal,
    headers: {
      Authorization: getAuthHeader(jiraEmail, jiraApiToken),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...options.headers,
    },
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Jira API error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
  }

  return response.json();
}

/** Extract plain text from Jira ADF (Atlassian Document Format) */
function extractJiraADFText(adf: any): string {
  if (!adf || !adf.content) return '';
  const parts: string[] = [];

  function walk(nodes: any[]) {
    for (const node of nodes) {
      if (node.type === 'text' && node.text) {
        parts.push(node.text);
      }
      if (node.content) walk(node.content);
    }
  }

  walk(adf.content);
  return parts.join(' ');
}

/** Map Jira status category color names to hex colors */
function statusCategoryColor(colorName?: string): string {
  switch (colorName) {
    case 'blue-gray': return '#42526e';
    case 'yellow': return '#f5a623';
    case 'green': return '#36b37e';
    case 'medium-gray': return '#6b778c';
    default: return '#6b778c';
  }
}

function normalizeJiraTask(issue: any, domain: string): TaskManagerTask {
  const fields = issue.fields || {};
  const statusColor = statusCategoryColor(fields.status?.statusCategory?.colorName);

  return {
    id: issue.key,
    customId: issue.key,
    name: fields.summary || issue.key,
    description: fields.description ? extractJiraADFText(fields.description) : undefined,
    status: {
      name: fields.status?.name || 'Unknown',
      color: statusColor,
    },
    priority: fields.priority
      ? { name: fields.priority.name, color: '#6b778c' }
      : undefined,
    assignees: fields.assignee
      ? [{
          id: fields.assignee.accountId,
          username: fields.assignee.displayName,
          email: fields.assignee.emailAddress,
        }]
      : [],
    tags: (fields.labels || []).map((label: string) => ({
      name: label,
      bgColor: '#42526e',
      fgColor: '#ffffff',
    })),
    url: `${getBaseUrl(domain)}/browse/${issue.key}`,
    createdAt: fields.created || '',
    updatedAt: fields.updated || '',
    providerTaskId: issue.id,
    provider: 'jira',
  };
}

export class JiraProvider implements ITaskManagerProvider {
  async checkConnection(settings: AppSettings): Promise<ProviderResult<any>> {
    try {
      const data = await jiraFetch(settings, '/rest/api/3/myself');
      return {
        success: true,
        data: { user: data },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  async getLists(settings: AppSettings): Promise<ProviderResult<TaskManagerList[]>> {
    try {
      const cacheKey = `jira-projects`;
      const cached = taskCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return { success: true, data: cached.data };
      }

      const data = await jiraFetch(settings, '/rest/api/3/project/search?maxResults=100&orderBy=name');
      const lists: TaskManagerList[] = (data.values || []).map((p: any) => ({
        id: p.key,
        name: p.name,
      }));

      taskCache.set(cacheKey, { data: lists, timestamp: Date.now() });
      return { success: true, data: lists };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch projects',
      };
    }
  }

  async getTasks(settings: AppSettings, _listId?: string, page: number = 0): Promise<ProviderResult<TaskManagerTask[]>> {
    try {
      const projectKey = settings.jiraProjectKey;
      if (!projectKey) throw new Error('Jira project key not configured');

      const startAt = page * 100;
      const cacheKey = `jira-tasks-${projectKey}-${page}`;
      const cached = taskCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return { success: true, data: cached.data };
      }

      const jql = encodeURIComponent(`project=${projectKey} ORDER BY updated DESC`);
      const data = await jiraFetch(
        settings,
        `/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=100&fields=summary,status,priority,assignee,labels,created,updated,description`,
      );

      const tasks = (data.issues || []).map((i: any) => normalizeJiraTask(i, settings.jiraDomain));
      taskCache.set(cacheKey, { data: tasks, timestamp: Date.now() });
      return { success: true, data: tasks };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch tasks',
      };
    }
  }

  async searchTasks(
    settings: AppSettings,
    query: string,
    filters?: { statuses?: string[]; assignees?: string[]; includeClosed?: boolean },
    _listId?: string,
    page: number = 0,
  ): Promise<ProviderResult<TaskManagerTask[]>> {
    try {
      const projectKey = settings.jiraProjectKey;
      if (!projectKey) throw new Error('Jira project key not configured');

      const startAt = page * 100;
      const jqlParts: string[] = [`project=${projectKey}`];

      if (query.trim()) {
        jqlParts.push(`text~"${query.replace(/"/g, '\\"')}"`);
      }

      if (filters?.statuses?.length) {
        const statusList = filters.statuses.map((s) => `"${s}"`).join(',');
        jqlParts.push(`status IN (${statusList})`);
      }

      if (!filters?.includeClosed) {
        jqlParts.push(`statusCategory != Done`);
      }

      const jql = encodeURIComponent(`${jqlParts.join(' AND ')} ORDER BY updated DESC`);

      const cacheKey = `jira-search-${jql}-${page}`;
      const cached = taskCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return { success: true, data: cached.data };
      }

      const data = await jiraFetch(
        settings,
        `/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=100&fields=summary,status,priority,assignee,labels,created,updated,description`,
      );

      const tasks = (data.issues || []).map((i: any) => normalizeJiraTask(i, settings.jiraDomain));
      taskCache.set(cacheKey, { data: tasks, timestamp: Date.now() });
      return { success: true, data: tasks };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to search tasks',
      };
    }
  }

  async getTask(settings: AppSettings, taskId: string): Promise<ProviderResult<TaskManagerTask>> {
    try {
      const data = await jiraFetch(
        settings,
        `/rest/api/3/issue/${taskId}?fields=summary,status,priority,assignee,labels,created,updated,description`,
      );
      return { success: true, data: normalizeJiraTask(data, settings.jiraDomain) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch task',
      };
    }
  }

  async createTask(settings: AppSettings, _listId: string, taskData: any): Promise<ProviderResult<TaskManagerTask>> {
    try {
      const projectKey = settings.jiraProjectKey;
      if (!projectKey) throw new Error('Jira project key not configured');

      const body: any = {
        fields: {
          project: { key: projectKey },
          summary: taskData.name || taskData.summary,
          issuetype: { name: taskData.issueType || 'Task' },
        },
      };

      if (taskData.description) {
        body.fields.description = {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: taskData.description }] }],
        };
      }

      const data = await jiraFetch(settings, '/rest/api/3/issue', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      // Fetch the created issue to get full fields
      const created = await this.getTask(settings, data.key);
      return created;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task',
      };
    }
  }

  async postComment(settings: AppSettings, taskId: string, comment: string): Promise<ProviderResult<any>> {
    try {
      const body = {
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }],
        },
      };

      const data = await jiraFetch(settings, `/rest/api/3/issue/${taskId}/comment`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to post comment',
      };
    }
  }

  async updateStatus(settings: AppSettings, taskId: string, status: string): Promise<ProviderResult<any>> {
    try {
      // Get available transitions
      const transitions = await jiraFetch(settings, `/rest/api/3/issue/${taskId}/transitions`);
      const match = (transitions.transitions || []).find(
        (t: any) => t.name.toLowerCase() === status.toLowerCase(),
      );

      if (!match) {
        const available = (transitions.transitions || []).map((t: any) => t.name).join(', ');
        throw new Error(`Transition "${status}" not found. Available: ${available}`);
      }

      const data = await jiraFetch(settings, `/rest/api/3/issue/${taskId}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ transition: { id: match.id } }),
      });
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update status',
      };
    }
  }

  async postTimeEntry(
    settings: AppSettings,
    taskId: string,
    startMs: number,
    durationMs: number,
    description?: string,
  ): Promise<ProviderResult<any>> {
    try {
      const body: any = {
        started: new Date(startMs).toISOString().replace('Z', '+0000'),
        timeSpentSeconds: Math.round(durationMs / 1000),
      };
      if (description) body.comment = {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
      };

      const data = await jiraFetch(settings, `/rest/api/3/issue/${taskId}/worklog`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to post time entry',
      };
    }
  }

  async getTimeEntries(settings: AppSettings, taskId: string): Promise<ProviderResult<{ totalMs: number; todayMs: number; entries: any[] }>> {
    try {
      const data = await jiraFetch(settings, `/rest/api/3/issue/${taskId}/worklog`);
      const entries = data.worklogs || [];
      const totalMs = entries.reduce((sum: number, e: any) => sum + (e.timeSpentSeconds || 0) * 1000, 0);

      // Compute today's tracked time
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const todayMs = entries.reduce((sum: number, e: any) => {
        const start = e.started ? new Date(e.started).getTime() : 0;
        const dur = (e.timeSpentSeconds || 0) * 1000;
        if (start >= todayStart) return sum + dur;
        const end = start + dur;
        if (end > todayStart) return sum + (end - todayStart);
        return sum;
      }, 0);

      return { success: true, data: { totalMs, todayMs, entries } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get time entries',
      };
    }
  }
}
