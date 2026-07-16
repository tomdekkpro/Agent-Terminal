import { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, X, Bot, Terminal as TerminalIcon, Search,
  Columns2, ChevronDown, ChevronRight, GitBranch,
  Folder, Download, RefreshCw, List,
  Filter, Loader2, GripVertical, Zap, FolderOpen, Rocket,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminal-store';
import { useKanbanStore } from '../../stores/kanban-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useProjectStore } from '../../stores/project-store';
import { TerminalPanel } from './TerminalPanel';
import { ChangesPanel } from './ChangesPanel';
import { FilesPanel } from './FilesPanel';
import { SkillsPanel } from './SkillsPanel';
import { UsageIndicator } from '../usage/UsageIndicator';
import { ServiceStatusIndicator } from '../status/ServiceStatusIndicator';
import { SystemMonitor } from '../status/SystemMonitor';
import { cn, csvToLowerSet, toggleInCsv } from '../../../shared/utils';
import type { TaskManagerTask, TaskManagerList, TerminalTask, AgentProviderMeta } from '../../../shared/types';
import { postTimeEntriesByDate } from '../../utils/time-tracking';
import { resolveSessionCwd, buildSessionCandidates } from '../../lib/resolve-session-cwd';
import { sendAgentPrompt } from '../../lib/send-agent-prompt';
import { useCompleteTaskFlow } from '../../hooks/useCompleteTaskFlow';

const PICKER_PAGE_SIZE = 100;

/** Task Picker Modal - shown when creating terminal with task or linking a task */
export function TaskPickerModal({
  mode = 'new',
  onSelect,
  onCancel,
  onPlain,
}: {
  mode?: 'new' | 'link';
  onSelect: (task: TaskManagerTask, useWorktree: boolean) => void;
  onCancel: () => void;
  onPlain?: () => void;
}) {
  const settings = useSettingsStore((s) => s.settings);
  const [tasks, setTasks] = useState<TaskManagerTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Infinite scroll state
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Lists
  const [lists, setLists] = useState<TaskManagerList[]>([]);
  const [selectedListId, setSelectedListId] = useState<string>('');
  const [showListDropdown, setShowListDropdown] = useState(false);
  const listDropdownRef = useRef<HTMLDivElement>(null);

  // Filters
  const [showFilters, setShowFilters] = useState(false);
  const [filterStatuses, setFilterStatuses] = useState<string[]>([]);
  const [filterAssignees, setFilterAssignees] = useState<string[]>([]);
  const [availableStatuses, setAvailableStatuses] = useState<{ name: string; color: string }[]>([]);
  const [availableAssignees, setAvailableAssignees] = useState<{ id: string; username: string }[]>([]);

  // Close list dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (listDropdownRef.current && !listDropdownRef.current.contains(e.target as Node)) {
        setShowListDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fetch lists on mount
  useEffect(() => {
    window.electronAPI.getTaskManagerLists().then((result: any) => {
      if (result.success && result.data) {
        setLists(result.data);
        if (result.data.length > 0) {
          const defaultId = settings.clickupListId || result.data[0].id;
          const exists = result.data.some((l: TaskManagerList) => l.id === defaultId);
          setSelectedListId(exists ? defaultId : result.data[0].id);
        }
      }
    });
  }, []);

  const buildFilters = useCallback(() => ({
    statuses: filterStatuses.length > 0 ? filterStatuses : undefined,
    assignees: filterAssignees.length > 0 ? filterAssignees : undefined,
    includeClosed,
  }), [filterStatuses, filterAssignees, includeClosed]);

  const doSearch = useCallback(async (query: string, filters: { statuses?: string[]; assignees?: string[]; includeClosed?: boolean }, listId?: string, pageNum: number = 0) => {
    const result = await window.electronAPI.searchTaskManagerTasks(
      query,
      filters,
      listId,
      pageNum,
    );
    if (result.success && result.data) {
      const data = result.data as TaskManagerTask[];
      if (pageNum === 0) {
        setTasks(data);
        // Collect available statuses/assignees from first page
        const statusMap = new Map<string, string>();
        const assigneeMap = new Map<string, string>();
        for (const t of data) {
          if (t.status?.name) statusMap.set(t.status.name, t.status.color);
          for (const a of t.assignees || []) {
            assigneeMap.set(String(a.id), a.username);
          }
        }
        setAvailableStatuses(Array.from(statusMap, ([name, color]) => ({ name, color })));
        setAvailableAssignees(Array.from(assigneeMap, ([id, username]) => ({ id, username })));
      } else {
        setTasks((prev) => [...prev, ...data]);
        // Merge new statuses/assignees
        const statusMap = new Map<string, string>();
        const assigneeMap = new Map<string, string>();
        for (const t of data) {
          if (t.status?.name) statusMap.set(t.status.name, t.status.color);
          for (const a of t.assignees || []) {
            assigneeMap.set(String(a.id), a.username);
          }
        }
        setAvailableStatuses((prev) => {
          const merged = new Map(prev.map((s) => [s.name, s.color]));
          statusMap.forEach((color, name) => merged.set(name, color));
          return Array.from(merged, ([name, color]) => ({ name, color }));
        });
        setAvailableAssignees((prev) => {
          const merged = new Map(prev.map((a) => [a.id, a.username]));
          assigneeMap.forEach((username, id) => merged.set(id, username));
          return Array.from(merged, ([id, username]) => ({ id, username }));
        });
      }
      setHasMore(data.length >= PICKER_PAGE_SIZE);
    }
  }, []);

  // Load tasks when selectedListId is set
  useEffect(() => {
    if (!selectedListId) return;
    setLoading(true);
    setPage(0);
    setHasMore(true);
    doSearch('', buildFilters(), selectedListId, 0)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedListId]);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  const loadNextPage = useCallback(async () => {
    if (!hasMore || loadingMore || loading) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    setPage(nextPage);
    await doSearch(search, buildFilters(), selectedListId, nextPage);
    setLoadingMore(false);
  }, [hasMore, loadingMore, loading, page, search, buildFilters, selectedListId, doSearch]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || !hasMore || loadingMore || loading) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      loadNextPage();
    }
  }, [hasMore, loadingMore, loading, loadNextPage]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    searchTimerRef.current = setTimeout(async () => {
      setSearching(true);
      setPage(0);
      setHasMore(true);
      try {
        await doSearch(value, buildFilters(), selectedListId, 0);
      } catch {
        // Keep existing tasks on error
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [doSearch, buildFilters, selectedListId]);

  // Re-fetch when filters change
  useEffect(() => {
    if (!selectedListId) return;
    setSearching(true);
    setPage(0);
    setHasMore(true);
    doSearch(search, buildFilters(), selectedListId, 0)
      .catch(() => {})
      .finally(() => setSearching(false));
  }, [includeClosed, filterStatuses, filterAssignees]);

  const activeFilterCount = (filterStatuses.length > 0 ? 1 : 0)
    + (filterAssignees.length > 0 ? 1 : 0)
    + (includeClosed ? 1 : 0);

  const toggleStatus = useCallback((status: string) => {
    setFilterStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]
    );
  }, []);

  const toggleAssignee = useCallback((id: string) => {
    setFilterAssignees((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  }, []);

  const clearFilters = useCallback(() => {
    setFilterStatuses([]);
    setFilterAssignees([]);
    setIncludeClosed(false);
  }, []);

  const selectedList = lists.find((l) => l.id === selectedListId);
  const listsBySpace = lists.reduce<Record<string, TaskManagerList[]>>((acc, list) => {
    const key = list.space || 'Other';
    if (!acc[key]) acc[key] = [];
    acc[key].push(list);
    return acc;
  }, {});

  // Picking a task starts it immediately — worktree vs current branch is now
  // chosen on the Start button, per launch (see handleInvokeAgent).

  // Step 1: pick a task
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[480px] max-h-[70vh] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">
        <div className="p-4 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
            {mode === 'link' ? 'Link Task to Terminal' : 'Start Terminal with Task'}
          </h2>

          {/* List selector */}
          {lists.length > 0 && (
            <div className="relative mb-2" ref={listDropdownRef}>
              <button
                onClick={() => setShowListDropdown(!showListDropdown)}
                className="w-full flex items-center justify-between px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <List className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                  <span className="truncate">
                    {selectedList ? selectedList.name : 'Select a list...'}
                    {selectedList?.folder && (
                      <span className="text-[var(--text-muted)]"> &middot; {selectedList.folder}</span>
                    )}
                  </span>
                </div>
                <ChevronDown className={cn('w-4 h-4 text-[var(--text-muted)] shrink-0 transition-transform', showListDropdown && 'rotate-180')} />
              </button>

              {showListDropdown && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl">
                  {Object.entries(listsBySpace).map(([space, spaceLists]) => (
                    <div key={space}>
                      {Object.keys(listsBySpace).length > 1 && (
                        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-secondary)] sticky top-0">
                          {space}
                        </div>
                      )}
                      {spaceLists.map((list) => (
                        <button
                          key={list.id}
                          onClick={() => {
                            setSelectedListId(list.id);
                            setShowListDropdown(false);
                          }}
                          className={cn(
                            'w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-tertiary)]',
                            list.id === selectedListId && 'bg-[var(--accent)]/10 text-[var(--accent)]'
                          )}
                        >
                          <span>{list.name}</span>
                          {list.folder && (
                            <span className="text-[10px] text-[var(--text-muted)] ml-2">{list.folder}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Search + filter button */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              {searching ? (
                <RefreshCw className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--accent)] animate-spin" />
              ) : (
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
              )}
              <input
                type="text"
                autoFocus
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search by title or task ID..."
                className="w-full pl-9 pr-4 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={cn(
                'flex items-center gap-1 px-2.5 py-2 rounded-lg border text-xs transition-colors',
                showFilters || activeFilterCount > 0
                  ? 'bg-[var(--accent)]/10 border-[var(--accent)]/30 text-[var(--accent)]'
                  : 'bg-[var(--bg-secondary)] border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]'
              )}
            >
              <Filter className="w-3.5 h-3.5" />
              {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
            </button>
          </div>

          {/* Filter panel */}
          {showFilters && (
            <div className="mt-2 p-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg space-y-3">
              {/* Include closed toggle */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeClosed}
                  onChange={(e) => setIncludeClosed(e.target.checked)}
                  className="rounded border-[var(--border)] accent-[var(--accent)]"
                />
                <span className="text-[11px] text-[var(--text-muted)]">Include closed tasks</span>
              </label>

              {/* Status filter */}
              {availableStatuses.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">Status</div>
                  <div className="flex flex-wrap gap-1">
                    {availableStatuses.map((s) => (
                      <button
                        key={s.name}
                        onClick={() => toggleStatus(s.name)}
                        className={cn(
                          'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                          filterStatuses.includes(s.name)
                            ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                            : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]'
                        )}
                      >
                        <span className="inline-block w-1.5 h-1.5 rounded-full mr-1" style={{ backgroundColor: s.color }} />
                        {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Assignee filter */}
              {availableAssignees.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1.5">Assignee</div>
                  <div className="flex flex-wrap gap-1">
                    {availableAssignees.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => toggleAssignee(a.id)}
                        className={cn(
                          'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                          filterAssignees.includes(a.id)
                            ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                            : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]'
                        )}
                      >
                        {a.username}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Clear filters */}
              {activeFilterCount > 0 && (
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1 text-[11px] text-[var(--error)] hover:underline"
                >
                  <X className="w-3 h-3" />
                  Clear all filters
                </button>
              )}
            </div>
          )}
        </div>
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-2"
        >
          {loading ? (
            <div className="flex items-center justify-center h-24 text-[var(--text-muted)]">
              <span className="text-sm">Loading tasks...</span>
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-[var(--text-muted)]">
              <span className="text-sm">No tasks found</span>
            </div>
          ) : (
            <>
              {tasks.map((task) => (
                <button
                  key={task.id}
                  onClick={() => onSelect(task, mode !== 'link')}
                  className="w-full text-left p-3 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: task.status.color }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {task.customId && (
                          <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">
                            {task.customId}
                          </span>
                        )}
                        <span className="text-sm text-[var(--text-primary)] truncate">
                          {task.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-full"
                          style={{
                            backgroundColor: `${task.status.color}20`,
                            color: task.status.color,
                          }}
                        >
                          {task.status.name}
                        </span>
                        {task.priority && (
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {task.priority.name}
                          </span>
                        )}
                        {task.assignees && task.assignees.length > 0 && (
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {task.assignees.map(a => a.username).join(', ')}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
              {loadingMore && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
                  <span className="text-xs text-[var(--text-muted)] ml-2">Loading more...</span>
                </div>
              )}
            </>
          )}
        </div>
        <div className={cn('p-3 border-t border-[var(--border)] flex items-center', mode === 'link' ? 'justify-end' : 'justify-between')}>
          {mode !== 'link' && (
            <button
              onClick={onPlain}
              className="px-3 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              Plain Terminal (no task)
            </button>
          )}
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** Grid column class based on terminal count */
// ─── Preview Split Layout ───────────────────────────────────────

export function ChangesSplitLayout({
  terminal,
  children,
}: {
  terminal: import('../../stores/terminal-store').Terminal;
  children: React.ReactNode;
}) {
  const togglePreview = useTerminalStore((s) => s.togglePreview);

  const containerRef = useRef<HTMLDivElement>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const [isDragging, setIsDragging] = useState(false);

  // Track auto-refresh trigger — increments when agent finishes
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const prevBusyRef = useRef(terminal.isClaudeBusy);

  useEffect(() => {
    if (prevBusyRef.current && !terminal.isClaudeBusy) {
      setRefreshTrigger((n) => n + 1);
    }
    prevBusyRef.current = terminal.isClaudeBusy;
  }, [terminal.isClaudeBusy]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const onMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const pct = Math.min(Math.max((x / rect.width) * 100, 20), 80);
      setSplitPercent(pct);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const cwd = terminal.worktreePath || terminal.claudeCwd || terminal.cwd || '';

  return (
    <div ref={containerRef} className="flex h-full relative">
      {isDragging && (
        <div className="absolute inset-0 z-50 cursor-col-resize" />
      )}

      {/* Terminal side */}
      <div className="relative min-w-0 min-h-0" style={{ width: `${splitPercent}%` }}>
        {children}
      </div>

      {/* Resizable splitter */}
      <div
        className={cn(
          'w-1.5 shrink-0 cursor-col-resize relative group transition-colors',
          isDragging ? 'bg-[var(--accent)]' : 'bg-[var(--border)] hover:bg-[var(--accent)]',
        )}
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-y-0 -left-2 -right-2 z-10" />
      </div>

      {/* Changes panel side */}
      <div className="min-w-0 min-h-0" style={{ width: `${100 - splitPercent}%` }}>
        <ChangesPanel
          cwd={cwd}
          baseBranch={terminal.baseBranch}
          onClose={() => togglePreview(terminal.id)}
          autoRefreshTrigger={refreshTrigger}
        />
      </div>
    </div>
  );
}

function getGridClass(count: number): string {
  if (count <= 1) return 'grid-cols-1';
  if (count <= 4) return 'grid-cols-2';
  if (count <= 9) return 'grid-cols-3';
  return 'grid-cols-4';
}

interface TerminalViewProps {
  projectId?: string;
}

export function TerminalView({ projectId }: TerminalViewProps) {
  const allTerminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const activeGroupId = useTerminalStore((s) => s.activeGroupId);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const setActiveGroup = useTerminalStore((s) => s.setActiveGroup);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const splitTerminal = useTerminalStore((s) => s.splitTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const removeGroup = useTerminalStore((s) => s.removeGroup);
  const canAddTerminal = useTerminalStore((s) => s.canAddTerminal);
  const settings = useSettingsStore((s) => s.settings);

  // ClickUp statuses (board columns) drive the sidebar grouping order so the
  // Terminal tree mirrors the Kanban board 1-1. Load once; the Kanban view
  // refreshes them too, so this just covers opening Terminal first.
  const kanbanStatuses = useKanbanStore((s) => s.statuses);
  useEffect(() => {
    if (settings.taskManagerProvider !== 'none') {
      void useKanbanStore.getState().loadStatuses();
    }
  }, [settings.taskManagerProvider]);

  // Mirror the Kanban board's column controls: hidden statuses are dropped from
  // the tree, collapsed statuses start collapsed, and toggling a status group
  // updates the same persisted setting so both views stay in sync.
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const hiddenStatusSet = useMemo(() => csvToLowerSet(settings.kanbanHiddenStatuses), [settings.kanbanHiddenStatuses]);
  const collapsedStatusSet = useMemo(() => csvToLowerSet(settings.kanbanCollapsedStatuses), [settings.kanbanCollapsedStatuses]);
  const toggleStatusCollapsed = useCallback(
    (name: string) => void updateSettings({ kanbanCollapsedStatuses: toggleInCsv(settings.kanbanCollapsedStatuses, name) }),
    [settings.kanbanCollapsedStatuses, updateSettings],
  );

  // Agent providers from registry
  const [agentProviders, setAgentProviders] = useState<AgentProviderMeta[]>([]);
  useEffect(() => {
    window.electronAPI.getAgentProviders?.()
      .then((result: any) => {
        if (result.success && result.data) setAgentProviders(result.data);
      })
      .catch(() => {});
  }, []);

  // Refresh task status colors from API so tabs reflect current status
  useEffect(() => {
    const refresh = () => {
      const terms = useTerminalStore.getState().terminals;
      for (const t of terms) {
        if (!t.task) continue;
        window.electronAPI.getTaskManagerTask(t.task.id).then((res: any) => {
          if (!res.success || !res.data) return;
          const task = res.data;
          const newStatus = task.status.name;
          const newColor = task.status.color;
          const newRelease = task.releaseVersion;
          if (newStatus !== t.task!.status || newColor !== t.task!.statusColor || newRelease !== t.task!.releaseVersion) {
            useTerminalStore.getState().updateTerminal(t.id, {
              task: { ...t.task!, status: newStatus, statusColor: newColor, releaseVersion: newRelease },
            });
          }
        }).catch(() => {});
      }
    };
    refresh();
    const iv = setInterval(refresh, 60_000);
    return () => clearInterval(iv);
  }, []);

  // Lazy-mount: only render TerminalPanel once a group has been active
  const [mountedGroups, setMountedGroups] = useState<Set<string>>(new Set());

  // Filter terminals by current project
  const terminals = allTerminals.filter((t) => t.projectId === projectId);

  // Derive group IDs in order
  const groupIds = (() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of terminals) {
      if (!seen.has(t.groupId)) {
        seen.add(t.groupId);
        result.push(t.groupId);
      }
    }
    return result;
  })();

  // Terminals in the active group

  // Inline tab rename state
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);

  // Drag-and-drop reorder state (tabs)
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const reorderGroups = useTerminalStore((s) => s.reorderGroups);

  // Drag-and-drop reorder state (split panels within a group)
  const [dragTerminalId, setDragTerminalId] = useState<string | null>(null);
  const [dragOverTerminalId, setDragOverTerminalId] = useState<string | null>(null);
  const reorderTerminalsInGroup = useTerminalStore((s) => s.reorderTerminalsInGroup);

  // Tree sidebar — search + collapsed categories (persisted)
  const [treeSearch, setTreeSearch] = useState('');
  const TREE_COLLAPSED_KEY = 'terminal-tree-collapsed';
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(TREE_COLLAPSED_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set();
  });
  const toggleCategory = useCallback((name: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      try { localStorage.setItem(TREE_COLLAPSED_KEY, JSON.stringify(Array.from(next))); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Tree sidebar width — draggable splitter, persisted across sessions.
  // 240px matches the original w-60 default so existing users see no shift.
  const TREE_WIDTH_KEY = 'terminal-tree-width';
  const TREE_WIDTH_MIN = 160;
  const TREE_WIDTH_MAX = 560;
  const TREE_WIDTH_DEFAULT = 240;
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(TREE_WIDTH_KEY);
      const parsed = raw ? Number(raw) : NaN;
      if (Number.isFinite(parsed) && parsed >= TREE_WIDTH_MIN && parsed <= TREE_WIDTH_MAX) return parsed;
    } catch { /* ignore */ }
    return TREE_WIDTH_DEFAULT;
  });
  const [resizingTree, setResizingTree] = useState(false);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const handleTreeResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizingTree(true);
    const startX = e.clientX;
    const startWidth = treeContainerRef.current?.getBoundingClientRect().width ?? treeWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, startWidth + (ev.clientX - startX)));
      setTreeWidth(next);
    };
    const onUp = () => {
      setResizingTree(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Read final value off state via the ref-style trick: schedule a write
      // after React commits the new state. Cheap to write in the move handler
      // too, but throttling to one write per drag keeps localStorage quiet.
      const finalWidth = treeContainerRef.current?.getBoundingClientRect().width;
      if (finalWidth) {
        try { localStorage.setItem(TREE_WIDTH_KEY, String(Math.round(finalWidth))); } catch { /* ignore */ }
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [treeWidth]);
  const handleTreeResizeDoubleClick = useCallback(() => {
    setTreeWidth(TREE_WIDTH_DEFAULT);
    try { localStorage.setItem(TREE_WIDTH_KEY, String(TREE_WIDTH_DEFAULT)); } catch { /* ignore */ }
  }, []);

  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const [taskPickerMode, setTaskPickerMode] = useState<'tab' | 'split' | 'link'>('tab');
  const [linkTargetTerminalId, setLinkTargetTerminalId] = useState<string | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const newMenuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showNewMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        newMenuRef.current && !newMenuRef.current.contains(target) &&
        menuTriggerRef.current && !menuTriggerRef.current.contains(target)
      ) {
        setShowNewMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNewMenu]);

  const openNewMenu = useCallback(() => {
    if (menuTriggerRef.current) {
      const rect = menuTriggerRef.current.getBoundingClientRect();
      // Trigger lives at the bottom of the sidebar — pop the menu upward.
      const MENU_HEIGHT = 80; // ~2 items × ~36px + padding
      setMenuPos({ top: Math.max(8, rect.top - MENU_HEIGHT - 4), left: rect.left });
    }
    setShowNewMenu((v) => !v);
  }, []);

  // Auto-select group from current project when switching projects
  const groupIdsKey = groupIds.join(',');
  useEffect(() => {
    if (!activeGroupId || !groupIds.includes(activeGroupId)) {
      if (groupIds.length > 0) {
        setActiveGroup(groupIds[groupIds.length - 1]);
      }
    }
  }, [projectId, groupIdsKey]);

  // Mark active group as mounted (lazy-mount for xterm stability)
  useEffect(() => {
    if (activeGroupId && !mountedGroups.has(activeGroupId)) {
      setMountedGroups((prev) => new Set(prev).add(activeGroupId));
    }
  }, [activeGroupId]);

  // Get active project path for cwd
  const activeProject = useProjectStore((s) => {
    if (!projectId) return undefined;
    return s.projects.find((p) => p.id === projectId);
  });
  const addProjectAction = useProjectStore((s) => s.addProject);

  // Git branch + fetch/pull state
  const [currentBranch, setCurrentBranch] = useState<string>('');
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [pullStatus, setPullStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  // Which side panel is open: docs repo files, project source tree, or none.
  const [filesPanel, setFilesPanel] = useState<'docs' | 'project' | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [behindCount, setBehindCount] = useState<number>(0);
  const [pullMessage, setPullMessage] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Fetch current branch for active project
  const refreshBranch = useCallback(async () => {
    if (!activeProject?.path) { setCurrentBranch(''); setBehindCount(0); return; }
    try {
      const result = await window.electronAPI.listBranches(activeProject.path);
      if (result.success && result.current) setCurrentBranch(result.current);
      else setCurrentBranch('');
    } catch { setCurrentBranch(''); }
  }, [activeProject?.path]);

  useEffect(() => {
    refreshBranch();
    const interval = setInterval(refreshBranch, 15000);
    return () => clearInterval(interval);
  }, [refreshBranch]);

  // Auto-fetch from remote when project becomes active (app start / project switch)
  useEffect(() => {
    if (!activeProject?.path) return;
    (async () => {
      try {
        const result = await window.electronAPI.gitFetch(activeProject.path);
        if (result.success && typeof result.behindCount === 'number') {
          setBehindCount(result.behindCount);
        }
      } catch { /* ignore */ }
    })();
  }, [activeProject?.path]);

  const handleGitFetch = useCallback(async () => {
    if (!activeProject?.path || fetchStatus === 'loading') return;
    setFetchStatus('loading');
    try {
      const result = await window.electronAPI.gitFetch(activeProject.path);
      setFetchStatus(result.success ? 'success' : 'error');
      if (result.success && typeof result.behindCount === 'number') {
        setBehindCount(result.behindCount);
      }
      refreshBranch();
    } catch {
      setFetchStatus('error');
    }
    setTimeout(() => setFetchStatus('idle'), 2000);
  }, [activeProject?.path, fetchStatus, refreshBranch]);

  const handleGitPull = useCallback(async () => {
    if (!activeProject?.path || pullStatus === 'loading') return;
    setPullStatus('loading');
    try {
      const result = await window.electronAPI.gitPull(activeProject.path);
      if (result.success) {
        setPullStatus('success');
        setBehindCount(0);
        if (result.alreadyUpToDate) {
          setPullMessage({ message: 'Already up to date', type: 'success' });
        } else {
          const n = result.commitsPulled || 0;
          setPullMessage({ message: `Pulled ${n} commit${n !== 1 ? 's' : ''}`, type: 'success' });
        }
      } else {
        setPullStatus('error');
        setPullMessage({ message: result.error || 'Pull failed', type: 'error' });
      }
      refreshBranch();
    } catch {
      setPullStatus('error');
      setPullMessage({ message: 'Pull failed', type: 'error' });
    }
    setTimeout(() => setPullStatus('idle'), 2000);
    setTimeout(() => setPullMessage(null), 5000);
  }, [activeProject?.path, pullStatus, refreshBranch]);

  /** Setup a terminal with task info, optionally create worktree, create PTY, and optionally start Claude.
   *  When `cwdOverride` is set, uses that directory as-is and skips worktree creation —
   *  used by the Kanban restore path so we resume the agent from the same cwd the
   *  session was created in (otherwise Claude can't find the conversation file). */
  const setupTerminalWithTask = useCallback(
    async (
      terminal: { id: string },
      task?: TaskManagerTask,
      useWorktree = true,
      cwdOverride?: { cwd: string; worktreePath?: string; worktreeBranch?: string },
    ) => {
      let cwd = cwdOverride?.cwd || activeProject?.path || '';

      if (task) {
        const taskLabel = task.customId || task.id;
        const title = task.name.length > 30
          ? `${taskLabel} · ${task.name.slice(0, 30)}...`
          : `${taskLabel} · ${task.name}`;
        const terminalTask: TerminalTask = {
          id: task.id,
          customId: task.customId,
          name: task.name,
          status: task.status.name,
          statusColor: task.status.color,
          releaseVersion: task.releaseVersion,
          url: task.url,
          provider: task.provider,
        };

        // If this ClickUp task is already on the Kanban board, honor the
        // baseBranch the user picked at import time. Otherwise the worktree
        // falls through to origin/HEAD inside the IPC handler, which produces
        // a worktree forked from the wrong branch (and the eventual auto-code
        // PR ends up full of unrelated commits — see DP2-24681).
        const kanbanTask = useKanbanStore.getState().tasks.find((t) => t.clickupTaskId === task.id);
        const taskBaseBranch = kanbanTask?.baseBranch || undefined;

        if (cwdOverride) {
          useTerminalStore.getState().updateTerminal(terminal.id, {
            title,
            task: terminalTask,
            cwd,
            worktreePath: cwdOverride.worktreePath,
            worktreeBranch: cwdOverride.worktreeBranch,
          });
        } else {
          // Fresh task terminal — don't create a worktree yet. The Start button
          // decides worktree vs current branch at launch and creates the
          // worktree on demand only if the user picks it. The PTY opens at the
          // project root either way; `claude --worktree` (added at Start) cd's
          // into the worktree when that mode is chosen.
          useTerminalStore.getState().updateTerminal(terminal.id, { title, task: terminalTask });
        }

        // Fetch existing tracked time as initial elapsed (with today breakdown)
        try {
          const timeResult = await window.electronAPI.getTaskTimeEntries(task.id);
          if (timeResult.success && timeResult.data) {
            const today = new Date().toISOString().slice(0, 10);
            useTerminalStore.getState().updateTerminal(terminal.id, {
              timeTracking: {
                startedAt: null,
                elapsed: timeResult.data.totalMs || 0,
                todayMs: timeResult.data.todayMs || 0,
                todayDate: today,
              },
            });
          }
        } catch { /* non-critical */ }

        // Base branch: prefer the kanban task's stored selection (so merge/PR
        // target matches the worktree fork point). Fall back to the project's
        // current branch.
        if (taskBaseBranch) {
          useTerminalStore.getState().updateTerminal(terminal.id, { baseBranch: taskBaseBranch });
        } else {
          try {
            const brResult = await window.electronAPI.listBranches(activeProject?.path || cwd);
            if (brResult.success) {
              const base = brResult.current || undefined;
              if (base) {
                useTerminalStore.getState().updateTerminal(terminal.id, { baseBranch: base });
              }
            }
          } catch { /* non-critical */ }
        }
      }

      await window.electronAPI.createTerminal({
        id: terminal.id,
        cwd,
        cols: 80,
        rows: 24,
      });

      // Ensure a KanbanTask exists for this ClickUp task — idempotent on the
      // main side, so repeated calls just refresh the snapshot. Means every
      // terminal with a task shows up on the Kanban board. Pass useWorktree
      // through so the picker's "Current Branch" choice persists onto the
      // KanbanTask — otherwise reopening from the board would create a
      // worktree the user explicitly opted out of.
      if (task && activeProject?.path) {
        try {
          await useKanbanStore.getState().importTask({
            clickupTask: task,
            projectPath: activeProject.path,
            projectId: activeProject.id,
            useWorktree,
          });
        } catch { /* non-critical */ }
      }

      // Task context is available but not auto-sent — user inputs manually
    },
    [activeProject]
  );

  /** Link an existing terminal to a task (no PTY creation, no worktree) */
  const linkTaskToTerminal = useCallback(
    async (terminalId: string, task: TaskManagerTask) => {
      const taskLabel = task.customId || task.id;
      const title = task.name.length > 30
        ? `${taskLabel} · ${task.name.slice(0, 30)}...`
        : `${taskLabel} · ${task.name}`;
      const terminalTask: TerminalTask = {
        id: task.id,
        customId: task.customId,
        name: task.name,
        status: task.status.name,
        statusColor: task.status.color,
        releaseVersion: task.releaseVersion,
        url: task.url,
        provider: task.provider,
      };

      useTerminalStore.getState().updateTerminal(terminalId, { title, task: terminalTask });

      // Fetch existing tracked time as initial elapsed (with today breakdown)
      try {
        const timeResult = await window.electronAPI.getTaskTimeEntries(task.id);
        if (timeResult.success && timeResult.data) {
          const today = new Date().toISOString().slice(0, 10);
          useTerminalStore.getState().updateTerminal(terminalId, {
            timeTracking: {
              startedAt: null,
              elapsed: timeResult.data.totalMs || 0,
              todayMs: timeResult.data.todayMs || 0,
              todayDate: today,
            },
          });
        }
      } catch { /* non-critical */ }

      // Auto-detect base branch — use current branch as default
      try {
        const t = useTerminalStore.getState().terminals.find((x) => x.id === terminalId);
        const cwd = t?.cwd || activeProject?.path || '';
        if (cwd) {
          const brResult = await window.electronAPI.listBranches(cwd);
          if (brResult.success && brResult.current) {
            useTerminalStore.getState().updateTerminal(terminalId, { baseBranch: brResult.current });
          }
        }
      } catch { /* non-critical */ }

      // Mirror the link into the Kanban board — idempotent on the main side.
      // Derive useWorktree from the linked terminal's actual state: if it
      // already has a worktreePath we're in worktree mode, otherwise we're
      // running on the project's checked-out branch. Keeps the KanbanTask
      // record consistent with what the user is actually working in.
      if (activeProject?.path) {
        try {
          const linkedTerm = useTerminalStore.getState().terminals.find((t) => t.id === terminalId);
          await useKanbanStore.getState().importTask({
            clickupTask: task,
            projectPath: activeProject.path,
            projectId: activeProject.id,
            useWorktree: !!linkedTerm?.worktreePath,
          });
        } catch { /* non-critical */ }
      }
    },
    [activeProject]
  );

  /** Create a terminal in a new tab, optionally with a task */
  const createTerminalNewTab = useCallback(
    async (task?: TaskManagerTask, useWorktree = true) => {
      if (!canAddTerminal()) return;
      const terminal = addTerminal(activeProject?.path, projectId);
      if (!terminal) return;
      await setupTerminalWithTask(terminal, task, useWorktree);
    },
    [addTerminal, canAddTerminal, activeProject, projectId, setupTerminalWithTask]
  );

  /** Create a terminal in the current group (split), optionally with task */
  const createTerminalSplit = useCallback(
    async (task?: TaskManagerTask, useWorktree = true) => {
      if (!canAddTerminal()) return;
      if (!activeGroupId) {
        createTerminalNewTab(task, useWorktree);
        return;
      }
      const terminal = splitTerminal(activeProject?.path, projectId);
      if (!terminal) return;
      await setupTerminalWithTask(terminal, task, useWorktree);
    },
    [splitTerminal, canAddTerminal, activeProject, projectId, activeGroupId, createTerminalNewTab, setupTerminalWithTask]
  );

  const handleNewTerminal = useCallback(() => {
    if (!canAddTerminal()) return;
    if (settings.taskManagerProvider !== 'none') {
      setTaskPickerMode('tab');
      setShowTaskPicker(true);
    } else {
      createTerminalNewTab();
    }
  }, [canAddTerminal, settings.taskManagerProvider, createTerminalNewTab]);

  // Listen for Ctrl+N shortcut from App
  useEffect(() => {
    const handler = () => handleNewTerminal();
    window.addEventListener('agent-terminal:new-terminal', handler);
    return () => window.removeEventListener('agent-terminal:new-terminal', handler);
  }, [handleNewTerminal]);

  // Listen for Kanban card clicks — create (or reuse) a terminal with the task
  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;

      // Already have a terminal for this ClickUp task? Focus it.
      const existing = useTerminalStore
        .getState()
        .terminals.find((t) => t.task?.id === detail.clickupTaskId);
      if (existing) {
        useTerminalStore.getState().setActiveTerminal(existing.id);
        return;
      }

      if (!canAddTerminal()) return;
      const kanbanProjectId = detail.projectId || projectId;
      const kanbanProjectPath = detail.projectPath || activeProject?.path;
      const terminal = addTerminal(kanbanProjectPath, kanbanProjectId);
      if (!terminal) return;

      // Build a TaskManagerTask-shaped payload from the KanbanTask snapshot
      const taskForSetup: TaskManagerTask = {
        id: detail.clickupTaskId,
        customId: detail.clickupCustomId,
        name: detail.clickupName,
        status: { name: detail.clickupStatus, color: detail.clickupStatusColor || '#888' },
        priority: detail.clickupPriority,
        assignees: (detail.clickupAssignees || []).map((a: any) => ({
          id: a.id,
          username: a.username,
          initials: a.initials,
        })),
        tags: detail.clickupTags || [],
        url: detail.clickupUrl,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
        providerTaskId: detail.clickupTaskId,
        provider: 'clickup',
      };

      const projectPath = detail.projectPath || activeProject?.path || '';
      const worktreeName = (detail.clickupCustomId || detail.clickupTaskId).replace(/[^a-zA-Z0-9_-]/g, '-');
      const sep = projectPath.includes('\\') ? '\\' : '/';
      const legacyWorktreePath = projectPath ? `${projectPath}${sep}.task-worktrees${sep}${worktreeName}` : '';
      const nativeWorktreePath = projectPath ? `${projectPath}${sep}.claude${sep}worktrees${sep}${worktreeName}` : '';

      // Probe candidate cwds — sessions live wherever they were originally
      // started. On resume we cd into the matched location (no --worktree
      // since that flag only finds sessions inside its own scope).
      const resolved = await resolveSessionCwd(
        detail.agentSessionId,
        buildSessionCandidates({
          agentCwd: detail.agentCwd,
          worktreePath: detail.worktreePath,
          nativeWorktreePath: nativeWorktreePath || undefined,
          computedWorktreePath: legacyWorktreePath || undefined,
          projectPath: projectPath || undefined,
        }),
      );

      if (resolved) {
        await setupTerminalWithTask(terminal, taskForSetup, false, {
          cwd: resolved.cwd,
          worktreePath: resolved.isWorktree ? resolved.cwd : undefined,
          worktreeBranch: resolved.isWorktree ? detail.worktreeBranch : undefined,
        });
      } else {
        // Honor the task's saved workspace choice — a "Current branch" task
        // must not be forced into a worktree here.
        await setupTerminalWithTask(terminal, taskForSetup, detail.useWorktree !== false);
      }

      // Carry over session + agent provider from the KanbanTask if we have them
      const patch: Partial<typeof terminal> = {};
      if (detail.agentSessionId) patch.agentSessionId = detail.agentSessionId;
      if (detail.agentProvider) patch.agentProvider = detail.agentProvider;
      if (Object.keys(patch).length > 0) {
        useTerminalStore.getState().updateTerminal(terminal.id, patch);
      }

      if (detail.agentSessionId && resolved) {
        const agentId = detail.agentProvider || 'claude';
        const cwd = useTerminalStore.getState().terminals.find((t) => t.id === terminal.id)?.cwd || '';
        try {
          await window.electronAPI.resumeAgent(terminal.id, agentId, {
            sessionId: detail.agentSessionId,
            cwd,
          });
          useTerminalStore.getState().updateTerminal(terminal.id, {
            isClaudeMode: true,
            status: 'claude-active',
          });
        } catch {
          /* Resume failed — terminal stays in idle shell mode, user can start manually */
        }
      }
    };
    window.addEventListener('agent-terminal:open-kanban-task', handler as EventListener);
    return () => window.removeEventListener('agent-terminal:open-kanban-task', handler as EventListener);
  }, [canAddTerminal, addTerminal, setupTerminalWithTask, activeProject, projectId]);

  const handleNewSplit = useCallback(() => {
    if (!canAddTerminal()) return;
    if (settings.taskManagerProvider !== 'none') {
      setTaskPickerMode('split');
      setShowTaskPicker(true);
    } else {
      createTerminalSplit();
    }
  }, [canAddTerminal, settings.taskManagerProvider, createTerminalSplit]);

  /** Sync timer to task manager for a terminal if it has a running timer, split by date */
  const syncTimerBeforeClose = useCallback(async (terminal: { id: string; task?: TerminalTask; timeTracking?: { startedAt: number | null; elapsed: number; todayMs?: number; todayDate?: string } }) => {
    if (!terminal.timeTracking || !terminal.task) return;
    const { startedAt } = terminal.timeTracking;
    // Only post the current running session (paused time was already posted on stop)
    if (startedAt) {
      const now = Date.now();
      const sessionMs = now - startedAt;
      if (sessionMs > 0) {
        try {
          await postTimeEntriesByDate(terminal.task.id, startedAt, now);
        } catch { /* non-critical */ }
      }
    }
  }, []);

  const handleCloseGroup = useCallback(
    async (groupId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const groupTerminals = allTerminals.filter((t) => t.groupId === groupId);
      for (const t of groupTerminals) {
        await syncTimerBeforeClose(t);
        await window.electronAPI.destroyTerminal(t.id);
      }
      removeGroup(groupId);
    },
    [allTerminals, removeGroup, syncTimerBeforeClose]
  );

  const handleCloseTerminal = useCallback(
    async (id: string) => {
      const terminal = allTerminals.find((t) => t.id === id);
      if (terminal) await syncTimerBeforeClose(terminal);
      await window.electronAPI.destroyTerminal(id);
      removeTerminal(id);
    },
    [allTerminals, removeTerminal, syncTimerBeforeClose]
  );

  const [cliError, setCliError] = useState<string | null>(null);

  const handleInvokeAgent = useCallback(async (id: string, opts?: { skipPermissions?: boolean; mode?: 'worktree' | 'current' }) => {
    const terminal = useTerminalStore.getState().getTerminal(id);
    if (!terminal) return;
    const skipPermissions = opts?.skipPermissions;
    const agentId = terminal.agentProvider;
    const settings = useSettingsStore.getState().settings;
    // Project model override > app-wide model
    const model = activeProject?.agentModel || settings.agentModels?.[agentId] || undefined;

    // Worktree vs current branch is decided HERE, at Start. Default to the
    // task's saved preference; an explicit Start-menu pick overrides it. Only
    // Claude supports the --worktree flag, and only task terminals get one.
    const kanbanTask = terminal.task
      ? useKanbanStore.getState().tasks.find((t) => t.clickupTaskId === terminal.task!.id)
      : undefined;
    // Default is always current branch ("normal"); a worktree is only used when
    // explicitly picked from the Start/YOLO dropdown for this launch.
    const mode: 'worktree' | 'current' = opts?.mode ?? 'current';
    const canWorktree = !!terminal.task && agentId === 'claude' && !!activeProject;

    let worktreeName: string | undefined;
    if (mode === 'worktree' && canWorktree) {
      const safeId = (terminal.task!.customId || terminal.task!.id).replace(/[^a-zA-Z0-9_-]/g, '-');
      // Create the worktree on demand if it isn't there yet, so git ops resolve
      // against it and `claude --worktree` reuses it.
      let wtPath = terminal.worktreePath;
      let wtBranch = terminal.worktreeBranch;
      if (!wtPath) {
        try {
          const wt = await window.electronAPI.createTaskWorktree(activeProject!.path, safeId, kanbanTask?.baseBranch);
          if (wt?.success && wt.data) { wtPath = wt.data; wtBranch = wt.branch || wtBranch; }
        } catch { /* fall back to project root — claude --worktree creates it */ }
      }
      useTerminalStore.getState().updateTerminal(id, { worktreePath: wtPath, worktreeBranch: wtBranch });
      worktreeName = safeId;
    } else {
      // Current branch: unbind any worktree so git ops target the checked-out tree.
      useTerminalStore.getState().updateTerminal(id, { worktreePath: undefined, worktreeBranch: undefined });
    }

    // Remember the choice as this task's default for next time.
    if (kanbanTask) void useKanbanStore.getState().updateTask(kanbanTask.id, { useWorktree: mode === 'worktree' });

    const result = await window.electronAPI.invokeAgent(id, agentId, {
      cwd: activeProject?.path,
      skipPermissions,
      model,
      worktreeName,
    });
    if (result.success) {
      useTerminalStore.getState().setClaudeMode(id, true);
      // Show "Starting agent..." overlay while agent initializes
      useTerminalStore.getState().updateTerminal(id, { isResuming: true });
      setTimeout(() => {
        useTerminalStore.getState().updateTerminal(id, { isResuming: false });
      }, 6000);
      if (skipPermissions) {
        useTerminalStore.getState().updateTerminal(id, { skipPermissions: true });
      }
      // Send task context as first prompt if terminal is linked to a task
      if (terminal.task) {
        const taskId = terminal.task.id;
        window.electronAPI.getTaskManagerTask(taskId).then((taskResult: any) => {
          if (!taskResult.success || !taskResult.data) return;
          const task = taskResult.data;
          const taskLabel = task.customId || task.id;
          const parts = [
            `I'm working on task ${taskLabel}: ${task.name}`,
            `Status: ${task.status.name}`,
          ];
          if (task.priority) parts.push(`Priority: ${task.priority.name}`);
          if (task.description) {
            const desc = task.description.length > 1000
              ? task.description.slice(0, 1000) + '...'
              : task.description;
            parts.push(`Description:\n${desc}`);
          }
          if (task.url) parts.push(`URL: ${task.url}`);
          const prompt = parts.join('\n');
          setTimeout(() => {
            sendAgentPrompt(id, prompt);
          }, 3000);
        }).catch(() => { /* non-critical */ });
      }
    } else {
      setCliError(result.error || `Failed to start ${agentId}`);
      setTimeout(() => setCliError(null), 8000);
    }
  }, [activeProject]);

  const handleLinkTask = useCallback((terminalId: string) => {
    setLinkTargetTerminalId(terminalId);
    setTaskPickerMode('link');
    setShowTaskPicker(true);
  }, []);

  const handleProviderChange = useCallback((id: string, provider: import('../../../shared/types').AgentProviderId) => {
    useTerminalStore.getState().setAgentProvider(id, provider);
  }, []);

  // Cached branch list for base branch picker
  const [projectBranches, setProjectBranches] = useState<string[]>([]);
  useEffect(() => {
    if (!activeProject?.path) { setProjectBranches([]); return; }
    window.electronAPI.listBranches(activeProject.path)
      .then((r: any) => {
        if (r.success && r.branches) {
          const priority = ['main', 'master', 'develop', 'dev'];
          const sorted = [...r.branches].sort((a: string, b: string) => {
            const ai = priority.indexOf(a);
            const bi = priority.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
          });
          setProjectBranches(sorted);
        }
      })
      .catch(() => {});
  }, [activeProject?.path]);

  const handleBaseBranchChange = useCallback((terminalId: string, branch: string) => {
    useTerminalStore.getState().updateTerminal(terminalId, { baseBranch: branch });
  }, []);

  // Merge manual project skills with auto-loaded .claude/skills
  const [claudeSkills, setClaudeSkills] = useState<import('../../../shared/types').ProjectSkill[]>([]);
  useEffect(() => {
    if (!activeProject?.path) { setClaudeSkills([]); return; }
    window.electronAPI.loadClaudeSkills(activeProject.path)
      .then((result: any) => {
        if (result?.success && result.data) setClaudeSkills(result.data);
      })
      .catch(() => {});
  }, [activeProject?.path]);

  const projectSkills = [
    ...(activeProject?.skills || []),
    ...claudeSkills,
  ];

  const handleInvokeSkill = useCallback(async (terminalId: string, skill: import('../../../shared/types').ProjectSkill) => {
    const terminal = useTerminalStore.getState().getTerminal(terminalId);
    if (!terminal) return;

    // Override provider if skill specifies one
    if (skill.agentProvider && skill.agentProvider !== terminal.agentProvider) {
      useTerminalStore.getState().setAgentProvider(terminalId, skill.agentProvider);
    }

    if (!terminal.isClaudeMode) {
      // Invoke agent first, then send skill prompt after it starts
      await handleInvokeAgent(terminalId);
      setTimeout(() => {
        // Don't submit — leave the (possibly multi-line) prompt in the input
        // for the user to review/edit before sending.
        sendAgentPrompt(terminalId, skill.prompt, { submit: false });
      }, 3000);
    } else {
      // Agent already running — send prompt directly (no auto-submit)
      sendAgentPrompt(terminalId, skill.prompt, { submit: false });
    }
  }, [handleInvokeAgent]);

  const { openCompleteTask, modal: completeTaskModal, statusBanner: completeTaskBanner } = useCompleteTaskFlow(
    activeProject ? { path: activeProject.path } : null,
    settings.taskManagerProvider !== 'none',
  );

  // Derive sidebar categories from the raw ClickUp status (1-1 with the Kanban
  // board columns). Each distinct status becomes a group; terminals without a
  // task fall into "No task". Order follows the board's ClickUp status order
  // (kanbanStatuses); statuses not in that list sort after the known ones, with
  // "No task" pinned to the very end.
  const NO_TASK_KEY = '__no_task__';
  const statusOrder = useMemo(() => {
    const m = new Map<string, number>();
    kanbanStatuses.forEach((s, i) => m.set(s.name.trim().toLowerCase(), i));
    return m;
  }, [kanbanStatuses]);
  const treeQuery = treeSearch.trim().toLowerCase();
  const categories = (() => {
    type Entry = { key: string; name: string; color?: string; groupIds: string[] };
    const map = new Map<string, Entry>();
    for (const groupId of groupIds) {
      const groupTerminals = terminals.filter((t) => t.groupId === groupId);
      const first = groupTerminals[0];
      if (!first) continue;
      if (treeQuery) {
        const cid = first.task?.customId?.toLowerCase() || '';
        if (!cid.includes(treeQuery)) continue;
      }

      let key: string;
      let name: string;
      let color: string | undefined;
      const rawStatus = (first.task?.status || '').trim();
      if (!first.task || !rawStatus) {
        key = NO_TASK_KEY;
        name = 'No task';
      } else {
        key = rawStatus.toLowerCase();
        name = rawStatus;
        color = first.task.statusColor;
      }

      let entry = map.get(key);
      if (!entry) {
        entry = { key, name, color, groupIds: [] };
        map.set(key, entry);
      }
      entry.groupIds.push(groupId);
    }

    const UNKNOWN = statusOrder.size + 1000; // unknown statuses after known ones
    const orderIndex = (key: string): number => {
      if (key === NO_TASK_KEY) return Number.MAX_SAFE_INTEGER;
      const i = statusOrder.get(key);
      return i !== undefined ? i : UNKNOWN;
    };
    return Array.from(map.values())
      .filter((c) => c.key === NO_TASK_KEY || !hiddenStatusSet.has(c.key))
      .sort((a, b) => orderIndex(a.key) - orderIndex(b.key) || a.name.localeCompare(b.name));
  })();

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Task picker modal */}
      {showTaskPicker && (
        <TaskPickerModal
          mode={taskPickerMode === 'link' ? 'link' : 'new'}
          onSelect={(task, useWorktree) => {
            setShowTaskPicker(false);
            if (taskPickerMode === 'link' && linkTargetTerminalId) {
              linkTaskToTerminal(linkTargetTerminalId, task);
              setLinkTargetTerminalId(null);
            } else {
              taskPickerMode === 'split' ? createTerminalSplit(task, useWorktree) : createTerminalNewTab(task, useWorktree);
            }
          }}
          onPlain={() => {
            setShowTaskPicker(false);
            setLinkTargetTerminalId(null);
            taskPickerMode === 'split' ? createTerminalSplit() : createTerminalNewTab();
          }}
          onCancel={() => { setShowTaskPicker(false); setLinkTargetTerminalId(null); }}
        />
      )}

      {/* Complete task modal — driven by useCompleteTaskFlow */}
      {completeTaskModal}

      {/* Header */}
      <div className="h-12 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center px-4 justify-between drag-region shrink-0">
        <div className="flex items-center gap-2 no-drag">
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">
            {activeProject ? activeProject.name : 'Agent Terminal'}
          </h1>
          {activeProject && (
            <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[300px]" title={activeProject.path}>
              {activeProject.path}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 no-drag">
          {activeProject && (
            <div className="flex items-center gap-1">
              {currentBranch && (
                <span className="flex items-center gap-1 px-2 h-7 text-[11px] text-[var(--accent)] shrink-0" title={`Branch: ${currentBranch}`}>
                  <GitBranch className="w-3 h-3" />
                  <span className="truncate max-w-[120px]">{currentBranch}</span>
                </span>
              )}
              <button
                onClick={handleGitFetch}
                disabled={fetchStatus === 'loading'}
                title={behindCount > 0 ? `Fetch latest from remote (${behindCount} commit${behindCount !== 1 ? 's' : ''} behind)` : 'Fetch latest from remote'}
                className={cn(
                  'flex items-center gap-1 px-2 h-7 rounded-md text-[11px] transition-all',
                  'hover:bg-[var(--bg-tertiary)] border border-transparent',
                  fetchStatus === 'loading' && 'opacity-60 cursor-wait',
                  fetchStatus === 'success' && 'text-green-500 border-green-500/20 bg-green-500/10',
                  fetchStatus === 'error' && 'text-red-500 border-red-500/20 bg-red-500/10',
                  fetchStatus === 'idle' && 'text-[var(--text-muted)]',
                )}
              >
                <RefreshCw className={cn('w-3 h-3', fetchStatus === 'loading' && 'animate-spin')} />
                <span>Fetch</span>
                {behindCount > 0 && (
                  <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none bg-[var(--accent)] text-white">
                    {behindCount}
                  </span>
                )}
              </button>
              <button
                onClick={handleGitPull}
                disabled={pullStatus === 'loading'}
                title="Pull latest from remote"
                className={cn(
                  'flex items-center gap-1 px-2 h-7 rounded-md text-[11px] transition-all',
                  'hover:bg-[var(--bg-tertiary)] border border-transparent',
                  pullStatus === 'loading' && 'opacity-60 cursor-wait',
                  pullStatus === 'success' && 'text-green-500 border-green-500/20 bg-green-500/10',
                  pullStatus === 'error' && 'text-red-500 border-red-500/20 bg-red-500/10',
                  pullStatus === 'idle' && 'text-[var(--text-muted)]',
                )}
              >
                <Download className={cn('w-3 h-3', pullStatus === 'loading' && 'animate-bounce')} />
                <span>Pull</span>
              </button>
              {activeProject?.docsPath && (
                <button
                  onClick={() => setFilesPanel((p) => (p === 'docs' ? null : 'docs'))}
                  title={filesPanel === 'docs' ? 'Close documents panel' : 'Open project documents'}
                  className={cn(
                    'flex items-center gap-1 px-2 h-7 rounded-md text-[11px] transition-all',
                    'hover:bg-[var(--bg-tertiary)] border border-transparent',
                    filesPanel === 'docs'
                      ? 'text-amber-400 border-amber-500/20 bg-amber-500/10'
                      : 'text-[var(--text-muted)]',
                  )}
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>Documents</span>
                </button>
              )}
              {activeProject?.path && (
                <button
                  onClick={() => setFilesPanel((p) => (p === 'project' ? null : 'project'))}
                  title={filesPanel === 'project' ? 'Close project files panel' : 'Browse the project source files'}
                  className={cn(
                    'flex items-center gap-1 px-2 h-7 rounded-md text-[11px] transition-all',
                    'hover:bg-[var(--bg-tertiary)] border border-transparent',
                    filesPanel === 'project'
                      ? 'text-amber-400 border-amber-500/20 bg-amber-500/10'
                      : 'text-[var(--text-muted)]',
                  )}
                >
                  <FolderOpen className="w-3 h-3" />
                  <span>Files</span>
                </button>
              )}
              {projectSkills.length > 0 && (
                <button
                  onClick={() => setSkillsOpen((v) => !v)}
                  title={skillsOpen ? 'Close skills panel' : 'Open skills panel'}
                  className={cn(
                    'flex items-center gap-1 px-2 h-7 rounded-md text-[11px] transition-all',
                    'hover:bg-[var(--bg-tertiary)] border border-transparent',
                    skillsOpen
                      ? 'text-violet-400 border-violet-500/20 bg-violet-500/10'
                      : 'text-[var(--text-muted)]',
                  )}
                >
                  <Zap className="w-3 h-3" />
                  <span>Skills</span>
                </button>
              )}
            </div>
          )}
          <SystemMonitor />
          <ServiceStatusIndicator />
          <UsageIndicator />
          <span className="text-xs text-[var(--text-muted)]">
            {terminals.filter((t) => t.status !== 'exited').length}/
            {settings.maxTerminals || useTerminalStore.getState().maxTerminals}
          </span>
        </div>
      </div>

      {/* CLI error notification */}
      {cliError && (
        <div className="px-4 py-2 text-xs flex items-center justify-between shrink-0 bg-red-500/20 text-red-400 border-b border-red-500/30">
          <span>{cliError}</span>
          <button onClick={() => setCliError(null)} className="hover:opacity-70">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Merge status notification — from useCompleteTaskFlow */}
      {completeTaskBanner}

      {/* Pull status notification */}
      {pullMessage && (
        <div className={cn(
          'px-4 py-2 text-xs flex items-center justify-between shrink-0',
          pullMessage.type === 'success'
            ? 'bg-emerald-500/20 text-emerald-400 border-b border-emerald-500/30'
            : 'bg-red-500/20 text-red-400 border-b border-red-500/30'
        )}>
          <span>{pullMessage.message}</span>
          <button onClick={() => setPullMessage(null)} className="hover:opacity-70">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Terminal panels + optional files panel */}
      <div className="flex-1 flex min-h-0 relative">
      {resizingTree && (
        <div className="absolute inset-0 z-50 cursor-col-resize" />
      )}
      {/* Tree sidebar — categories grouped by task status, with task-ID search.
          Width is user-resizable via the handle to the right; persisted to localStorage. */}
      <div
        ref={treeContainerRef}
        style={{ width: treeWidth }}
        className="shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col min-h-0"
      >
        <div className="p-2 border-b border-[var(--border)] shrink-0">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              value={treeSearch}
              onChange={(e) => setTreeSearch(e.target.value)}
              placeholder="Search task ID..."
              className="w-full pl-7 pr-7 py-1.5 text-xs rounded-md bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)] transition-colors"
            />
            {treeSearch && (
              <button
                onClick={() => setTreeSearch('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]"
                title="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {categories.length === 0 ? (
            <div className="text-[11px] text-[var(--text-muted)] px-3 py-6 text-center">
              {treeSearch
                ? 'No tasks match'
                : !projectId
                  ? 'Open a project first'
                  : 'No terminals open'}
            </div>
          ) : (
            categories.map((cat) => {
              // Status groups share the Kanban board's collapse setting; the
              // "No task" group keeps its own local (localStorage) collapse.
              const isStatusCat = cat.key !== NO_TASK_KEY;
              const collapsed = isStatusCat
                ? collapsedStatusSet.has(cat.key)
                : collapsedCategories.has(cat.key);
              const onToggle = () => (isStatusCat ? toggleStatusCollapsed(cat.name) : toggleCategory(cat.key));
              return (
                <div key={cat.key} className="mb-0.5">
                  <button
                    onClick={onToggle}
                    className="w-full flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wide font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                  >
                    {collapsed
                      ? <ChevronRight className="w-3 h-3 shrink-0" />
                      : <ChevronDown className="w-3 h-3 shrink-0" />}
                    {cat.color && (
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: cat.color }}
                      />
                    )}
                    <span className="truncate flex-1 text-left">{cat.name}</span>
                    <span className="text-[var(--text-muted)] opacity-60 font-normal normal-case shrink-0">
                      {cat.groupIds.length}
                    </span>
                  </button>
                  {!collapsed && cat.groupIds.map((groupId) => {
                    const groupTerminals = terminals.filter((t) => t.groupId === groupId);
                    const firstTerminal = groupTerminals[0];
                    if (!firstTerminal) return null;
                    const isGroupSplit = groupTerminals.length > 1;
                    const hasClaudeActive = groupTerminals.some((t) => t.isClaudeMode);
                    const hasClaudeBusy = groupTerminals.some((t) => t.isClaudeBusy);
                    const isActive = activeGroupId === groupId;
                    return (
                      <div
                        key={groupId}
                        onClick={() => setActiveGroup(groupId)}
                        draggable
                        onDragStart={(e) => {
                          setDragGroupId(groupId);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', groupId);
                          if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.opacity = '0.5';
                          }
                        }}
                        onDragEnd={(e) => {
                          setDragGroupId(null);
                          setDragOverGroupId(null);
                          if (e.currentTarget instanceof HTMLElement) {
                            e.currentTarget.style.opacity = '1';
                          }
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (dragGroupId && dragGroupId !== groupId) {
                            setDragOverGroupId(groupId);
                          }
                        }}
                        onDragLeave={() => {
                          if (dragOverGroupId === groupId) setDragOverGroupId(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragGroupId && dragGroupId !== groupId) {
                            reorderGroups(projectId, dragGroupId, groupId);
                          }
                          setDragGroupId(null);
                          setDragOverGroupId(null);
                        }}
                        className={cn(
                          'group flex items-center gap-1.5 mx-1 pl-5 pr-1 py-1 rounded text-xs transition-all min-w-0 cursor-pointer',
                          'hover:bg-[var(--bg-tertiary)]',
                          isActive
                            ? 'bg-[var(--bg-card)] text-[var(--text-primary)] border border-[var(--border)]'
                            : 'text-[var(--text-secondary)]',
                          dragOverGroupId === groupId && dragGroupId !== groupId && 'ring-1 ring-[var(--accent)] ring-inset',
                        )}
                        style={isActive && firstTerminal.task
                          ? { backgroundColor: `${firstTerminal.task.statusColor}20` }
                          : undefined}
                      >
                        <GripVertical className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-40 cursor-grab active:cursor-grabbing transition-opacity -ml-1" />
                        {isGroupSplit ? (
                          <Columns2 className="w-3 h-3 shrink-0" />
                        ) : hasClaudeActive ? (
                          <Bot
                            className={cn(
                              'w-3 h-3 shrink-0',
                              hasClaudeBusy && 'animate-pulse text-[var(--accent)]'
                            )}
                          />
                        ) : (
                          <TerminalIcon className="w-3 h-3 shrink-0" />
                        )}
                        {firstTerminal.task?.customId && (
                          <span className="font-mono text-[10px] text-[var(--text-muted)] shrink-0">
                            {firstTerminal.task.customId}
                          </span>
                        )}
                        {firstTerminal.task?.releaseVersion && (
                          <span
                            className="font-mono-ui text-[9px] px-1 py-0.5 rounded shrink-0 flex items-center gap-0.5"
                            style={{ backgroundColor: 'rgba(34, 211, 238, 0.12)', color: 'var(--accent-2)' }}
                            title={`Release version: ${firstTerminal.task.releaseVersion}`}
                          >
                            <Rocket className="w-2.5 h-2.5" />
                            {firstTerminal.task.releaseVersion}
                          </span>
                        )}
                        {editingGroupId === groupId ? (
                          <input
                            className="bg-transparent text-xs text-[var(--text-primary)] outline-none border-b border-[var(--accent)] flex-1 min-w-0 py-0"
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const trimmed = editingTitle.trim();
                                if (trimmed) updateTerminal(firstTerminal.id, { title: trimmed });
                                setEditingGroupId(null);
                              } else if (e.key === 'Escape') {
                                setEditingGroupId(null);
                              }
                            }}
                            onBlur={() => {
                              const trimmed = editingTitle.trim();
                              if (trimmed) updateTerminal(firstTerminal.id, { title: trimmed });
                              setEditingGroupId(null);
                            }}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span
                            className="truncate flex-1"
                            title={firstTerminal.task ? `${firstTerminal.task.customId ? firstTerminal.task.customId + ' — ' : ''}${firstTerminal.task.name} [${firstTerminal.task.status}]` : firstTerminal.title}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setEditingGroupId(groupId);
                              setEditingTitle(firstTerminal.title);
                            }}
                          >
                            {firstTerminal.task?.name || firstTerminal.title}
                            {isGroupSplit && (
                              <span className="text-[var(--text-muted)] ml-1">+{groupTerminals.length - 1}</span>
                            )}
                          </span>
                        )}
                        {firstTerminal.status === 'exited' && !isGroupSplit && (
                          <span className="text-[9px] text-[var(--error)] shrink-0">exited</span>
                        )}
                        <button
                          className="w-4 h-4 shrink-0 rounded opacity-0 group-hover:opacity-100 flex items-center justify-center hover:bg-[var(--error)]/20 hover:text-[var(--error)] text-[var(--text-muted)] transition-all"
                          onClick={(e) => handleCloseGroup(groupId, e)}
                          title="Close tab"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="p-1.5 border-t border-[var(--border)] shrink-0 flex items-center gap-1">
          <button
            onClick={handleNewTerminal}
            disabled={!canAddTerminal() || !projectId}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 h-7 rounded-md text-xs transition-all',
              'bg-[var(--bg-tertiary)] hover:bg-[var(--bg-card)] text-[var(--text-secondary)]',
              'disabled:opacity-30 disabled:cursor-not-allowed'
            )}
            title={!projectId ? 'Open a project first' : 'New Terminal'}
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Terminal</span>
          </button>
          {activeGroupId && canAddTerminal() && projectId && (
            <button
              ref={menuTriggerRef}
              onClick={openNewMenu}
              className="w-7 h-7 rounded-md flex items-center justify-center bg-[var(--bg-tertiary)] hover:bg-[var(--bg-card)] text-[var(--text-muted)] transition-all shrink-0"
              title="More options"
            >
              <ChevronDown className="w-3 h-3" />
            </button>
          )}
        </div>

        {showNewMenu && createPortal(
          <div
            ref={newMenuRef}
            className="fixed z-[9999] w-48 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl overflow-hidden"
            style={{ top: menuPos.top, left: menuPos.left }}
          >
            <button
              onClick={() => { setShowNewMenu(false); handleNewTerminal(); }}
              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)]"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Tab</span>
            </button>
            <button
              onClick={() => { setShowNewMenu(false); handleNewSplit(); }}
              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)]"
            >
              <Columns2 className="w-3.5 h-3.5" />
              <span>Split Terminal</span>
            </button>
          </div>,
          document.body
        )}
      </div>

      {/* Draggable splitter between tree sidebar and terminal area. Hover/drag
          highlights it; double-click resets to the default width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize tree sidebar"
        onMouseDown={handleTreeResizeStart}
        onDoubleClick={handleTreeResizeDoubleClick}
        className={cn(
          'w-1 shrink-0 cursor-col-resize relative group transition-colors',
          resizingTree ? 'bg-[var(--accent)]' : 'bg-transparent hover:bg-[var(--accent)]/40',
        )}
        title="Drag to resize · Double-click to reset"
      >
        {/* widen the hit area without changing visible width */}
        <div className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" />
      </div>

      <div className="flex-1 relative min-h-0 min-w-0 overflow-hidden">
        {terminals.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] gap-4">
            {!projectId ? (
              <>
                <Folder className="w-12 h-12 opacity-30" />
                <p className="text-sm">Open a project folder to get started</p>
                <button
                  onClick={() => addProjectAction()}
                  className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm hover:bg-[var(--accent-hover)] transition-colors"
                >
                  Open Project Folder
                </button>
              </>
            ) : (
              <>
                <TerminalIcon className="w-12 h-12 opacity-30" />
                <p className="text-sm">No terminals open</p>
                <button
                  onClick={handleNewTerminal}
                  className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm hover:bg-[var(--accent-hover)] transition-colors"
                >
                  New Terminal
                </button>
              </>
            )}
          </div>
        ) : (
          groupIds.map((groupId) => {
            // Lazy-mount: skip groups that haven't been active yet
            if (!mountedGroups.has(groupId)) return null;

            const groupTerminals = terminals.filter((t) => t.groupId === groupId);
            const isCurrentGroup = activeGroupId === groupId;
            const isGroupSplit = groupTerminals.length > 1;

            // Find terminal with changes panel open
            const activeTerminalObj = groupTerminals.find((t) => t.id === activeTerminalId);
            const changesTerminal = activeTerminalObj?.previewOpen
              ? activeTerminalObj
              : groupTerminals.find((t) => t.previewOpen);
            const hasChanges = !!changesTerminal;

            const terminalContent = isGroupSplit ? (
              /* Grid layout for split terminals */
              <div className={cn('grid h-full gap-1 p-1', getGridClass(groupTerminals.length))}>
                {groupTerminals.map((terminal) => (
                  <div
                    key={terminal.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      if (dragTerminalId && dragTerminalId !== terminal.id) {
                        setDragOverTerminalId(terminal.id);
                      }
                    }}
                    onDragLeave={() => {
                      if (dragOverTerminalId === terminal.id) setDragOverTerminalId(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragTerminalId && dragTerminalId !== terminal.id) {
                        reorderTerminalsInGroup(dragTerminalId, terminal.id);
                      }
                      setDragTerminalId(null);
                      setDragOverTerminalId(null);
                    }}
                    className={cn(
                      'rounded-lg overflow-hidden border min-h-0',
                      activeTerminalId === terminal.id
                        ? 'border-[var(--accent)]'
                        : 'border-[var(--border)]',
                      dragTerminalId === terminal.id && 'opacity-50',
                    )}
                  >
                    <TerminalPanel
                      terminal={terminal}
                      isActive={activeTerminalId === terminal.id}
                      isSplit={true}
                      agentProviders={agentProviders}
                      skills={projectSkills}
                      onInvokeAgent={(opts) => handleInvokeAgent(terminal.id, opts)}
                      onProviderChange={(p) => handleProviderChange(terminal.id, p)}
                      onInvokeSkill={(skill) => handleInvokeSkill(terminal.id, skill)}
                      onMergeComplete={() => openCompleteTask(terminal)}
                      onLinkTask={settings.taskManagerProvider !== 'none' ? () => handleLinkTask(terminal.id) : undefined}
                      onBaseBranchChange={(b) => handleBaseBranchChange(terminal.id, b)}
                      availableBranches={projectBranches}
                      onClose={() => handleCloseTerminal(terminal.id)}
                      onFocus={() => setActiveTerminal(terminal.id)}
                      isDraggedOver={dragOverTerminalId === terminal.id && dragTerminalId !== terminal.id}
                      onDragHandleStart={(e) => {
                        e.stopPropagation();
                        setDragTerminalId(terminal.id);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', terminal.id);
                      }}
                      onDragHandleEnd={() => {
                        setDragTerminalId(null);
                        setDragOverTerminalId(null);
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : (
              /* Single terminal, full size */
              groupTerminals.map((terminal) => (
                <div key={terminal.id} className="absolute inset-0">
                  <TerminalPanel
                    terminal={terminal}
                    isActive={isCurrentGroup}
                    agentProviders={agentProviders}
                    skills={projectSkills}
                    onInvokeAgent={(opts) => handleInvokeAgent(terminal.id, opts)}
                    onProviderChange={(p) => handleProviderChange(terminal.id, p)}
                    onInvokeSkill={(skill) => handleInvokeSkill(terminal.id, skill)}
                    onMergeComplete={() => openCompleteTask(terminal)}
                    onLinkTask={settings.taskManagerProvider !== 'none' ? () => handleLinkTask(terminal.id) : undefined}
                    onBaseBranchChange={(b) => handleBaseBranchChange(terminal.id, b)}
                    availableBranches={projectBranches}
                  />
                </div>
              ))
            );

            return (
              <div
                key={groupId}
                className={cn(
                  'absolute inset-0',
                  // Use visibility:hidden instead of display:none so xterm
                  // containers keep valid dimensions (prevents internal crash)
                  !isCurrentGroup && 'invisible pointer-events-none'
                )}
              >
                {hasChanges ? (
                  <ChangesSplitLayout
                    terminal={changesTerminal!}
                  >
                    {terminalContent}
                  </ChangesSplitLayout>
                ) : (
                  terminalContent
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Right-side panels */}
      {filesPanel === 'docs' && activeProject?.docsPath && (
        <div className="w-72 shrink-0 min-h-0">
          <FilesPanel
            docsPath={activeProject.docsPath}
            label="Documents"
            onClose={() => setFilesPanel(null)}
          />
        </div>
      )}
      {filesPanel === 'project' && activeProject?.path && (
        <div className="w-72 shrink-0 min-h-0">
          <FilesPanel
            docsPath={activeProject.path}
            label="Files"
            enablePull={false}
            onClose={() => setFilesPanel(null)}
          />
        </div>
      )}
      {skillsOpen && projectSkills.length > 0 && (
        <div className="w-80 shrink-0 min-h-0">
          <SkillsPanel
            skills={projectSkills}
            onInvokeSkill={(skill) => {
              const active = useTerminalStore.getState().getActiveTerminal();
              if (active) handleInvokeSkill(active.id, skill);
            }}
            projectPath={activeProject?.path}
            onClose={() => setSkillsOpen(false)}
          />
        </div>
      )}
      </div>
    </div>
  );
}

