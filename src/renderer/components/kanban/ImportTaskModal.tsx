import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Search, Loader2, AlertTriangle, Check, FolderOpen, List, ChevronDown, User, Users } from 'lucide-react';
import type { TaskManagerTask, TaskManagerList } from '../../../shared/types';
import { useSettingsStore } from '../../stores/settings-store';
import { useProjectStore } from '../../stores/project-store';
import { useKanbanStore, type WorkspaceMember } from '../../stores/kanban-store';
import { cn } from '../../../shared/utils';

interface ImportTaskModalProps {
  open: boolean;
  onClose: () => void;
}

export function ImportTaskModal({ open, onClose }: ImportTaskModalProps) {
  const assigneeFilter = useSettingsStore((s) => s.settings.kanbanFilterAssigneeId);
  const defaultListId = useSettingsStore((s) => s.settings.clickupListId);

  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const members = useKanbanStore((s) => s.members);
  const importTask = useKanbanStore((s) => s.importTask);
  const existingTasks = useKanbanStore((s) => s.tasks);

  const [lists, setLists] = useState<TaskManagerList[]>([]);
  const [selectedListId, setSelectedListId] = useState<string>('');
  const [listDropdownOpen, setListDropdownOpen] = useState(false);
  const listDropdownRef = useRef<HTMLDivElement>(null);

  const [selectedProjectPath, setSelectedProjectPath] = useState<string>('');

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TaskManagerTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<Set<string>>(new Set());

  const importedIds = new Set(existingTasks.map((t) => t.clickupTaskId));

  // Load lists on mount
  useEffect(() => {
    if (!open) return;
    window.electronAPI.getTaskManagerLists().then((res: any) => {
      if (res.success && Array.isArray(res.data)) {
        setLists(res.data);
        if (!selectedListId) {
          const fallback = defaultListId && res.data.some((l: TaskManagerList) => l.id === defaultListId)
            ? defaultListId
            : res.data[0]?.id;
          if (fallback) setSelectedListId(fallback);
        }
      }
    });
  }, [open, defaultListId, selectedListId]);

  // Set default project
  useEffect(() => {
    if (!open) return;
    if (selectedProjectPath) return;
    const activeProject = projects.find((p) => p.id === activeProjectId);
    if (activeProject) setSelectedProjectPath(activeProject.path);
    else if (projects.length > 0) setSelectedProjectPath(projects[0].path);
  }, [open, activeProjectId, projects, selectedProjectPath]);

  // Close list dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (listDropdownRef.current && !listDropdownRef.current.contains(e.target as Node)) {
        setListDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Search whenever query/list/filter changes (debounced)
  const runSearch = useCallback(async () => {
    if (!selectedListId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.searchTaskManagerTasks(
        query,
        {
          assignees: assigneeFilter ? [assigneeFilter] : undefined,
          includeClosed: false,
        },
        selectedListId,
        0,
      );
      if (result.success) {
        setResults(result.data || []);
      } else {
        setError(result.error || 'Failed to search tasks');
        setResults([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search tasks');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, selectedListId, assigneeFilter]);

  useEffect(() => {
    if (!open || !selectedListId) return;
    const t = setTimeout(runSearch, 250);
    return () => clearTimeout(t);
  }, [open, runSearch, selectedListId]);

  const handleImport = useCallback(
    async (task: TaskManagerTask) => {
      if (!selectedProjectPath) {
        setError('Pick a project first — worktrees live inside the project directory.');
        return;
      }
      setImporting((prev) => new Set(prev).add(task.id));
      try {
        const matchedProject = projects.find((p) => p.path === selectedProjectPath);
        await importTask({
          clickupTask: task,
          projectPath: selectedProjectPath,
          projectId: matchedProject?.id,
        });
      } finally {
        setImporting((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
      }
    },
    [importTask, selectedProjectPath, projects],
  );

  if (!open) return null;

  const listsBySpace = lists.reduce<Record<string, TaskManagerList[]>>((acc, list) => {
    const space = list.space || 'Lists';
    if (!acc[space]) acc[space] = [];
    acc[space].push(list);
    return acc;
  }, {});

  const selectedList = lists.find((l) => l.id === selectedListId);
  const selectedMember: WorkspaceMember | undefined = members.find((m) => m.id === assigneeFilter);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[80vh] flex flex-col bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Import from ClickUp</h2>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
              Pick tasks to add to your Kanban. They keep a live link to ClickUp.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Controls */}
        <div className="px-5 py-3 border-b border-[var(--border)] space-y-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            {/* List selector */}
            <div className="relative" ref={listDropdownRef}>
              <button
                onClick={() => setListDropdownOpen(!listDropdownOpen)}
                className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors min-w-[180px]"
              >
                <List className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                <span className="truncate max-w-[200px]">
                  {selectedList ? selectedList.name : 'Select list…'}
                </span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-[var(--text-muted)] ml-auto transition-transform', listDropdownOpen && 'rotate-180')} />
              </button>
              {listDropdownOpen && (
                <div className="absolute z-10 top-full left-0 mt-1 min-w-[240px] max-h-64 overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl">
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
                            setListDropdownOpen(false);
                          }}
                          className={cn(
                            'w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)]',
                            list.id === selectedListId && 'bg-[var(--accent)]/10 text-[var(--accent)]',
                          )}
                        >
                          {list.name}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Project selector */}
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-[var(--text-muted)]" />
              <select
                value={selectedProjectPath}
                onChange={(e) => setSelectedProjectPath(e.target.value)}
                className="bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                <option value="">Select project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.path}>{p.name}</option>
                ))}
              </select>
            </div>

            {/* Assignee filter indicator (read-only here) */}
            <div
              className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] px-2 py-1 rounded-md bg-[var(--bg-tertiary)]"
              title={assigneeFilter ? `Filtering to ${selectedMember?.username || 'selected user'}` : 'No assignee filter applied'}
            >
              {assigneeFilter ? <User className="w-3.5 h-3.5 text-[var(--accent)]" /> : <Users className="w-3.5 h-3.5" />}
              <span>{assigneeFilter ? selectedMember?.username || 'Assignee filter on' : 'All assignees'}</span>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder="Search by name, custom ID, or description…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-4 flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {loading && results.length === 0 && (
            <div className="py-16 flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-[var(--accent)] animate-spin" />
            </div>
          )}

          {!loading && !error && results.length === 0 && (
            <div className="py-16 text-center text-sm text-[var(--text-muted)]">
              {selectedListId ? 'No tasks found. Try a different list or broaden the filter.' : 'Pick a list to start.'}
            </div>
          )}

          <ul className="divide-y divide-[var(--border)]">
            {results.map((task) => {
              const already = importedIds.has(task.id);
              const isImporting = importing.has(task.id);
              return (
                <li key={task.id} className="px-5 py-3 hover:bg-[var(--bg-tertiary)]/40 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        {task.customId && (
                          <code className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">
                            {task.customId}
                          </code>
                        )}
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
                          style={{ backgroundColor: `${task.status.color}20`, color: task.status.color }}
                        >
                          {task.status.name}
                        </span>
                        {task.assignees.slice(0, 2).map((a) => (
                          <span
                            key={a.id}
                            className="text-[10px] text-[var(--text-muted)]"
                            title={a.username}
                          >
                            {a.initials || a.username.slice(0, 2)}
                          </span>
                        ))}
                      </div>
                      <h3 className="text-sm text-[var(--text-primary)] line-clamp-2">{task.name}</h3>
                    </div>
                    {already ? (
                      <span className="flex items-center gap-1 text-xs text-green-400 bg-green-500/10 px-2 py-1 rounded-md shrink-0">
                        <Check className="w-3 h-3" />
                        Imported
                      </span>
                    ) : (
                      <button
                        onClick={() => handleImport(task)}
                        disabled={isImporting || !selectedProjectPath}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 shrink-0"
                      >
                        {isImporting ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Import'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--border)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span>
            {existingTasks.length} imported · {results.length} shown
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
