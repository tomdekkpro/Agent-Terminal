import { create } from 'zustand';
import type { KanbanTask, KanbanTaskStatus, TaskManagerTask, TaskSearchFilters } from '../../shared/types';
import { BACKLOG_SORT_API_PARAMS } from '../../shared/types';
import { useSettingsStore } from './settings-store';
import { useTerminalStore } from './terminal-store';
import { useProjectStore } from './project-store';

/** A single Auto Code orchestrator progress line, buffered per task so the
 *  task detail modal can show "what's happening" live while a headless run is
 *  in flight (the run isn't a viewable PTY). */
export interface AutoCodeLogEntry {
  at: number;
  message: string;
  level: 'info' | 'warn' | 'error';
}

/** Keep the per-task log bounded — these are progress breadcrumbs, not a full
 *  transcript (the agent's real output lands in its resumable session). */
const AUTO_CODE_LOG_CAP = 200;

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

export interface AutoCodeStatusPayload {
  active: boolean;
  running: boolean;
  lastRun: string | null;
  nextRun: string | null;
  intervalMinutes: number;
  maxIterations: number;
}

/** A ClickUp status that becomes a board column, in ClickUp's own order. */
export interface BoardStatus {
  name: string;
  color: string;
}

interface KanbanState {
  tasks: KanbanTask[];
  /** ClickUp statuses for the configured kanban list — the board's columns,
   *  in ClickUp's own order. Empty until loaded (or when provider isn't ClickUp). */
  statuses: BoardStatus[];
  /** ClickUp tasks that match the backlog criteria but aren't imported yet */
  backlog: TaskManagerTask[];
  backlogLoading: boolean;
  /** True while an append-fetch (infinite scroll) is in flight. Kept separate
   *  from backlogLoading so the new-task notification diff isn't disturbed. */
  backlogLoadingMore: boolean;
  backlogError: string | null;
  /** Last backlog page fetched (0-based). */
  backlogPage: number;
  /** True when the last fetched page was full — more pages likely exist. */
  backlogHasMore: boolean;
  members: WorkspaceMember[];
  membersLoading: boolean;
  membersError: string | null;
  loading: boolean;
  error: string | null;
  /** Optimistic status overrides keyed by local kanban task id. The value is
   *  the target ClickUp status NAME (1-1 with the board columns). */
  pendingMoves: Record<string, string>;
  autoCode: AutoCodeStatusPayload | null;
  /** Auto Code progress lines keyed by local kanban task id. Populated from the
   *  orchestrator's `log` events so the detail modal can stream progress for a
   *  task that's actively coding. */
  autoCodeLogs: Record<string, AutoCodeLogEntry[]>;

  loadTasks: () => Promise<void>;
  /** Fetch the configured kanban list's ClickUp statuses → board columns. */
  loadStatuses: () => Promise<void>;
  loadMembers: () => Promise<void>;
  /** Load the backlog from the provider. Re-fetches every page the user has
   *  already scrolled through (so the 60s poll doesn't collapse a lazily-grown
   *  list); pass `reset: true` (sort/assignee change) to start over at page 0. */
  loadBacklog: (opts?: { reset?: boolean }) => Promise<void>;
  /** Fetch the next backlog page and append (infinite scroll). */
  loadMoreBacklog: () => Promise<void>;
  /** One-shot: import any task-linked terminal that doesn't have a matching KanbanTask yet.
   *  Returns the number of orphans migrated. Safe to call repeatedly — idempotent. */
  migrateOrphanTerminals: () => Promise<number>;
  importTask: (input: {
    clickupTask: TaskManagerTask;
    projectPath: string;
    projectId?: string;
    baseBranch?: string;
    useWorktree?: boolean;
  }) => Promise<KanbanTask | null>;
  /** Create a local-only task (no ClickUp link). */
  createLocalTask: (input: {
    name: string;
    description?: string;
    projectPath: string;
    projectId?: string;
    kanbanStatus?: KanbanTaskStatus;
    baseBranch?: string;
    useWorktree?: boolean;
  }) => Promise<KanbanTask | null>;
  /** Convert a local kanban task into a ClickUp-linked one by attaching a
   *  ClickUp task the user picked. Preserves the local workflow state
   *  (column, worktree, session, auto-code counters). */
  linkLocalToClickup: (localId: string, clickupTask: TaskManagerTask) => Promise<KanbanTask | null>;
  /** Move a task to a different column. If `orderIndex` is supplied, the
   *  task lands at that position; otherwise the main side bumps it to the
   *  bottom of the destination column. Same-column reorders also use this
   *  by passing the same status with a new `orderIndex`. */
  moveTask: (taskId: string, to: string, orderIndex?: number) => Promise<void>;
  updateTask: (taskId: string, patch: Partial<KanbanTask>) => Promise<void>;
  /** Clear worktree fields on the KanbanTask whose clickupTaskId matches.
   *  Called after a successful merge / PR flow that removed the worktree,
   *  so reopening the task from the board doesn't think a worktree still
   *  exists at the now-deleted path. No-op if no matching task. */
  clearWorktreeForClickupId: (clickupTaskId: string) => Promise<void>;
  /** Mark a task as merged into local: clears the worktree pointer, flips
   *  `useWorktree` to false so the next reopen runs against the project's
   *  current branch, and drops the agent session hooks since the work is
   *  done. No-op if no matching task. */
  markTaskMergedLocally: (clickupTaskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  refreshClickupSnapshots: () => Promise<void>;
  setAssigneeFilter: (assigneeId: string) => Promise<void>;
  setProjectFilter: (projectId: string) => Promise<void>;
  clearError: () => void;
  refreshAutoCode: () => Promise<void>;
  setAutoCodeStatus: (payload: AutoCodeStatusPayload) => void;
  requeueTask: (taskId: string) => Promise<void>;
  runTaskNow: (taskId: string) => Promise<void>;
  setTaskAutoMerge: (taskId: string, override: boolean | null) => Promise<void>;
  /** Append an orchestrator progress line for a task (called from the global
   *  Auto Code event subscription). */
  appendAutoCodeLog: (taskId: string, entry: AutoCodeLogEntry) => void;
  /** Drop the buffered progress lines for a task (e.g. when a fresh run starts). */
  clearAutoCodeLog: (taskId: string) => void;
}

function upsertTask(tasks: KanbanTask[], task: KanbanTask): KanbanTask[] {
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx < 0) return [...tasks, task];
  const copy = tasks.slice();
  copy[idx] = task;
  return copy;
}

