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
import { cn } from '../../../shared/utils';
import { KanbanColumn } from './KanbanColumn';
import { BacklogColumn } from './BacklogColumn';
import { ImportTaskModal } from './ImportTaskModal';
import { TaskTerminalModal } from './TaskTerminalModal';
import { useProjectStore } from '../../stores/project-store';
import type { TaskManagerTask } from '../../../shared/types';

interface KanbanViewProps {
  /** Kept for parity with other views — the Kanban handles card activation inline via the TaskTerminalModal */
  onNavigateToTerminal?: () => void;
}

export function KanbanView(_props: KanbanViewProps) {
  const {
    tasks,
    backlog,
    backlogLoading,
    backlogError,
    members,
    membersLoading,
    membersError,
    loading,
    error,
    pendingMoves,
    autoFix,
    loadTasks,
    loadMembers,
    loadBacklog,
    importTask,
    moveTask,
    deleteTask,
    refreshClickupSnapshots,
    setAssigneeFilter,
    clearError,
    refreshAutoFix,
    setAutoFixStatus,
    requeueTask,
    setTaskAutoMerge,
  } = useKanbanStore();

  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const terminals = useTerminalStore((s) => s.terminals);
  const taskManagerProvider = useSettingsStore((s) => s.settings.taskManagerProvider);
  const autoFixEnabled = useSettingsStore((s) => s.settings.autoFixEnabled);
  const autoFixMaxIterations = useSettingsStore((s) => s.settings.autoFixMaxIterations);
  const autoFixAutoMerge = useSettingsStore((s) => s.settings.autoFixAutoMerge);
  const assigneeFilter = useSettingsStore((s) => s.settings.kanbanFilterAssigneeId);

  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [showAssigneeDropdown, setShowAssigneeDropdown] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importingBacklogIds, setImportingBacklogIds] = useState<Set<string>>(new Set());
  const [activeTaskModalId, setActiveTaskModalId] = useState<string | null>(null);
  const [autoFixFilter, setAutoFixFilter] = useState<'fixing' | 'awaiting-qc' | 'escalated' | null>(null);
  const assigneeDropdownRef = useRef<HTMLDivElement>(null);

  const activeModalTask = tasks.find((t) => t.id === activeTaskModalId) || null;

  // Initial load
  useEffect(() => {
    loadTasks();
    if (taskManagerProvider !== 'none') {
      loadMembers();
      loadBacklog();
    }
  }, [taskManagerProvider, loadTasks, loadMembers, loadBacklog]);

  // Reload the backlog when the assignee filter changes (driven by settings)
  useEffect(() => {
    if (taskManagerProvider !== 'none') loadBacklog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigneeFilter]);

  // Subscribe to kanban events (task created/updated/deleted from main process)
  useEffect(() => {
    return subscribeKanbanEvents();
  }, []);

  // Auto-fix orchestrator events
  useEffect(() => {
    refreshAutoFix();
    const unsub = window.electronAPI.onAutoFixEvent?.((event: any) => {
      if (event.type === 'status' && event.payload) {
        const { tasks: _drop, ...status } = event.payload;
        setAutoFixStatus(status);
      }
    });
    const poll = setInterval(refreshAutoFix, 10_000);
    return () => {
      unsub?.();
      clearInterval(poll);
    };
  }, [refreshAutoFix, setAutoFixStatus]);

  // Close assignee dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (assigneeDropdownRef.current && !assigneeDropdownRef.current.contains(e.target as Node)) {
        setShowAssigneeDropdown(false);
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

  // Apply assignee filter client-side — all tasks fetched; filter just for display
  const visibleTasks = useMemo(() => {
    if (!assigneeFilter) return tasks;
    return tasks.filter((t) => t.clickupAssignees?.some((a) => a.id === assigneeFilter));
  }, [tasks, assigneeFilter]);

  // Filter out already-imported tasks and sort by priority (Urgent → Low → no priority)
  const visibleBacklog = useMemo(() => {
    const importedIds = new Set(tasks.map((t) => t.clickupTaskId));
    const out = backlog.filter((b) => !importedIds.has(b.id));
    out.sort((a, b) => {
      const pa = a.priority?.id ? parseInt(a.priority.id, 10) : 999;
      const pb = b.priority?.id ? parseInt(b.priority.id, 10) : 999;
      if (pa !== pb) return pa - pb;
      // Secondary sort: most recently updated first
      const ta = Number(a.updatedAt) || Date.parse(a.updatedAt || '') || 0;
      const tb = Number(b.updatedAt) || Date.parse(b.updatedAt || '') || 0;
      return tb - ta;
    });
    return out;
  }, [backlog, tasks]);

  // Group tasks by their local kanbanStatus, honouring optimistic moves
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
    return by;
  }, [visibleTasks, pendingMoves]);

  const selectedMember = members.find((m) => m.id === assigneeFilter);

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

  const toggleAutoFix = useCallback(async () => {
    if (!autoFix) return;
    try {
      if (autoFix.active) await window.electronAPI.autoFixStop();
      else await window.electronAPI.autoFixStart();
      refreshAutoFix();
    } catch { /* noop */ }
  }, [autoFix, refreshAutoFix]);

  const runAutoFixNow = useCallback(async () => {
    try {
      await window.electronAPI.autoFixRunNow();
      refreshAutoFix();
    } catch { /* noop */ }
  }, [refreshAutoFix]);

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

  const escalatedCount = tasks.filter((t) => t.autoFixState === 'escalated').length;
  const fixingCount = tasks.filter((t) => t.autoFixState === 'fixing').length;
  const awaitingQCCount = tasks.filter((t) => t.autoFixState === 'awaiting-qc').length;

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
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowImport(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
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
          </div>
        </div>

        {/* Auto-fix status strip */}
        {autoFixEnabled && (
          <div className="mb-3 flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
            <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)] min-w-0 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Wrench className={cn('w-3.5 h-3.5', autoFix?.active ? 'text-green-400' : 'text-[var(--text-muted)]')} />
                <span className="font-medium text-[var(--text-primary)]">Auto-Fix</span>
                <span className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide',
                  autoFix?.running
                    ? 'bg-blue-500/10 text-blue-400'
                    : autoFix?.active
                      ? 'bg-green-500/10 text-green-400'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                )}>
                  {autoFix?.running ? 'Running' : autoFix?.active ? 'Watching' : 'Idle'}
                </span>
              </div>
              {autoFix && (
                <>
                  <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                    <Timer className="w-3 h-3" />
                    {autoFix.intervalMinutes}m
                  </span>
                  {autoFix.lastRun && (
                    <span className="text-[11px] text-[var(--text-muted)]">
                      Last: {new Date(autoFix.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {escalatedCount > 0 && (
                    <button
                      onClick={() => setAutoFixFilter((f) => (f === 'escalated' ? null : 'escalated'))}
                      title="Tasks that hit the iteration cap — click to highlight them"
                      className={cn(
                        'text-[11px] font-medium px-1.5 py-0.5 rounded transition-colors',
                        autoFixFilter === 'escalated'
                          ? 'bg-red-500/20 text-red-300 ring-1 ring-red-500/40'
                          : 'text-red-400 hover:bg-red-500/10',
                      )}
                    >
                      {escalatedCount} escalated
                    </button>
                  )}
                  {fixingCount > 0 && (
                    <button
                      onClick={() => setAutoFixFilter((f) => (f === 'fixing' ? null : 'fixing'))}
                      title="Auto-fix attempts running right now — click to highlight"
                      className={cn(
                        'text-[11px] px-1.5 py-0.5 rounded transition-colors',
                        autoFixFilter === 'fixing'
                          ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/40'
                          : 'text-blue-400 hover:bg-blue-500/10',
                      )}
                    >
                      {fixingCount} auto-fixing
                    </button>
                  )}
                  {awaitingQCCount > 0 && (
                    <button
                      onClick={() => setAutoFixFilter((f) => (f === 'awaiting-qc' ? null : 'awaiting-qc'))}
                      title="Fix pushed — waiting for QC to re-test — click to highlight"
                      className={cn(
                        'text-[11px] px-1.5 py-0.5 rounded transition-colors',
                        autoFixFilter === 'awaiting-qc'
                          ? 'bg-yellow-500/20 text-yellow-300 ring-1 ring-yellow-500/40'
                          : 'text-yellow-400 hover:bg-yellow-500/10',
                      )}
                    >
                      {awaitingQCCount} awaiting QC
                    </button>
                  )}
                  {autoFixFilter && (
                    <button
                      onClick={() => setAutoFixFilter(null)}
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
                onClick={runAutoFixNow}
                disabled={!autoFix?.active || autoFix.running}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn('w-3 h-3', autoFix?.running && 'animate-spin')} />
                Run now
              </button>
              <button
                onClick={toggleAutoFix}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
                  autoFix?.active
                    ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                    : 'bg-green-500/10 text-green-400 hover:bg-green-500/20',
                )}
              >
                {autoFix?.active ? <><Square className="w-3 h-3" /> Stop</> : <><Play className="w-3 h-3" /> Start</>}
              </button>
            </div>
          </div>
        )}

        {/* Assignee filter */}
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
        </div>

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

      {/* Board */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        {loading && tasks.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-[var(--accent)] animate-spin" />
          </div>
        ) : (
          <div className="flex gap-3 p-4 h-full">
            <BacklogColumn
              tasks={visibleBacklog}
              loading={backlogLoading}
              error={backlogError}
              importingIds={importingBacklogIds}
              canStart={projects.length > 0}
              onRefresh={loadBacklog}
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
                maxIterations={autoFixMaxIterations || 3}
                autoMergeGlobal={autoFixAutoMerge}
                autoFixGlobal={autoFixEnabled}
                autoFixFilter={autoFixFilter}
                pendingMoves={pendingMoves}
                draggingTaskId={draggingTaskId}
                onDragStart={setDraggingTaskId}
                onDragEnd={() => setDraggingTaskId(null)}
                onDrop={handleDrop}
                onCardClick={handleCardClick}
                onRequeue={requeueTask}
                onToggleAutoMerge={setTaskAutoMerge}
                onToggleAutoFix={(id, override) => void useKanbanStore.getState().updateTask(id, { autoFixOverride: override })}
                onDelete={deleteTask}
              />
            ))}
          </div>
        )}
      </div>

      <ImportTaskModal open={showImport} onClose={() => setShowImport(false)} />
      <TaskTerminalModal task={activeModalTask} onClose={() => setActiveTaskModalId(null)} />
    </div>
  );
}
