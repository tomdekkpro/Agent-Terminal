import type { AppSettings, TaskManagerTask, TaskManagerList, TaskSearchFilters } from '../../../shared/types';
import type { ITaskManagerProvider, ProviderResult, WorkspaceMember } from './types';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

// 30-second cache
const taskCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 30000;
const MAX_SEARCH_PAGES = 10;

async function clickUpFetch(apiKey: string, endpoint: string, options: RequestInit = {}) {
  if (!apiKey) throw new Error('ClickUp API key not configured');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const response = await fetch(`${CLICKUP_API_BASE}${endpoint}`, {
    ...options,
    signal: controller.signal,
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  }).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    throw new Error(`ClickUp API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function normalizeClickUpTask(raw: any): TaskManagerTask {
  return {
    id: raw.id,
    customId: raw.custom_id,
    name: raw.name,
    description: raw.text_content || raw.description,
    status: { name: raw.status?.status || '', color: raw.status?.color || '#888' },
    priority: raw.priority
      ? { id: raw.priority.id, name: raw.priority.priority, color: raw.priority.color }
      : undefined,
    assignees: (raw.assignees || []).map((a: any) => ({
      id: String(a.id),
      username: a.username,
      email: a.email,
      initials: a.initials,
    })),
    tags: (raw.tags || []).map((t: any) => ({
      name: t.name,
      bgColor: t.tag_bg,
      fgColor: t.tag_fg,
    })),
    url: raw.url,
    createdAt: raw.date_created,
    updatedAt: raw.date_updated,
    providerTaskId: raw.id,
    provider: 'clickup',
  };
}

export class ClickUpProvider implements ITaskManagerProvider {
  async checkConnection(settings: AppSettings): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, '/user');
      const teams = await clickUpFetch(settings.clickupApiKey, '/team');
      return {
        success: true,
        data: { user: data.user, workspaces: teams.teams },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  private parseManualListIds(settings: AppSettings): TaskManagerList[] {
    if (!settings.clickupListIds) return [];
    return settings.clickupListIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id, name: `List ${id}` }));
  }

  async getLists(settings: AppSettings): Promise<ProviderResult<TaskManagerList[]>> {
    // If manual list IDs are configured, use them directly
    const manualLists = this.parseManualListIds(settings);
    if (manualLists.length > 0) {
      return { success: true, data: manualLists };
    }

    try {
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const cacheKey = `lists-${teamId}`;
      const cached = taskCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return { success: true, data: cached.data };
      }

      const spacesRes = await clickUpFetch(settings.clickupApiKey, `/team/${teamId}/space?archived=false`);
      const lists: TaskManagerList[] = [];

      for (const space of spacesRes.spaces || []) {
        // Folderless lists in this space
        const folderlessRes = await clickUpFetch(settings.clickupApiKey, `/space/${space.id}/list?archived=false`);
        for (const list of folderlessRes.lists || []) {
          lists.push({ id: list.id, name: list.name, space: space.name });
        }

        // Folders → lists
        const foldersRes = await clickUpFetch(settings.clickupApiKey, `/space/${space.id}/folder?archived=false`);
        for (const folder of foldersRes.folders || []) {
          for (const list of folder.lists || []) {
            lists.push({ id: list.id, name: list.name, space: space.name, folder: folder.name });
          }
        }
      }

      taskCache.set(cacheKey, { data: lists, timestamp: Date.now() });
      return { success: true, data: lists };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch lists',
      };
    }
  }

  async getTasks(settings: AppSettings, listId?: string, page: number = 0): Promise<ProviderResult<TaskManagerTask[]>> {
    try {
      const targetListId = listId || settings.clickupListId;
      if (!targetListId) throw new Error('No list ID configured');

      const cacheKey = `tasks-${targetListId}-${page}`;
      const cached = taskCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return { success: true, data: cached.data.map(normalizeClickUpTask) };
      }

      const data = await clickUpFetch(
        settings.clickupApiKey,
        `/list/${targetListId}/task?include_closed=true&subtasks=true&page=${page}`,
      );
      const tasks = data.tasks || [];
      taskCache.set(cacheKey, { data: tasks, timestamp: Date.now() });
      return { success: true, data: tasks.map(normalizeClickUpTask) };
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
    filters?: TaskSearchFilters,
    listId?: string,
    page: number = 0,
  ): Promise<ProviderResult<TaskManagerTask[]>> {
    try {
      const targetListId = listId || settings.clickupListId;
      if (!targetListId) throw new Error('No list ID configured');

      const params = new URLSearchParams();
      params.set('subtasks', 'true');
      params.set('include_closed', filters?.includeClosed ? 'true' : 'false');

      if (filters?.statuses?.length) {
        for (const s of filters.statuses) params.append('statuses[]', s);
      }
      if (filters?.assignees?.length) {
        for (const a of filters.assignees) params.append('assignees[]', a);
      }
      // Server-side ordering so paged fetches return the right subset first.
      // These also become part of the cache key via params.toString().
      if (filters?.orderBy) params.set('order_by', filters.orderBy);
      if (filters?.reverse) params.set('reverse', 'true');

      const hasQuery = !!query.trim();

      // When there's a text query, fetch all pages (ClickUp has no server-side text search).
      // When just browsing/filtering, use single-page pagination.
      if (hasQuery) {
        const allCacheKey = `search-all-${targetListId}-${params.toString()}`;
        const cached = taskCache.get(allCacheKey);
        let allTasks: any[];

        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          allTasks = cached.data;
        } else {
          allTasks = [];
          for (let p = 0; p < MAX_SEARCH_PAGES; p++) {
            const data = await clickUpFetch(
              settings.clickupApiKey,
              `/list/${targetListId}/task?${params.toString()}&page=${p}`,
            );
            const pageTasks = data.tasks || [];
            allTasks.push(...pageTasks);
            if (pageTasks.length === 0) break;
          }
          taskCache.set(allCacheKey, { data: allTasks, timestamp: Date.now() });
        }

        const q = query.toLowerCase();
        const filtered = allTasks.filter(
          (t: any) =>
            t.name?.toLowerCase().includes(q) ||
            t.custom_id?.toLowerCase().includes(q) ||
            t.text_content?.toLowerCase().includes(q) ||
            t.description?.toLowerCase().includes(q),
        );

        return { success: true, data: filtered.map(normalizeClickUpTask) };
      }

      // No text query — single page for infinite scroll
      const cacheKey = `search-${targetListId}-${params.toString()}-${page}`;
      const cached = taskCache.get(cacheKey);
      let tasks: any[];

      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        tasks = cached.data;
      } else {
        const data = await clickUpFetch(
          settings.clickupApiKey,
          `/list/${targetListId}/task?${params.toString()}&page=${page}`,
        );
        tasks = data.tasks || [];
        taskCache.set(cacheKey, { data: tasks, timestamp: Date.now() });
      }

      return { success: true, data: tasks.map(normalizeClickUpTask) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to search tasks',
      };
    }
  }

  async getTask(settings: AppSettings, taskId: string): Promise<ProviderResult<TaskManagerTask>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}`);
      return { success: true, data: normalizeClickUpTask(data) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch task',
      };
    }
  }

  async createTask(settings: AppSettings, listId: string, taskData: any): Promise<ProviderResult<TaskManagerTask>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/list/${listId}/task`, {
        method: 'POST',
        body: JSON.stringify(taskData),
      });
      return { success: true, data: normalizeClickUpTask(data) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task',
      };
    }
  }

  async postComment(settings: AppSettings, taskId: string, comment: string): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}/comment`, {
        method: 'POST',
        body: JSON.stringify({ comment_text: comment }),
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
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
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
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const body: any = { tid: taskId, start: startMs, duration: durationMs };
      if (description) body.description = description;

      const data = await clickUpFetch(settings.clickupApiKey, `/team/${teamId}/time_entries`, {
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

  async addTag(settings: AppSettings, taskId: string, tagName: string): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}/tag/${encodeURIComponent(tagName)}`, {
        method: 'POST',
      });
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add tag',
      };
    }
  }

  async removeTag(settings: AppSettings, taskId: string, tagName: string): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}/tag/${encodeURIComponent(tagName)}`, {
        method: 'DELETE',
      });
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove tag',
      };
    }
  }

  async getComments(settings: AppSettings, taskId: string): Promise<ProviderResult<any[]>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}/comment`);
      return { success: true, data: data.comments || [] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch comments',
      };
    }
  }

  async getTimeEntries(settings: AppSettings, taskId: string): Promise<ProviderResult<{ totalMs: number; todayMs: number; entries: any[] }>> {
    try {
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const data = await clickUpFetch(settings.clickupApiKey, `/team/${teamId}/time_entries?task_id=${taskId}`);
      const entries = data.data || [];
      const totalMs = entries.reduce((sum: number, e: any) => sum + Number(e.duration || 0), 0);

      // Compute today's tracked time
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const todayMs = entries.reduce((sum: number, e: any) => {
        const start = Number(e.start || 0);
        const dur = Number(e.duration || 0);
        if (start >= todayStart) return sum + dur;
        // Entry started before today but may overlap into today
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

  async getTaskStatuses(settings: AppSettings, taskId: string): Promise<ProviderResult<{ name: string; color: string }[]>> {
    try {
      // Fetch the task to get its list.id, then fetch that list for statuses
      const task = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}`);
      const listId = task.list?.id;
      if (!listId) throw new Error('Could not determine task list');

      const list = await clickUpFetch(settings.clickupApiKey, `/list/${listId}`);
      const statuses: { name: string; color: string }[] = (list.statuses || []).map((s: any) => ({
        name: s.status as string,
        color: (s.color as string) || '#999',
      }));
      return { success: true, data: statuses };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get statuses',
      };
    }
  }

  async getWorkspaceMembers(settings: AppSettings): Promise<ProviderResult<WorkspaceMember[]>> {
    try {
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const cacheKey = `members-${teamId}`;
      const cached = taskCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return { success: true, data: cached.data };
      }

      const data = await clickUpFetch(settings.clickupApiKey, `/team/${teamId}`);
      const members: WorkspaceMember[] = (data.team?.members || []).map((m: any) => {
        const user = m.user || {};
        return {
          id: String(user.id),
          username: user.username || user.email || 'Unknown',
          email: user.email,
          initials: user.initials,
          color: user.color,
          profilePicture: user.profilePicture,
        };
      });

      // De-duplicate by id (some ClickUp workspaces return duplicates across groups)
      const seen = new Set<string>();
      const unique = members.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      // Sort alphabetically by username for stable dropdowns
      unique.sort((a, b) => a.username.localeCompare(b.username));

      taskCache.set(cacheKey, { data: unique, timestamp: Date.now() });
      return { success: true, data: unique };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch workspace members',
      };
    }
  }

  async getListStatuses(settings: AppSettings, listId: string): Promise<ProviderResult<{ name: string; color: string }[]>> {
    try {
      if (!listId) throw new Error('List ID is required');

      const cacheKey = `list-statuses-${listId}`;
      const cached = taskCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return { success: true, data: cached.data };
      }

      const list = await clickUpFetch(settings.clickupApiKey, `/list/${listId}`);
      const statuses: { name: string; color: string }[] = (list.statuses || []).map((s: any) => ({
        name: s.status as string,
        color: (s.color as string) || '#999',
      }));
      taskCache.set(cacheKey, { data: statuses, timestamp: Date.now() });
      return { success: true, data: statuses };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get list statuses',
      };
    }
  }
}
