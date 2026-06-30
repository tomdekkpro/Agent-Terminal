import { useState, useEffect, useRef } from 'react';
import { X, Plus, FolderOpen, ChevronDown, Loader2, GitBranch, GitFork } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useKanbanStore } from '../../stores/kanban-store';
import type { KanbanTaskStatus } from '../../../shared/types';
import {
  KANBAN_COLUMN_ORDER,
  KANBAN_COLUMN_LABELS,
  KANBAN_COLUMN_COLORS,
} from '../../stores/kanban-store';
import { cn } from '../../../shared/utils';
import { BaseBranchPicker } from '../shared/BaseBranchPicker';

interface CreateLocalTaskModalProps {
  open: boolean;
  onClose: () => void;
}

export function CreateLocalTaskModal({ open, onClose }: CreateLocalTaskModalProps) {
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const createLocalTask = useKanbanStore((s) => s.createLocalTask);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [kanbanStatus, setKanbanStatus] = useState<KanbanTaskStatus>('todo');
  const [useWorktree, setUseWorktree] = useState(true);
  const [baseBranch, setBaseBranch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Reset state on open + default to active project
  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setKanbanStatus('todo');
    setUseWorktree(true);
    setBaseBranch('');
    setError(null);
    const active = projects.find((p) => p.id === activeProjectId);
    setProjectPath(active?.path || projects[0]?.path || '');
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, [open, activeProjectId, projects]);

  // Clear the base-branch selection when the project changes — the picker
  // will repopulate from the new project's branches and default to current.
  useEffect(() => {
    setBaseBranch('');
  }, [projectPath]);

  // Close project dropdown on outside click
  useEffect(() => {
    if (!projectDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [projectDropdownOpen]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const selectedProject = projects.find((p) => p.path === projectPath);

  const handleSubmit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Task name is required');
      return;
    }
    if (!projectPath) {
      setError('Please select a project');
      return;
    }
    setSubmitting(true);
    const created = await createLocalTask({
      name: name.trim(),
      description: description.trim() || undefined,
      projectPath,
      projectId: selectedProject?.id,
      kanbanStatus,
      baseBranch: useWorktree ? (baseBranch || undefined) : undefined,
      useWorktree,
    });
    setSubmitting(false);
    if (created) {
      onClose();
    } else {
      setError(useKanbanStore.getState().error || 'Failed to create task');
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[var(--border)] flex items-center gap-3">
          <Plus className="w-4 h-4 text-blue-400" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex-1">New Local Task</h2>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">Name</label>
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
              }}
              placeholder="What do you want to work on?"
              className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">
              Description <span className="opacity-60">(optional — sent to the agent as initial context)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Acceptance criteria, links, repro steps…"
              rows={4}
              className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-y"
            />
          </div>

          {/* Project */}
          <div className="relative" ref={projectDropdownRef}>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">Project</label>
            <button
              onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border)] text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
            >
              <span className="flex items-center gap-2 min-w-0">
                <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate">{selectedProject?.name || selectedProject?.path || 'Select project…'}</span>
              </span>
              <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', projectDropdownOpen && 'rotate-180')} />
            </button>
            {projectDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 max-h-[200px] overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-10">
                {projects.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-[var(--text-muted)] text-center">
                    No projects configured.
                  </div>
                ) : (
                  projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setProjectPath(p.path);
                        setProjectDropdownOpen(false);
                      }}
                      className={cn(
                        'w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors',
                        p.path === projectPath && 'bg-[var(--accent)]/10 text-[var(--accent)]',
                      )}
                    >
                      <div className="font-medium">{p.name || p.path}</div>
                      {p.name && (
                        <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">{p.path}</div>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Workspace: dedicated worktree vs current branch */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">Workspace</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setUseWorktree(true)}
                className={cn(
                  'flex items-start gap-2 px-3 py-2 rounded-lg border text-left transition-colors',
                  useWorktree
                    ? 'bg-[var(--accent)]/10 border-[var(--accent)] text-[var(--text-primary)]'
                    : 'bg-[var(--bg-tertiary)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                <GitFork className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">Worktree</span>
                  <span className="block text-[10px] opacity-80 mt-0.5 leading-snug">
                    Isolated branch, forked from base. Recommended.
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setUseWorktree(false)}
                className={cn(
                  'flex items-start gap-2 px-3 py-2 rounded-lg border text-left transition-colors',
                  !useWorktree
                    ? 'bg-[var(--accent)]/10 border-[var(--accent)] text-[var(--text-primary)]'
                    : 'bg-[var(--bg-tertiary)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                )}
              >
                <GitBranch className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-xs font-medium">Current branch</span>
                  <span className="block text-[10px] opacity-80 mt-0.5 leading-snug">
                    Run in the project's checked-out branch — shares uncommitted state.
                  </span>
                </span>
              </button>
            </div>
          </div>

          {/* Base branch — only relevant when forking a worktree */}
          {useWorktree && (
            <BaseBranchPicker
              label="Base branch"
              projectPath={projectPath}
              value={baseBranch}
              onChange={setBaseBranch}
            />
          )}

          {/* Kanban column */}
          <div>
            <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">Column</label>
            <div className="flex gap-1.5 flex-wrap">
              {KANBAN_COLUMN_ORDER.map((col) => (
                <button
                  key={col}
                  onClick={() => setKanbanStatus(col)}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
                    col === kanbanStatus
                      ? `${KANBAN_COLUMN_COLORS[col]} border-current`
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]',
                  )}
                >
                  {KANBAN_COLUMN_LABELS[col]}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--border)] flex items-center justify-end gap-2 bg-[var(--bg-tertiary)]/30">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !name.trim() || !projectPath}
            className="px-4 py-1.5 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-1.5"
          >
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
            Create Task
          </button>
        </div>
      </div>
    </div>
  );
}
