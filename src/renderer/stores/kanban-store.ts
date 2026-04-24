import { create } from 'zustand';
import type { KanbanTask, KanbanTaskStatus, TaskManagerTask } from '../../shared/types';
import { useSettingsStore } from './settings-store';
import { useTerminalStore } from './terminal-store';
import { useProjectStore } from './project-store';

export const KANBAN_COLUMN_ORDER: KanbanTaskStatus[] = [
  'todo',
  'in-progress',
  'review',
  'failed',
  'done',
];

export const KANBAN_COLUMN_LABELS: Record<KanbanTaskStatus, string> = {
  'todo': 'To Do',
  'in-progress': 'In Progress',
  'review': 'Review / QC',
  'failed': 'Failed',
  'done': 'Done',
};

export const KANBAN_COLUMN_COLORS: Record<KanbanTaskStatus, string> = {
  'todo': '#94a3b8',         // slate-400
  'in-progress': '#3b82f6',  // blue-500
  'review': '#f59e0b',       // amber-500
  'failed': '#ef4444',       // red-500
  'done': '#22c55e',         // green-500
};

export interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  initials?: string;
  color?: string;
  profilePicture?: string;
}

export interface AutoFixStatusPayload {
  active: boolean;
  running: boolean;
  lastRun: string | null;
  nextRun: string | null;
  intervalMinutes: number;
  maxIterations: number;
}

interface KanbanState {
  tasks: KanbanTask[];
  /** ClickUp tasks that match the backlog criteria but aren't imported yet */
  backlog: TaskManagerTask[];
  backlogLoading: boolean;
  backlogError: string | null;
  members: WorkspaceMember[];
  membersLoading: boolean;
  membersError: string | null;
  loading: boolean;
  error: string | null;
  /** Optimistic status overrides keyed by local kanban task id */
  pendingMoves: Record<string, KanbanTaskStatus>;
  autoFix: AutoFixStatusPayload | null;

  loadTasks: () => Promise<void>;
  loadMembers: () => Promise<void>;
  loadBacklog: () => Promise<void>;
  /** One-shot: import any task-linked terminal that doesn't have a matching KanbanTask yet.
   *  Returns the number of orphans migrated. Safe to call repeatedly — idempotent. */
  migrateOrphanTerminals: () => Promise<number>;
  importTask: (input: {
    clickupTask: TaskManagerTask;
    projectPath: string;
    projectId?: string;
  }) => Promise<KanbanTask | null>;
  moveTask: (taskId: string, to: KanbanTaskStatus) => Promise<void>;
  updateTask: (taskId: string, patch: Partial<KanbanTask>) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  refreshClickupSnapshots: () => Promise<void>;
  setAssigneeFilter: (assigneeId: string) => Promise<void>;
  clearError: () => void;
  refreshAutoFix: () => Promise<void>;
  setAutoFixStatus: (payload: AutoFixStatusPayload) => void;
  requeueTask: (taskId: string) => Promise<void>;
  setTaskAutoMerge: (taskId: string, override: boolean | null) => Promise<void>;
}

function upsertTask(tasks: KanbanTask[], task: KanbanTask): KanbanTask[] {
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx < 0) return [...tasks, task];
  const copy = tasks.slice();
  copy[idx] = task;
  return copy;
}