/** ClickUp returns fixed 100-task pages; a short page means we hit the end. */
const BACKLOG_PAGE_SIZE = 100;

/** Resolve list id + search filters for a backlog fetch from current settings.
 *  `error: null` means the provider isn't ClickUp — clear the backlog silently. */
function buildBacklogQuery():
  | { ok: true; listId: string; filters: TaskSearchFilters }
  | { ok: false; error: string | null } {
  const settings = useSettingsStore.getState().settings;
  if (settings.taskManagerProvider !== 'clickup') return { ok: false, error: null };
  const listId = settings.kanbanBacklogListId || settings.clickupListId;
  if (!listId) return { ok: false, error: 'No ClickUp list configured — set Tasks → List in Settings.' };
  const statuses = (settings.kanbanBacklogStatuses || 'to do, open, backlog, planning, ready')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const assigneeId = settings.kanbanFilterAssigneeId?.trim();
  const sort = BACKLOG_SORT_API_PARAMS[settings.kanbanBacklogSortBy] || BACKLOG_SORT_API_PARAMS['priority'];
  return {
    ok: true,
    listId,
    filters: {
      statuses,
      assignees: assigneeId ? [assigneeId] : undefined,
      includeClosed: false,
      orderBy: sort.orderBy,
      reverse: sort.reverse,
    },
  };
}

