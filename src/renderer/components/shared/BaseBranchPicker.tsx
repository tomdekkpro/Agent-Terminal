import { useState, useEffect, useRef } from 'react';
import { GitBranch, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '../../../shared/utils';

interface BaseBranchPickerProps {
  /** Path of the project the worktree will live under. Empty/undefined disables the picker. */
  projectPath: string | undefined;
  /** Current selection. */
  value: string;
  onChange: (branch: string) => void;
  /** Optional: layout the label above the control. */
  label?: string;
  className?: string;
}

/** Dropdown that lists the project's local branches and lets the user pick the
 *  one to fork the task's worktree from. Auto-defaults to the project's current
 *  branch the first time it loads for a given project. */
export function BaseBranchPicker({ projectPath, value, onChange, label, className }: BaseBranchPickerProps) {
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const lastDefaultedFor = useRef<string | null>(null);

  // Load branches whenever the project changes
  useEffect(() => {
    if (!projectPath) {
      setBranches([]);
      setCurrentBranch('');
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.electronAPI.listBranches(projectPath)
      .then((result: any) => {
        if (cancelled) return;
        if (result?.success) {
          setBranches(Array.isArray(result.branches) ? result.branches : []);
          setCurrentBranch(result.current || '');
        } else {
          setError(result?.error || 'Failed to load branches');
        }
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || 'Failed to load branches');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectPath]);

  // Default the selection to the current branch the first time it loads
  // for this project. Don't clobber an existing user choice.
  useEffect(() => {
    if (!projectPath || !currentBranch) return;
    if (lastDefaultedFor.current === projectPath) return;
    lastDefaultedFor.current = projectPath;
    if (!value) onChange(currentBranch);
  }, [projectPath, currentBranch, value, onChange]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const disabled = !projectPath;

  return (
    <div className={className}>
      {label && (
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1.5">{label}</label>
      )}
      <div className="relative" ref={ref}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen(!open)}
          className={cn(
            'w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border)] text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
          title={value ? `Worktree will fork from ${value}` : 'Select a base branch for the worktree'}
        >
          <span className="flex items-center gap-2 min-w-0">
            <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
            <span className="truncate">
              {loading ? 'Loading branches…' : (value || 'Default (origin/HEAD)')}
            </span>
            {value && value === currentBranch && (
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide shrink-0">current</span>
            )}
          </span>
          <ChevronDown className={cn('w-3.5 h-3.5 transition-transform shrink-0', open && 'rotate-180')} />
        </button>
        {open && (
          <div className="absolute top-full left-0 right-0 mt-1 max-h-[220px] overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-20">
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false); }}
              className={cn(
                'w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors flex items-center gap-2',
                !value && 'bg-[var(--accent)]/10 text-[var(--accent)]',
              )}
              title="Use the project's default remote branch (origin/HEAD)"
            >
              <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
              <span>Default (origin/HEAD)</span>
            </button>
            {loading && (
              <div className="px-3 py-3 text-xs text-[var(--text-muted)] flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading…
              </div>
            )}
            {error && !loading && (
              <div className="px-3 py-3 text-xs text-red-400">{error}</div>
            )}
            {!loading && !error && branches.length === 0 && (
              <div className="px-3 py-3 text-xs text-[var(--text-muted)]">
                No local branches found.
              </div>
            )}
            {!loading && !error && branches.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => { onChange(b); setOpen(false); }}
                className={cn(
                  'w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors flex items-center gap-2',
                  b === value && 'bg-[var(--accent)]/10 text-[var(--accent)]',
                )}
              >
                <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate flex-1">{b}</span>
                {b === currentBranch && (
                  <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide shrink-0">current</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