export const useKanbanStore = create<KanbanState>((set, get) => ({
  tasks: [],
  backlog: [],
  backlogLoading: false,
  backlogError: null,
  members: [],
  membersLoading: false,
  membersError: null,
  loading: false,
  error: null,
  pendingMoves: {},
  autoFix: null,

  loadTasks: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.kanbanList();
      if (result.success) {
        set({ tasks: result.data || [], loading: false });
      } else {
        set({ loading: false, error: result.error || 'Failed to load kanban tasks' });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load kanban tasks' });
    }
  },

  migrateOrphanTerminals: async () => {
    const settings = useSettingsStore.getState().settings;
    if (settings.taskManagerProvider !== 'clickup') return 0;

    const terminals = useTerminalStore.getState().terminals;
    const taskLinkedTerminals = terminals.filter((term) => term.task?.id);
    if (taskLinkedTerminals.length === 0) return 0;

    const projects = useProjectStore.getState().projects;
    let processed = 0;

    await Promise.all(
      taskLinkedTerminals.map(async (term) => {
        const clickupTaskId = term.task!.id;
        try {
          let kanban = get().tasks.find((t) => t.clickupTaskId === clickupTaskId);

          // Orphan → import. Fetch fresh ClickUp snapshot since Terminal.task is slim.
          if (!kanban) {
            const fetched = await window.electronAPI.getTaskManagerTask(clickupTaskId);
            if (!fetched?.success || !fetched.data) return;

            let projectPath = '';
            let projectId: string | undefined;
            const termProject = term.projectId ? projects.find((p) => p.id === term.projectId) : null;
            if (termProject) {
              projectPath = termProject.path;
              projectId = termProject.id;
            } else if (projects.length > 0) {
              const match = term.cwd ? projects.find((p) => term.cwd.startsWith(p.path)) : undefined;
              if (match) {
                projectPath = match.path;
                projectId = match.id;
              } else {
                projectPath = projects[0].path;
                projectId = projects[0].id;
              }
            } else {
              return; // no projects configured
            }

            kanban = (await get().importTask({
              clickupTask: fetched.data,
              projectPath,
              projectId,
            })) || undefined;
            if (!kanban) return;
          }

          // Sync terminal-side state into the KanbanTask when the KanbanTask
          // is missing it. Covers: restored terminals whose session id lives
          // in the saved JSON but never went through the live session event.
          const patch: Partial<typeof kanban> = {};
          if (term.agentSessionId && !kanban.agentSessionId) patch.agentSessionId = term.agentSessionId;
          if (term.agentProvider && !kanban.agentProvider) patch.agentProvider = term.agentProvider;
          if (term.worktreePath && !kanban.worktreePath) patch.worktreePath = term.worktreePath;
          if (term.worktreeBranch && !kanban.worktreeBranch) patch.worktreeBranch = term.worktreeBranch;
          if (term.baseBranch && !kanban.baseBranch) patch.baseBranch = term.baseBranch;

          if (Object.keys(patch).length > 0) {
            await get().updateTask(kanban.id, patch);
          }
          processed++;
        } catch { /* skip failed — will retry next boot */ }
      }),
    );

    return processed;
  },

  loadBacklog: async () => {
    const settings = useSettingsStore.getState().settings;
    if (settings.taskManagerProvider !== 'clickup') {
      set({ backlog: [], backlogError: null });
      return;
    }
    const listId = settings.kanbanBacklogListId || settings.clickupListId;
    if (!listId) {
      set({ backlog: [], backlogError: 'No ClickUp list configured — set Tasks → List in Settings.' });
      return;
    }
    const statuses = (settings.kanbanBacklogStatuses || 'to do, open, backlog, planning, ready')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const assigneeId = settings.kanbanFilterAssigneeId?.trim();

    set({ backlogLoading: true, backlogError: null });
    try {
      const result = await window.electronAPI.searchTaskManagerTasks(
        '',
        {
          statuses,
          assignees: assigneeId ? [assigneeId] : undefined,
          includeClosed: false,
        },
        listId,
        0,
      );
      if (!result.success) {
        set({ backlogLoading: false, backlogError: result.error || 'Failed to load backlog' });
        return;
      }
      set({ backlog: result.data || [], backlogLoading: false });
    } catch (err) {
      set({ backlogLoading: false, backlogError: err instanceof Error ? err.message : 'Failed to load backlog' });
    }
  },

  loadMembers: async () => {
    set({ membersLoading: true, membersError: null });
    try {
      const result = await window.electronAPI.getTaskManagerMembers?.();
      if (!result) {
        set({ membersLoading: false, membersError: 'Members API unavailable — restart the app' });
        return;
      }
      if (result.success && Array.isArray(result.data)) {
        set({ members: result.data, membersLoading: false, membersError: null });
      } else {
        set({ membersLoading: false, membersError: result.error || 'Failed to load members' });
      }
    } catch (err) {
      set({ membersLoading: false, membersError: err instanceof Error ? err.message : 'Failed to load members' });
    }
  },

  importTask: async ({ clickupTask, projectPath, projectId }) => {
    try {
      const input = {
        clickupTaskId: clickupTask.id,
        clickupCustomId: clickupTask.customId,
        clickupName: clickupTask.name,
        clickupStatus: clickupTask.status.name,
        clickupStatusColor: clickupTask.status.color,
        clickupUrl: clickupTask.url,
        clickupAssignees: clickupTask.assignees.map((a) => ({
          id: a.id,
          username: a.username,
          initials: a.initials,
        })),
        clickupPriority: clickupTask.priority,
        clickupTags: clickupTask.tags,
        clickupUpdatedAt: clickupTask.updatedAt,
        projectPath,
        projectId,
      };
      const result = await window.electronAPI.kanbanImport(input);
      if (result.success && result.data) {
        set((state) => ({ tasks: upsertTask(state.tasks, result.data) }));
        return result.data;
      }
      set({ error: result.error || 'Failed to import task' });
      return null;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to import task' });
      return null;
    }
  },

  moveTask: async (taskId: string, to: KanbanTaskStatus) => {
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.kanbanStatus === to) return;

    // Optimistic update
    set((state) => ({ pendingMoves: { ...state.pendingMoves, [taskId]: to } }));

    try {
      const result = await window.electronAPI.kanbanUpdate(taskId, { kanbanStatus: to });
      if (result.success && result.data) {
        set((state) => {
          const { [taskId]: _drop, ...rest } = state.pendingMoves;
          return { tasks: upsertTask(state.tasks, result.data), pendingMoves: rest };
        });
      } else {
        set((state) => {
          const { [taskId]: _drop, ...rest } = state.pendingMoves;
          return { pendingMoves: rest, error: result.error || 'Failed to move task' };
        });
      }
    } catch (err) {
      set((state) => {
        const { [taskId]: _drop, ...rest } = state.pendingMoves;
        return { pendingMoves: rest, error: err instanceof Error ? err.message : 'Failed to move task' };
      });
    }
  },

  updateTask: async (taskId: string, patch: Partial<KanbanTask>) => {
    try {
      const result = await window.electronAPI.kanbanUpdate(taskId, patch);
      if (result.success && result.data) {
        set((state) => ({ tasks: upsertTask(state.tasks, result.data) }));
      } else if (!result.success) {
        set({ error: result.error || 'Failed to update task' });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to update task' });
    }
  },

  deleteTask: async (taskId: string) => {
    try {
      const result = await window.electronAPI.kanbanDelete(taskId);
      if (result.success) {
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== taskId) }));
      } else {
        set({ error: result.error || 'Failed to delete task' });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete task' });
    }
  },

  refreshClickupSnapshots: async () => {
    try {
      const result = await window.electronAPI.kanbanRefreshClickup();
      if (result.success && Array.isArray(result.data)) {
        set({ tasks: result.data });
      }
    } catch { /* non-critical */ }
  },

  setAssigneeFilter: async (assigneeId: string) => {
    await useSettingsStore.getState().updateSettings({ kanbanFilterAssigneeId: assigneeId });
    // No board reload needed — we filter client-side now
  },

  clearError: () => set({ error: null }),

  refreshAutoFix: async () => {
    try {
      const result = await window.electronAPI.autoFixStatus();
      if (result.success && result.data) {
        // Strip the tasks field since per-task state now lives on KanbanTask
        const { tasks: _drop, ...status } = result.data;
        set({ autoFix: status as AutoFixStatusPayload });
      }
    } catch { /* non-critical */ }
  },

  setAutoFixStatus: (payload: AutoFixStatusPayload) => {
    set({ autoFix: payload });
  },

  requeueTask: async (taskId: string) => {
    try {
      const result = await window.electronAPI.autoFixRequeue(taskId);
      if (result.success && result.data) {
        set((state) => ({ tasks: upsertTask(state.tasks, result.data) }));
      } else if (!result.success) {
        set({ error: result.error || 'Failed to re-queue' });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to re-queue' });
    }
  },

  setTaskAutoMerge: async (taskId: string, override: boolean | null) => {
    await get().updateTask(taskId, { autoMergeOverride: override });
  },
}));

/** Install the global kanban event listener — call once from the view. */
export function subscribeKanbanEvents(): () => void {
  const unsub = window.electronAPI.onKanbanEvent?.((event: any) => {
    if (!event) return;
    const store = useKanbanStore.getState();
    switch (event.type) {
      case 'task-created':
      case 'task-updated':
        useKanbanStore.setState({ tasks: upsertTask(store.tasks, event.task) });
        break;
      case 'task-deleted':
        useKanbanStore.setState({ tasks: store.tasks.filter((t) => t.id !== event.id) });
        break;
      case 'refreshed':
        if (Array.isArray(event.tasks)) useKanbanStore.setState({ tasks: event.tasks });
        break;
    }
  });
  return () => unsub?.();
}
