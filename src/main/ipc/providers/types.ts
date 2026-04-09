import type { AppSettings, TaskManagerTask, TaskManagerList } from '../../../shared/types';

export type ProviderResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface ITaskManagerProvider {
  checkConnection(settings: AppSettings): Promise<ProviderResult<any>>;

  getLists(settings: AppSettings): Promise<ProviderResult<TaskManagerList[]>>;

  getTasks(settings: AppSettings, listId?: string, page?: number): Promise<ProviderResult<TaskManagerTask[]>>;

  searchTasks(
    settings: AppSettings,
    query: string,
    filters?: { statuses?: string[]; assignees?: string[]; includeClosed?: boolean },
    listId?: string,
    page?: number,
  ): Promise<ProviderResult<TaskManagerTask[]>>;

  getTask(settings: AppSettings, taskId: string): Promise<ProviderResult<TaskManagerTask>>;

  createTask(settings: AppSettings, listId: string, data: any): Promise<ProviderResult<TaskManagerTask>>;

  postComment(settings: AppSettings, taskId: string, comment: string): Promise<ProviderResult<any>>;

  updateStatus(settings: AppSettings, taskId: string, status: string): Promise<ProviderResult<any>>;

  postTimeEntry(
    settings: AppSettings,
    taskId: string,
    startMs: number,
    durationMs: number,
    description?: string,
  ): Promise<ProviderResult<any>>;

  getTimeEntries(settings: AppSettings, taskId: string): Promise<ProviderResult<{ totalMs: number; entries: any[] }>>;

  addTag?(settings: AppSettings, taskId: string, tagName: string): Promise<ProviderResult<any>>;

  removeTag?(settings: AppSettings, taskId: string, tagName: string): Promise<ProviderResult<any>>;

  getComments?(settings: AppSettings, taskId: string): Promise<ProviderResult<any[]>>;

  getTaskStatuses?(settings: AppSettings, taskId: string): Promise<ProviderResult<{ name: string; color: string }[]>>;
}
