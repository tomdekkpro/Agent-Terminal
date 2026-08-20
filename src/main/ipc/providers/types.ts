import type { AppSettings, TaskManagerTask, TaskManagerList, TaskSearchFilters } from '../../../shared/types';

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
    filters?: TaskSearchFilters,
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

  getTimeEntries(settings: AppSettings, taskId: string): Promise<ProviderResult<{ totalMs: number; todayMs: number; entries: any[] }>>;

  addTag?(settings: AppSettings, taskId: string, tagName: string): Promise<ProviderResult<any>>;

  removeTag?(settings: AppSettings, taskId: string, tagName: string): Promise<ProviderResult<any>>;

  getComments?(settings: AppSettings, taskId: string): Promise<ProviderResult<any[]>>;

  getTaskStatuses?(settings: AppSettings, taskId: string): Promise<ProviderResult<{ name: string; color: string }[]>>;

  getListStatuses?(settings: AppSettings, listId: string): Promise<ProviderResult<{ name: string; color: string }[]>>;

  getWorkspaceMembers?(settings: AppSettings): Promise<ProviderResult<WorkspaceMember[]>>;

  /** Resolve many tasks in as few requests as possible, keyed by task id.
   *  Tasks the bulk read cannot see are simply absent from the result. */
  getTaskSnapshots?(
    settings: AppSettings,
    refs: Array<{ taskId: string; listId?: string }>,
  ): Promise<ProviderResult<Record<string, TaskManagerTask>>>;
}

export interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  initials?: string;
  color?: string;
  profilePicture?: string;
}