export const useKanbanStore = create<KanbanState>((set, get) => ({
  tasks: [],
  statuses: [],
  backlog: [],
  backlogLoading: false,
  backlogLoadingMore: false,
  backlogError: null,
  backlogPage: 0,
  backlogHasMore: false,
  members: [],
  membersLoading: false,
  membersError: null,
  loading: false,
  error: null,
  pendingMoves: {},
  autoCode: null,
  autoCodeLogs: {},

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

  loadStatuses: async () => {
    const settings = useSettingsStore.getState().settings;
    if (settings.taskManagerProvider !== 'clickup') {
      set({ statuses: [] });
      return;
    }
    const listId = settings.kanbanBacklogListId || settings.clickupListId;
    if (!listId) {
      set({ statuses: [] });
      return;
    }
    try {
      const res = await window.electronAPI.getListStatuses(listId);
      if (res?.success && Array.isArray(res.data)) {
        set({ statuses: res.data });
      }
    } catch { /* keep whatever columns we already have */ }
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

  loadBacklog: async (opts) => {
    const q = buildBacklogQuery();
    if (!q.ok) {
      set({ backlog: [], backlogError: q.error, backlogPage: 0, backlogHasMore: false });
      return;
    }
    const depth = opts?.reset ? 1 : get().backlogPage + 1;

    set({ backlogLoading: true, backlogError: null });
    try {
      // Every page 0..depth-1 has been scrolled through already, so all of
      // them are known to exist — fetch them together rather than one
      // round-trip at a time. Reloading after scrolling to page 5 used to be
      // six sequential requests, which is seconds of waiting for pages we
      // already knew the shape of.
      const results = await Promise.all(
        Array.from({ length: depth }, (_, p) =>
          window.electronAPI
            .searchTaskManagerTasks('', q.filters, q.listId, p)
            .catch((err: unknown) => ({
              success: false as const,
              error: err instanceof Error ? err.message : 'Failed to load backlog',
            })),
        ),
      );

      if (!results[0].success) {
        set({ backlogLoading: false, backlogError: results[0].error || 'Failed to load backlog' });
        return;
      }

      // Keep the longest run of pages that came back cleanly. Stopping at the
      // first gap preserves the contiguous ordering the list relies on; the
      // rest re-load on scroll.
      const all: TaskManagerTask[] = [];
      let lastFetched = 0;
      let hasMore = false;
      for (let p = 0; p < results.length; p++) {
        const result = results[p];
        if (!result.success) break;
        const pageTasks = result.data || [];
        all.push(...pageTasks);
        lastFetched = p;
        hasMore = pageTasks.length >= BACKLOG_PAGE_SIZE;
        if (!hasMore) break;
      }
      // Dedupe across pages — server-side order can shift between fetches.
      const seen = new Set<string>();
      const deduped = all.filter((t) => !seen.has(t.id) && (seen.add(t.id), true));
      set({
        backlog: deduped,
        backlogLoading: false,
        backlogPage: lastFetched,
        backlogHasMore: hasMore,
      });
    } catch (err) {
      set({ backlogLoading: false, backlogError: err instanceof Error ? err.message : 'Failed to load backlog' });
    }
  },

  loadMoreBacklog: async () => {
    const { backlogHasMore, backlogLoading, backlogLoadingMore, backlogPage } = get();
    if (!backlogHasMore || backlogLoading || backlogLoadingMore) return;
    const q = buildBacklogQuery();
    if (!q.ok) return;
    const nextPage = backlogPage + 1;

    set({ backlogLoadingMore: true });
    try {
      const result = await window.electronAPI.searchTaskManagerTasks('', q.filters, q.listId, nextPage);
      if (!result.success) {
        set({ backlogLoadingMore: false, backlogError: result.error || 'Failed to load more backlog tasks' });
        return;
      }
      const pageTasks: TaskManagerTask[] = result.data || [];
      set((state) => {
        const seen = new Set(state.backlog.map((t) => t.id));
        return {
          backlog: [...state.backlog, ...pageTasks.filter((t) => !seen.has(t.id))],
          backlogLoadingMore: false,
          backlogPage: nextPage,
          backlogHasMore: pageTasks.length >= BACKLOG_PAGE_SIZE,
        };
      });
    } catch (err) {
      set({ backlogLoadingMore: false, backlogError: err instanceof Error ? err.message : 'Failed to load more backlog tasks' });
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

  importTask: async ({ clickupTask, projectPath, projectId, baseBranch, useWorktree }) => {
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
        clickupReleaseVersion: clickupTask.releaseVersion,
        clickupUpdatedAt: clickupTask.updatedAt,
        projectPath,
        projectId,
        baseBranch,
        useWorktree,
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

  linkLocalToClickup: async (localId, clickupTask) => {
    try {
      const result = await window.electronAPI.kanbanLinkClickup({
        localId,
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
        clickupReleaseVersion: clickupTask.releaseVersion,
        clickupUpdatedAt: clickupTask.updatedAt,
      });
      if (result.success && result.data) {
        set((state) => ({ tasks: upsertTask(state.tasks, result.data) }));
        return result.data;
      }
      set({ error: result.error || 'Failed to link to ClickUp' });
      return null;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to link to ClickUp' });
      return null;
    }
  },

  createLocalTask: async ({ name, description, projectPath, projectId, kanbanStatus, baseBranch, useWorktree }) => {
    try {
      const result = await window.electronAPI.kanbanCreateLocal({
        name,
        description,
        projectPath,
        projectId,
        kanbanStatus,
        baseBranch,
        useWorktree,
      });
      if (result.success && result.data) {
        set((state) => ({ tasks: upsertTask(state.tasks, result.data) }));
        return result.data;
      }
      set({ error: result.error || 'Failed to create local task' });
      return null;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to create local task' });
      return null;
    }
  },

  moveTask: async (taskId: string, to: string, orderIndex?: number) => {
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task) return;
    const from = (task.clickupStatus || '').trim();
    const sameStatus = from.toLowerCase() === to.trim().toLowerCase();
    // Same column with no reorder request → no-op.
    if (sameStatus && orderIndex === undefined) return;

    // Pure reorder within a column — no status change, so no ClickUp write.
    if (sameStatus) {
      try {
        const result = await window.electronAPI.kanbanUpdate(taskId, { orderIndex });
        if (result.success && result.data) {
          set((state) => ({ tasks: upsertTask(state.tasks, result.data) }));
        }
      } catch { /* reorder is best-effort */ }
      return;
    }

    // Column move → 1-1 write-back to ClickUp. Optimistically show the card in
    // the destination column; on failure we clear the override so it snaps back.
    set((state) => ({ pendingMoves: { ...state.pendingMoves, [taskId]: to } }));
    try {
      const result = await window.electronAPI.kanbanSetStatus(taskId, to, orderIndex);
      set((state) => {
        const { [taskId]: _drop, ...rest } = state.pendingMoves;
        if (result.success && result.data) {
          return { tasks: upsertTask(state.tasks, result.data), pendingMoves: rest };
        }
        return { pendingMoves: rest, error: result.error || 'ClickUp rejected the status change' };
      });
    } catch (err) {
      set((state) => {
        const { [taskId]: _drop, ...rest } = state.pendingMoves;
        return { pendingMoves: rest, error: err instanceof Error ? err.message : 'Failed to update status' };
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

  clearWorktreeForClickupId: async (clickupTaskId: string) => {
    const match = get().tasks.find((t) => t.clickupTaskId === clickupTaskId);
    if (!match) return;
    await get().updateTask(match.id, { worktreePath: undefined, worktreeBranch: undefined });
  },

  markTaskMergedLocally: async (clickupTaskId: string) => {
    const match = get().tasks.find((t) => t.clickupTaskId === clickupTaskId);
    if (!match) return;
    await get().updateTask(match.id, {
      worktreePath: undefined,
      worktreeBranch: undefined,
      useWorktree: false,
      agentSessionId: undefined,
      agentProvider: undefined,
      agentCwd: undefined,
    });
  },

  deleteTask: async (taskId: string) => {
    try {
      // Capture the record before removal — we need clickupTaskId to unlink terminals.
      const deleted = get().tasks.find((t) => t.id === taskId);
      const result = await window.electronAPI.kanbanDelete(taskId);
      if (result.success) {
        set((state) => ({ tasks: state.tasks.filter((t) => t.id !== taskId) }));
        // Unlink any terminals still pointing at this task. Without this, the
        // boot-time migrateOrphanTerminals() sees a task-linked terminal with
        // no KanbanTask and re-imports the deleted task on next launch.
        if (deleted) {
          const termStore = useTerminalStore.getState();
          for (const term of termStore.terminals) {
            if (term.task?.id === deleted.clickupTaskId) {
              termStore.updateTerminal(term.id, { task: undefined });
            }
          }
        }
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

  setProjectFilter: async (projectId: string) => {
    await useSettingsStore.getState().updateSettings({ kanbanFilterProjectId: projectId });
    // Filtering is client-side too — KanbanView reads the setting and narrows visibleTasks
  },

  clearError: () => set({ error: null }),

  refreshAutoCode: async () => {
    try {
      const result = await window.electronAPI.autoCodeStatus();
      if (result.success && result.data) {
        // Strip the tasks field since per-task state now lives on KanbanTask
        const { tasks: _drop, ...status } = result.data;
        set({ autoCode: status as AutoCodeStatusPayload });
      }
    } catch { /* non-critical */ }
  },

  setAutoCodeStatus: (payload: AutoCodeStatusPayload) => {
    set({ autoCode: payload });
  },

  requeueTask: async (taskId: string) => {
    try {
      const result = await window.electronAPI.autoCodeRequeue(taskId);
      if (result.success && result.data) {
        set((state) => ({ tasks: upsertTask(state.tasks, result.data) }));
      } else if (!result.success) {
        set({ error: result.error || 'Failed to re-queue' });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to re-queue' });
    }
  },

  runTaskNow: async (taskId: string) => {
    try {
      const result = await window.electronAPI.autoCodeRunTask(taskId);
      // Backend resolved the mode + launched the dispatch; the card updates via
      // task-updated events. Surface the reason when there was nothing to run.
      if (!result.success) {
        set({ error: result.error || 'Auto Code could not run this task.' });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to run Auto Code' });
    }
  },

  setTaskAutoMerge: async (taskId: string, override: boolean | null) => {
    await get().updateTask(taskId, { autoMergeOverride: override });
  },

  appendAutoCodeLog: (taskId: string, entry: AutoCodeLogEntry) => {
    set((state) => {
      const prev = state.autoCodeLogs[taskId] || [];
      const next = [...prev, entry];
      // Bound the buffer — drop the oldest lines past the cap.
      if (next.length > AUTO_CODE_LOG_CAP) next.splice(0, next.length - AUTO_CODE_LOG_CAP);
      return { autoCodeLogs: { ...state.autoCodeLogs, [taskId]: next } };
    });
  },

  clearAutoCodeLog: (taskId: string) => {
    set((state) => {
      if (!state.autoCodeLogs[taskId]) return {} as Partial<KanbanState>;
      const { [taskId]: _drop, ...rest } = state.autoCodeLogs;
      return { autoCodeLogs: rest };
    });
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
