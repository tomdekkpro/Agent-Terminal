import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Kanban,
  RefreshCw,
  AlertTriangle,
  Loader2,
  X,
  Wrench,
  Play,
  Square,
  Timer,
  Users,
  User,
  ChevronDown,
  Plus,
  Folder,
  FolderOpen,
  Bell,
} from 'lucide-react';
import {
  useKanbanStore,
  subscribeKanbanEvents,
  KANBAN_COLUMN_ORDER,
  KANBAN_COLUMN_LABELS,
  KANBAN_COLUMN_COLORS,
} from '../../stores/kanban-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';
import type { KanbanTask, KanbanTaskStatus } from '../../../shared/types';
import { cn, parseTimestamp } from '../../../shared/utils';
import { KanbanColumn } from './KanbanColumn';
import { BacklogColumn } from './BacklogColumn';
import { ImportTaskModal } from './ImportTaskModal';
import { CreateLocalTaskModal } from './CreateLocalTaskModal';
import { TaskTerminalModal } from './TaskTerminalModal';
import { useProjectStore } from '../../stores/project-store';
import type { TaskManagerTask } from '../../../shared/types';
import { UsageIndicator } from '../usage/UsageIndicator';
import { KanbanCostSummary } from './KanbanCostSummary';
import { ProjectGitActions } from '../shared/ProjectGitActions';
import { ProjectSkillsAction } from '../shared/ProjectSkillsAction';
import { ProjectDevServerActions } from '../shared/ProjectDevServerActions';
import { SystemMonitor } from '../status/SystemMonitor';
import { ServiceStatusIndicator } from '../status/ServiceStatusIndicator';
import { DevServerLogPanel } from '../dev-server/DevServerLogPanel';
import { NotificationBell } from '../activity/NotificationBell';

/** Fire a native OS notification for newly-arrived backlog tasks. Best-effort:
 *  silently no-ops when the Notification API is unavailable or permission was
 *  denied. Requests permission the first time it's needed. */
function notifyNewBacklogNative(count: number, firstName: string) {
  try {
    if (typeof Notification === 'undefined') return;
    const title = count === 1 ? 'New backlog task' : `${count} new backlog tasks`;
    const body = count === 1 ? firstName : `${firstName} and ${count - 1} more`;
    const show = () => {
      try {
        new Notification(title, { body });
      } catch { /* construction can throw on some platforms */ }
    };
    if (Notification.permission === 'granted') {
      show();
    } else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((perm) => {
        if (perm === 'granted') show();
      });
    }
  } catch { /* ignore */ }
}

interface KanbanViewProps {
  /** Kept for parity with other views — the Kanban handles card activation inline via the TaskTerminalModal */
  onNavigateToTerminal?: () => void;
}

