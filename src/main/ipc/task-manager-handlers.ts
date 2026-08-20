import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { TaskSearchFilters } from '../../shared/types';
import { getSettings } from './settings-handlers';
import { ClickUpProvider, JiraProvider, type ITaskManagerProvider } from './providers';
import { isLocalTaskId } from '../../shared/utils';

const clickUpProvider = new ClickUpProvider();
const jiraProvider = new JiraProvider();

export function getActiveProvider(): ITaskManagerProvider | null {
  const settings = getSettings();
  switch (settings.taskManagerProvider) {
    case 'clickup': return clickUpProvider;
    case 'jira': return jiraProvider;
    default: return null;
  }
}

export function registerTaskManagerHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.TASK_MANAGER_CHECK_CONNECTION, async () => {
    const provider = getActiveProvider();
    if (!provider) return { success: false, error: 'No task manager configured' };
    return provider.checkConnection(getSettings());
  });

  ipcMain.handle(IPC_CHANNELS.TASK_MANAGER_GET_LISTS, async () => {
    const provider = getActiveProvider();
    if (!provider) return { success: true, data: [] };
    return provider.getLists(getSettings());
  });

  ipcMain.handle(IPC_CHANNELS.TASK_MANAGER_GET_TASKS, async (_event, listId?: string, page?: number) => {
    const provider = getActiveProvider();
    if (!provider) return { success: true, data: [] };
    return provider.getTasks(getSettings(), listId, page);
  });

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_SEARCH_TASKS,
    async (
      _event,
      query: string,
      filters?: TaskSearchFilters,
      listId?: string,
      page?: number,
    ) => {
      const provider = getActiveProvider();
      if (!provider) return { success: true, data: [] };
      return provider.searchTasks(getSettings(), query, filters, listId, page);
    },
  );

  ipcMain.handle(IPC_CHANNELS.TASK_MANAGER_GET_TASK, async (_event, taskId: string) => {
    const provider = getActiveProvider();
    if (!provider) return { success: false, error: 'No task manager configured' };
    // Local-only tasks have no remote counterpart. Forwarding one spends a
    // request to be told 401/OAUTH_027, so refuse it here rather than at the
    // API. Guarded at the boundary so no caller can leak one by omission.
    if (isLocalTaskId(taskId)) {
      return { success: false, error: 'Local task — not backed by the task manager' };
    }
    return provider.getTask(getSettings(), taskId);
  });

  /**
   * Resolve many tasks' current state in as few requests as possible.
   *
   * Exists because the terminal tabs refreshed their status colour with one
   * /task/{id} per task-linked terminal, every 60s. With 110 such terminals
   * that was 110 requests a minute against a 90/min interactive budget and
   * ClickUp's 100/min ceiling — it could not fit, and it crowded out anything
   * the user clicked. The bulk path resolves the same set from a handful of
   * list-scoped queries on the background lane, and shares its store with the
   * Kanban board's refresh so the marginal cost is usually nil.
   *
   * Tasks the bulk read cannot see are simply absent from the result — callers
   * refreshing a display value should leave the old one in place rather than
   * fall back to a per-task read, which is the fan-out this replaces.
   */
  ipcMain.handle(IPC_CHANNELS.TASK_MANAGER_GET_TASK_SNAPSHOTS, async (_event, taskIds: string[]) => {
    const provider = getActiveProvider();
    if (!provider?.getTaskSnapshots) return { success: true, data: {} };
    const ids = [...new Set((taskIds || []).filter((id) => id && !isLocalTaskId(id)))];
    if (ids.length === 0) return { success: true, data: {} };
    return provider.getTaskSnapshots(getSettings(), ids.map((taskId) => ({ taskId })));
  });

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_CREATE_TASK,
    async (_event, listId: string, taskData: any) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      return provider.createTask(getSettings(), listId, taskData);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_POST_COMMENT,
    async (_event, taskId: string, comment: string) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      return provider.postComment(getSettings(), taskId, comment);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_UPDATE_STATUS,
    async (_event, taskId: string, status: string) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      return provider.updateStatus(getSettings(), taskId, status);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_POST_TIME_ENTRY,
    async (_event, taskId: string, startMs: number, durationMs: number, description?: string) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      return provider.postTimeEntry(getSettings(), taskId, startMs, durationMs, description);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_GET_TIME_ENTRIES,
    async (_event, taskId: string) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      return provider.getTimeEntries(getSettings(), taskId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_ADD_TAG,
    async (_event, taskId: string, tagName: string) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      if (!provider.addTag) return { success: false, error: 'Provider does not support tags' };
      return provider.addTag(getSettings(), taskId, tagName);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_REMOVE_TAG,
    async (_event, taskId: string, tagName: string) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      if (!provider.removeTag) return { success: false, error: 'Provider does not support tags' };
      return provider.removeTag(getSettings(), taskId, tagName);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_GET_TASK_STATUSES,
    async (_event, taskId: string) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      if (!provider.getTaskStatuses) return { success: false, error: 'Provider does not support statuses' };
      return provider.getTaskStatuses(getSettings(), taskId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_MANAGER_GET_LIST_STATUSES,
    async (_event, listId: string) => {
      const provider = getActiveProvider();
      if (!provider) return { success: false, error: 'No task manager configured' };
      if (!provider.getListStatuses) return { success: false, error: 'Provider does not support list statuses' };
      return provider.getListStatuses(getSettings(), listId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.TASK_MANAGER_GET_MEMBERS, async () => {
    const provider = getActiveProvider();
    if (!provider) return { success: true, data: [] };
    if (!provider.getWorkspaceMembers) return { success: true, data: [] };
    return provider.getWorkspaceMembers(getSettings());
  });
}
