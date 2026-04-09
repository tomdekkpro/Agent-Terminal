import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { getSettings } from './settings-handlers';
import { ClickUpProvider, JiraProvider, type ITaskManagerProvider } from './providers';

const clickUpProvider = new ClickUpProvider();
const jiraProvider = new JiraProvider();

function getActiveProvider(): ITaskManagerProvider | null {
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
      filters?: { statuses?: string[]; assignees?: string[]; includeClosed?: boolean },
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
    return provider.getTask(getSettings(), taskId);
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
}