export function KanbanView(_props: KanbanViewProps) {
  const {
    tasks,
    backlog,
    backlogLoading,
    backlogLoadingMore,
    backlogError,
    backlogHasMore,
    members,
    membersLoading,
    membersError,
    loading,
    error,
    pendingMoves,
    autoCode,
    loadTasks,
    loadMembers,
    loadBacklog,
    loadMoreBacklog,
    importTask,
    moveTask,
    deleteTask,
    refreshClickupSnapshots,
    setAssigneeFilter,
    setProjectFilter,
    clearError,
    refreshAutoCode,
    setAutoCodeStatus,
    requeueTask,
    runTaskNow,
    setTaskAutoMerge,
  } = useKanbanStore();

  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const terminals = useTerminalStore((s) => s.terminals);
  const taskManagerProvider = useSettingsStore((s) => s.settings.taskManagerProvider);
  const autoCodeEnabled = useSettingsStore((s) => s.settings.autoCodeEnabled);
  const autoCodeMaxIterations = useSettingsStore((s) => s.settings.autoCodeMaxIterations);
  const autoCodeAutoMerge = useSettingsStore((s) => s.settings.autoCodeAutoMerge);
  const assigneeFilter = useSettingsStore((s) => s.settings.kanbanFilterAssigneeId);
  const projectFilter = useSettingsStore((s) => s.settings.kanbanFilterProjectId);
  const backlogSortBy = useSettingsStore((s) => s.settings.kanbanBacklogSortBy);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [showAssigneeDropdown, setShowAssigneeDropdown] = useState(false);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showCreateLocal, setShowCreateLocal] = useState(false);
  const [importingBacklogIds, setImportingBacklogIds] = useState<Set<string>>(new Set());
  const [activeTaskModalId, setActiveTaskModalId] = useState<string | null>(null);
  const [autoCodeFilter, setAutoCodeFilter] = useState<'coding' | 'awaiting-review' | 'escalated' | null>(null);
  const [newTaskNotice, setNewTaskNotice] = useState<{ count: number; names: string[] } | null>(null);
  const assigneeDropdownRef = useRef<HTMLDivElement>(null);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  // Backlog ids we've already shown to the user. `null` until the first settled
  // load so the initial population doesn't trigger a "new task" notification.
  const seenBacklogIds = useRef<Set<string> | null>(null);
  const prevBacklogLoading = useRef(false);
  const prevBacklogLoadingMore = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeModalTask = tasks.find((t) => t.id === activeTaskModalId) || null;

  // Initial load
  useEffect(() => {
    loadTasks();
    if (taskManagerProvider !== 'none') {
      loadMembers();
      loadBacklog();
    }
  }, [taskManagerProvider, loadTasks, loadMembers, loadBacklog]);

  // Reload the backlog when the assignee filter changes (driven by settings).
  // Re-seed the "seen" set so switching assignees re-populates silently instead
  // of announcing the other user's tasks as brand-new arrivals.
  useEffect(() => {
    seenBacklogIds.current = null;
    if (taskManagerProvider !== 'none') loadBacklog({ reset: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigneeFilter]);

  // Poll the backlog so tasks created in ClickUp while the board is open show
  // up (and notify) without a manual refresh. ClickUp is the source of truth
  // for the backlog, so polling is the only way to learn of new tasks.
  useEffect(() => {
    if (taskManagerProvider === 'none') return;
    const poll = setInterval(() => void loadBacklog(), 60_000);
    return () => clearInterval(poll);
  }, [taskManagerProvider, loadBacklog]);

  // Clean up the auto-dismiss timer on unmount
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  // Subscribe to kanban events (task created/updated/deleted from main process)
  useEffect(() => {
    return subscribeKanbanEvents();
  }, []);

  // Auto-fix orchestrator events
  useEffect(() => {
    refreshAutoCode();
    const unsub = window.electronAPI.onAutoCodeEvent?.((event: any) => {
      if (event.type === 'status' && event.payload) {
        const { tasks: _drop, ...status } = event.payload;
        setAutoCodeStatus(status);
      } else if (event.type === 'log' && event.taskId) {
        // Buffer per-task progress so the detail modal can show what Auto Code
        // is doing live while a headless run is in flight.
        useKanbanStore.getState().appendAutoCodeLog(event.taskId, {
          at: Date.now(),
          message: event.message || '',
          level: event.level || 'info',
        });
      }
    });
    const poll = setInterval(refreshAutoCode, 10_000);
    return () => {
      unsub?.();
      clearInterval(poll);
    };
  }, [refreshAutoCode, setAutoCodeStatus]);

  // Close filter dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (assigneeDropdownRef.current && !assigneeDropdownRef.current.contains(e.target as Node)) {
        setShowAssigneeDropdown(false);
      }
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setShowProjectDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Terminal lookup by ClickUp task id (since that's what terminals link to)
  const terminalsByClickupId = useMemo(() => {
    const map = new Map<string, typeof terminals[number]>();
    for (const t of terminals) {
      if (t.task?.id) map.set(t.task.id, t);
    }
    return map;
  }, [terminals]);

  // Apply assignee + project filters client-side. All tasks are fetched; we
  // narrow purely for display.
  // - Local tasks always pass the assignee filter (they're user-created on
  //   this machine, so they always belong to the current user).
  // - Older KanbanTasks may lack `projectId` (the field was added later) —
  //   match by `projectPath` against the selected project as a fallback so
  //   pre-projectId tasks still filter correctly.
  const visibleTasks = useMemo(() => {
    let out = tasks;
    if (assigneeFilter) {
      out = out.filter(
        (t) => t.provider === 'local' || t.clickupAssignees?.some((a) => a.id === assigneeFilter),
      );
    }
    if (projectFilter) {
      const selected = projects.find((p) => p.id === projectFilter);
      const selectedPath = selected?.path;
      out = out.filter(
        (t) => t.projectId === projectFilter || (!!selectedPath && t.projectPath === selectedPath),
      );
    }
    return out;
  }, [tasks, assigneeFilter, projectFilter, projects]);

  // Filter out already-imported tasks, then order per the user's chosen sort.
  const visibleBacklog = useMemo(() => {
    const importedIds = new Set(tasks.map((t) => t.clickupTaskId));
    const out = backlog.filter((b) => !importedIds.has(b.id));
    const created = (t: TaskManagerTask) => parseTimestamp(t.createdAt) || 0;
    const updated = (t: TaskManagerTask) => parseTimestamp(t.updatedAt) || 0;
    switch (backlogSortBy) {
      case 'created-desc':
        out.sort((a, b) => created(b) - created(a));
        break;
      case 'created-asc':
        out.sort((a, b) => created(a) - created(b));
        break;
      case 'updated-desc':
        out.sort((a, b) => updated(b) - updated(a));
        break;
      case 'priority':
      default:
        // Priority (Urgent → Low → none), then newest-created within a band.
        out.sort((a, b) => {
          const pa = a.priority?.id ? parseInt(a.priority.id, 10) : 999;
          const pb = b.priority?.id ? parseInt(b.priority.id, 10) : 999;
          if (pa !== pb) return pa - pb;
          return created(b) - created(a);
        });
        break;
    }
    return out;
  }, [backlog, tasks, backlogSortBy]);

  // Detect newly-arrived backlog tasks and surface a notification. Acts only on
  // the loading→settled transition of a fetch (not on every `tasks` change), so
  // the diff reflects a fresh ClickUp response. The first settled fetch seeds
  // the baseline silently; subsequent fetches diff against it.
  useEffect(() => {
    const justSettled = prevBacklogLoading.current && !backlogLoading;
    prevBacklogLoading.current = backlogLoading;
    if (taskManagerProvider === 'none' || !justSettled) return;
    const ids = visibleBacklog.map((t) => t.id);
    if (seenBacklogIds.current === null) {
      seenBacklogIds.current = new Set(ids);
      return;
    }
    const fresh = visibleBacklog.filter((t) => !seenBacklogIds.current!.has(t.id));
    ids.forEach((id) => seenBacklogIds.current!.add(id));
    if (fresh.length === 0) return;

    const names = fresh.map((t) => t.name);
    setNewTaskNotice({ count: fresh.length, names });
    notifyNewBacklogNative(fresh.length, names[0]);

    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNewTaskNotice(null), 10_000);
  }, [visibleBacklog, backlogLoading, taskManagerProvider]);

  // Tasks that arrive via infinite scroll aren't "new" — they existed all
  // along on deeper pages. Seed them into the seen-set silently so the next
  // 60s poll (which re-fetches all loaded pages) doesn't announce them.
  useEffect(() => {
    const justLoadedMore = prevBacklogLoadingMore.current && !backlogLoadingMore;
    prevBacklogLoadingMore.current = backlogLoadingMore;
    if (!justLoadedMore || seenBacklogIds.current === null) return;
    visibleBacklog.forEach((t) => seenBacklogIds.current!.add(t.id));
  }, [backlogLoadingMore, visibleBacklog]);

  // Group tasks by their local kanbanStatus, honouring optimistic moves.
  // Within each column we sort by orderIndex (ascending) so the order is
  // stable across refreshes and only changes when the user drags+drops.
  // Backfill: tasks missing orderIndex sort to the bottom of their column,
  // ordered amongst themselves by createdAt to stay deterministic.
  const tasksByStatus = useMemo(() => {
    const by: Record<KanbanTaskStatus, KanbanTask[]> = {
      'todo': [],
      'in-progress': [],
      'review': [],
      'failed': [],
      'done': [],
    };
    for (const task of visibleTasks) {
      const effective = pendingMoves[task.id] || task.kanbanStatus;
      by[effective]?.push(task);
    }
    const orderKey = (t: KanbanTask) =>
      typeof t.orderIndex === 'number'
        ? t.orderIndex
        : Date.parse(t.createdAt || '') || Number.MAX_SAFE_INTEGER;
    for (const status of Object.keys(by) as KanbanTaskStatus[]) {
      by[status].sort((a, b) => orderKey(a) - orderKey(b));
    }
    return by;
  }, [visibleTasks, pendingMoves]);

  const selectedMember = members.find((m) => m.id === assigneeFilter);
  const selectedProject = projects.find((p) => p.id === projectFilter);

  const handleCardClick = useCallback(
    (task: KanbanTask) => {
      setActiveTaskModalId(task.id);
    },
    [],
  );

  const handleDrop = useCallback(
    (to: KanbanTaskStatus) => {
      if (!draggingTaskId) return;
      moveTask(draggingTaskId, to);
      setDraggingTaskId(null);
    },
    [draggingTaskId, moveTask],
  );

  /** Drop landed on a specific card. Compute an orderIndex that places the
   *  dragged task immediately before/after the target so it sorts where the
   *  user released — not always at the bottom. The dragged task is excluded
   *  from neighbor lookup so same-column reorders work too. */
  const handleDropOnCard = useCallback(
    (targetTaskId: string, position: 'before' | 'after', status: KanbanTaskStatus) => {
      if (!draggingTaskId || draggingTaskId === targetTaskId) {
        setDraggingTaskId(null);
        return;
      }
      // Build the destination column's sorted list, excluding the dragged task.
      const orderKey = (t: KanbanTask) =>
        typeof t.orderIndex === 'number'
          ? t.orderIndex
          : Date.parse(t.createdAt || '') || Number.MAX_SAFE_INTEGER;
      const colTasks = tasks
        .filter((t) => {
          if (t.id === draggingTaskId) return false;
          const eff = pendingMoves[t.id] || t.kanbanStatus;
          return eff === status;
        })
        .sort((a, b) => orderKey(a) - orderKey(b));

      const targetIdx = colTasks.findIndex((t) => t.id === targetTaskId);
      if (targetIdx < 0) {
        moveTask(draggingTaskId, status);
        setDraggingTaskId(null);
        return;
      }
      const target = colTasks[targetIdx];
      const targetKey = orderKey(target);

      let newOrderIndex: number;
      if (position === 'before') {
        const prev = targetIdx > 0 ? colTasks[targetIdx - 1] : undefined;
        newOrderIndex = prev ? (orderKey(prev) + targetKey) / 2 : targetKey - 1;
      } else {
        const next = targetIdx < colTasks.length - 1 ? colTasks[targetIdx + 1] : undefined;
        newOrderIndex = next ? (targetKey + orderKey(next)) / 2 : targetKey + 1;
      }

      moveTask(draggingTaskId, status, newOrderIndex);
      setDraggingTaskId(null);
    },
    [draggingTaskId, moveTask, tasks, pendingMoves],
  );

  /** Resolve the project to use for a newly-imported backlog task:
   *  active project if set, else the first project, else null. */
  const getBacklogImportProject = useCallback(() => {
    const active = projects.find((p) => p.id === activeProjectId);
    if (active) return active;
    return projects[0] || null;
  }, [projects, activeProjectId]);

  const handleStartFromBacklog = useCallback(
    async (clickupTask: TaskManagerTask) => {
      const project = getBacklogImportProject();
      if (!project) return; // card is disabled when no project is available

      setImportingBacklogIds((prev) => new Set(prev).add(clickupTask.id));
      try {
        const kanbanTask = await importTask({
          clickupTask,
          projectPath: project.path,
          projectId: project.id,
        });
        if (kanbanTask) {
          // Open the task modal — it handles worktree creation and agent resume
          setActiveTaskModalId(kanbanTask.id);
        }
      } finally {
        setImportingBacklogIds((prev) => {
          const next = new Set(prev);
          next.delete(clickupTask.id);
          return next;
        });
      }
    },
    [importTask, getBacklogImportProject],
  );

  const toggleAutoCode = useCallback(async () => {
    if (!autoCode) return;
    try {
      if (autoCode.active) await window.electronAPI.autoCodeStop();
      else await window.electronAPI.autoCodeStart();
      refreshAutoCode();
    } catch { /* noop */ }
  }, [autoCode, refreshAutoCode]);

  const runAutoCodeNow = useCallback(async () => {
    try {
      await window.electronAPI.autoCodeRunNow();
      refreshAutoCode();
    } catch { /* noop */ }
  }, [refreshAutoCode]);

  // Not configured
  if (taskManagerProvider === 'none') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md">
          <Kanban className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h2 className="text-lg font-medium text-[var(--text-primary)] mb-2">Kanban Board</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Connect ClickUp in Settings to import tasks.
          </p>
        </div>
      </div>
    );
  }

  const escalatedCount = tasks.filter((t) => t.autoCodeState === 'escalated').length;
  const fixingCount = tasks.filter((t) => t.autoCodeState === 'coding').length;
  // "Awaiting QC" = everything pushed and still in-flight but not yet done:
  // tasks waiting for the QC/review verdict AND tasks that passed and are queued
  // for auto-merge (waiting on CI). Both are "waiting, not done".
  const awaitingQCCount = tasks.filter(
    (t) => t.autoCodeState === 'awaiting-review' || t.autoCodeState === 'merging',
  ).length;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <Kanban className="w-5 h-5 text-blue-400" />
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Kanban Board</h1>
            {visibleTasks.length > 0 && (
              <span className="text-xs text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-2 py-0.5 rounded-full">
                {visibleTasks.length}
                {assigneeFilter && tasks.length !== visibleTasks.length ? ` of ${tasks.length}` : ''}
              </span>
            )}
            <KanbanCostSummary tasks={visibleTasks} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCreateLocal(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
              title="Create a local task that doesn't sync with ClickUp"
            >
              <Plus className="w-4 h-4" />
              New Task
            </button>
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors"
              title="Import an existing task from ClickUp"
            >
              <Plus className="w-4 h-4" />
              Import from ClickUp
            </button>
            <button
              onClick={() => refreshClickupSnapshots()}
              disabled={loading}
              title="Refresh ClickUp status/comments for all imported tasks"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
              Refresh
            </button>
            <div className="h-6 w-px bg-[var(--border)] mx-1" />
            <ProjectDevServerActions />
            <ProjectGitActions />
            <ProjectSkillsAction />
            <SystemMonitor />
            <ServiceStatusIndicator />
            <UsageIndicator />
            <div className="h-6 w-px bg-[var(--border)] mx-1" />
            <NotificationBell />
          </div>
        </div>

        {/* Auto-fix status strip — also hidden while a task detail is open. */}
        {autoCodeEnabled && !activeModalTask && (
          <div className="mb-3 flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
            <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)] min-w-0 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Wrench className={cn('w-3.5 h-3.5', autoCode?.active ? 'text-green-400' : 'text-[var(--text-muted)]')} />
                <span className="font-medium text-[var(--text-primary)]">Auto Code</span>
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide',
                  autoCode?.running
                    ? 'bg-blue-500/10 text-blue-400'
                    : autoCode?.active
                      ? 'bg-green-500/10 text-green-400'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                )}>
                  {autoCode?.running ? 'Running' : autoCode?.active ? 'Watching' : 'Idle'}
                </span>
              </div>
              {autoCode && (
                <>
                  <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                    <Timer className="w-3 h-3" />
                    {autoCode.intervalMinutes}m
                  </span>
                  {autoCode.lastRun && (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Last: {new Date(autoCode.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {escalatedCount > 0 && (
                    <button
                      onClick={() => setAutoCodeFilter((f) => (f === 'escalated' ? null : 'escalated'))}
                      title="Tasks that hit the iteration cap — click to highlight them"
                      className={cn(
                        'text-[11px] font-medium px-1.5 py-0.5 rounded transition-colors',
                        autoCodeFilter === 'escalated'
                          ? 'bg-red-500/20 text-red-300 ring-1 ring-red-500/40'
                          : 'text-red-400 hover:bg-red-500/10',
                      )}
                    >
                      {escalatedCount} escalated
                    </button>
                  )}
                  {fixingCount > 0 && (
                    <button
                      onClick={() => setAutoCodeFilter((f) => (f === 'coding' ? null : 'coding'))}
                      title="Auto-fix attempts running right now — click to highlight"
                      className={cn(
                        'text-[11px] px-1.5 py-0.5 rounded transition-colors',
                        autoCodeFilter === 'coding'
                          ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40'
                          : 'text-blue-400 hover:bg-blue-500/10',
                      )}
                    >
                      {fixingCount} auto-codeing
                    </button>
                  )}
                  {awaitingQCCount > 0 && (
                    <button
                      onClick={() => setAutoCodeFilter((f) => (f === 'awaiting-review' ? null : 'awaiting-review'))}
                      title="Fix pushed — waiting for QC to re-test — click to highlight"
                      className={cn(
                        'text-[11px] px-1.5 py-0.5 rounded transition-colors',
                        autoCodeFilter === 'awaiting-review'
                          ? 'bg-yellow-500/20 text-yellow-300 ring-1 ring-yellow-500/40'
                          : 'text-yellow-400 hover:bg-yellow-500/10',
                      )}
                    >
                      {awaitingQCCount} awaiting QC
                    </button>
                  )}
                  {autoCodeFilter && (
                    <button
                      onClick={() => setAutoCodeFilter(null)}
                      title="Clear filter"
                      className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] underline"
                    >
                      Clear filter
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={runAutoCodeNow}
                disabled={!autoCode?.active || autoCode.running}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn('w-3 h-3', autoCode?.running && 'animate-spin')} />
                Run now
              </button>
              <button
                onClick={toggleAutoCode}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
                  autoCode?.active
                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                    : 'bg-green-500/10 text-green-400 hover:bg-green-500/20',
                )}
              >
                {autoCode?.active ? <><Square className="w-3 h-3" /> Stop</> : <><Play className="w-3 h-3" /> Start</>}
              </button>
            </div>
          </div>
        )}

        {/* Assignee + project filters — hidden while a task detail is open so
            the header stays clean behind the fullscreen detail view. */}
        {!activeModalTask && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative" ref={assigneeDropdownRef}>
            <button
              onClick={() => {
                setShowAssigneeDropdown(!showAssigneeDropdown);
                if (membersError && !membersLoading) void loadMembers();
              }}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] border rounded-lg text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors min-w-[180px]',
                assigneeFilter ? 'border-[var(--accent)]/60' : 'border-[var(--border)]',
                membersError && 'border-red-500/40',
              )}
              title={
                membersError
                  ? `Failed to load members: ${membersError}`
                  : assigneeFilter
                    ? `Showing only tasks assigned to ${selectedMember?.username || 'selected user'}`
                    : 'Click to filter tasks by assignee'
              }
            >
              {assigneeFilter ? <User className="w-4 h-4 text-[var(--accent)] shrink-0" /> : <Users className="w-4 h-4 text-[var(--text-muted)] shrink-0" />}
              <span className="truncate max-w-[200px]">
                {membersLoading
                  ? 'Loading members…'
                  : membersError
                    ? 'Members (error — click)'
                    : selectedMember
                      ? selectedMember.username
                      : 'All assignees'}
              </span>
              <ChevronDown className={cn('w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 ml-auto transition-transform', showAssigneeDropdown && 'rotate-180')} />
            </button>
            {showAssigneeDropdown && (
              <div className="absolute z-50 top-full left-0 mt-1 min-w-[260px] max-h-72 overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl">
                <button
                  onClick={() => { void setAssigneeFilter(''); setShowAssigneeDropdown(false); }}
                  className={cn('w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] flex items-center gap-2', !assigneeFilter && 'bg-[var(--accent)]/10 text-[var(--accent)]')}
                >
                  <Users className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <span>All assignees</span>
                </button>
                <div className="border-t border-[var(--border)]" />
                {membersLoading && (
                  <div className="px-3 py-3 text-xs text-[var(--text-muted)] flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Loading members…
                  </div>
                )}
                {membersError && !membersLoading && (
                  <div className="px-3 py-3 text-xs text-red-400 space-y-1.5">
                    <div className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>{membersError}</span>
                    </div>
                    <button onClick={() => void loadMembers()} className="text-[var(--accent)] hover:underline">
                      Retry
                    </button>
                  </div>
                )}
                {!membersLoading && !membersError && members.length === 0 && (
                  <div className="px-3 py-3 text-xs text-[var(--text-muted)]">
                    No workspace members returned. Check <code className="text-[10px]">clickupWorkspaceId</code> in Settings → Tasks.
                  </div>
                )}
                {!membersLoading && !membersError && members.map((member) => (
                  <button
                    key={member.id}
                    onClick={() => { void setAssigneeFilter(member.id); setShowAssigneeDropdown(false); }}
                    className={cn('w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] flex items-center gap-2', member.id === assigneeFilter && 'bg-[var(--accent)]/10 text-[var(--accent)]')}
                  >
                    <span
                      className="w-5 h-5 rounded-full text-[9px] font-medium flex items-center justify-center shrink-0"
                      style={{ backgroundColor: member.color || 'var(--bg-tertiary)', color: '#fff' }}
                    >
                      {member.initials || member.username.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="truncate">{member.username}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Project filter */}
          <div className="relative" ref={projectDropdownRef}>
            <button
              onClick={() => setShowProjectDropdown(!showProjectDropdown)}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] border rounded-lg text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors min-w-[180px]',
                projectFilter ? 'border-[var(--accent)]/60' : 'border-[var(--border)]',
              )}
              title={
                projectFilter
                  ? `Showing only tasks for ${selectedProject?.name || 'selected project'}`
                  : 'Click to filter tasks by project'
              }
            >
              {projectFilter ? <FolderOpen className="w-4 h-4 text-[var(--accent)] shrink-0" /> : <Folder className="w-4 h-4 text-[var(--text-muted)] shrink-0" />}
              <span className="truncate max-w-[200px]">
                {selectedProject ? selectedProject.name : 'All projects'}
              </span>
              <ChevronDown className={cn('w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 ml-auto transition-transform', showProjectDropdown && 'rotate-180')} />
            </button>
            {showProjectDropdown && (
              <div className="absolute z-50 top-full left-0 mt-1 min-w-[260px] max-h-72 overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl">
                <button
                  onClick={() => { void setProjectFilter(''); setShowProjectDropdown(false); }}
                  className={cn('w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] flex items-center gap-2', !projectFilter && 'bg-[var(--accent)]/10 text-[var(--accent)]')}
                >
                  <Folder className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <span>All projects</span>
                </button>
                <div className="border-t border-[var(--border)]" />
                {projects.length === 0 && (
                  <div className="px-3 py-3 text-xs text-[var(--text-muted)]">
                    No projects yet. Add one in the sidebar to filter by it.
                  </div>
                )}
                {projects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => { void setProjectFilter(project.id); setShowProjectDropdown(false); }}
                    className={cn('w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] flex items-center gap-2', project.id === projectFilter && 'bg-[var(--accent)]/10 text-[var(--accent)]')}
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                    <span className="truncate flex-1">{project.name}</span>
                    {project.id === activeProjectId && (
                      <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)] shrink-0">active</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mt-3 flex items-center justify-between gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg px-4 py-2 border border-red-500/20">
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span className="truncate">{error}</span>
            </div>
            <button onClick={clearError} className="p-1 rounded hover:bg-red-500/20 shrink-0" title="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Board — relative so the task-detail modal can fill this region in
          fullscreen mode while the sidebar + header above stay visible. */}
      <div className="flex-1 relative min-h-0">
      <div className="absolute inset-0 overflow-x-auto overflow-y-hidden">
        {loading && tasks.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-[var(--accent)] animate-spin" />
          </div>
        ) : (
          <div className="flex gap-3 p-4 h-full">
            <BacklogColumn
              tasks={visibleBacklog}
              loading={backlogLoading}
              loadingMore={backlogLoadingMore}
              hasMore={backlogHasMore}
              error={backlogError}
              importingIds={importingBacklogIds}
              canStart={projects.length > 0}
              sortBy={backlogSortBy}
              onSortChange={(sort) => {
                // Persist the choice, then re-query the provider with the new
                // server-side ordering (resets pagination to the first page).
                void updateSettings({ kanbanBacklogSortBy: sort }).then(() => loadBacklog({ reset: true }));
              }}
              onRefresh={() => void loadBacklog()}
              onLoadMore={() => void loadMoreBacklog()}
              onStart={handleStartFromBacklog}
            />
            {KANBAN_COLUMN_ORDER.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                label={KANBAN_COLUMN_LABELS[status]}
                color={KANBAN_COLUMN_COLORS[status]}
                tasks={tasksByStatus[status]}
                terminalsByTaskId={terminalsByClickupId}
                maxIterations={autoCodeMaxIterations || 3}
                autoMergeGlobal={autoCodeAutoMerge}
                autoCodeGlobal={autoCodeEnabled}
                autoCodeFilter={autoCodeFilter}
                pendingMoves={pendingMoves}
                draggingTaskId={draggingTaskId}
                onDragStart={setDraggingTaskId}
                onDragEnd={() => setDraggingTaskId(null)}
                onDrop={handleDrop}
                onDropOnCard={handleDropOnCard}
                onCardClick={handleCardClick}
                onRequeue={requeueTask}
                onRunNow={runTaskNow}
                onToggleAutoMerge={setTaskAutoMerge}
                onToggleAutoCode={(id, enabled) => void useKanbanStore.getState().updateTask(id, { autoCodeEnabled: enabled })}
                onDelete={deleteTask}
              />
            ))}
          </div>
        )}
      </div>
        {/* Task detail — in fullscreen this overlay fills the board region
            (this relative wrapper), leaving the sidebar + header visible. */}
        <TaskTerminalModal task={activeModalTask} onClose={() => setActiveTaskModalId(null)} />
      </div>

      {/* Dev-server log panel (FE/BE) — shares the dev-server store with the
          toolbar buttons; renders at the bottom when a log is toggled open. */}
      <DevServerLogPanel />

      {/* New-backlog-task notification (auto-dismisses after 10s) */}
      {newTaskNotice && (
        <div className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-[var(--accent)]/40 bg-[var(--bg-card)] shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-[var(--accent)]" />
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {newTaskNotice.count === 1 ? 'New backlog task' : `${newTaskNotice.count} new backlog tasks`}
              </span>
            </div>
            <button
              onClick={() => setNewTaskNotice(null)}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] transition-colors"
              title="Dismiss"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <div className="px-4 py-3 space-y-1">
            {newTaskNotice.names.slice(0, 3).map((name, i) => (
              <p key={i} className="text-xs text-[var(--text-secondary)] truncate">• {name}</p>
            ))}
            {newTaskNotice.count > 3 && (
              <p className="text-[11px] text-[var(--text-muted)] italic">
                and {newTaskNotice.count - 3} more…
              </p>
            )}
          </div>
        </div>
      )}

      <ImportTaskModal open={showImport} onClose={() => setShowImport(false)} />
      <CreateLocalTaskModal open={showCreateLocal} onClose={() => setShowCreateLocal(false)} />
    </div>
  );
}
