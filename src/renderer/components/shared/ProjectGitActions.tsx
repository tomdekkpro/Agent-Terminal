import { useState, useEffect, useCallback } from 'react';
import { GitBranch, RefreshCw, Download, X } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { cn } from '../../../shared/utils';

interface ProjectGitActionsProps {
  /** When true, the Pull-result toast is rendered inline below the buttons (compact use). Otherwise it's omitted. */
  showInlineMessage?: boolean;
}

/** Branch label + Fetch + Pull buttons for the active project.
 *  Self-contained: owns its state, talks to electronAPI directly.
 *  Used in the Terminal page header and the Kanban board toolbar. */
export function ProjectGitActions({ showInlineMessage = true }: ProjectGitActionsProps) {
  const activeProject = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId));

  const [currentBranch, setCurrentBranch] = useState<string>('');
  const [fetchStatus, setFetchStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [pullStatus, setPullStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [behindCount, setBehindCount] = useState<number>(0);
  const [pullMessage, setPullMessage] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

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

  // Auto-fetch on project change so behind count is accurate
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

  if (!activeProject) return null;

  return (
    <>
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
      </div>
      {showInlineMessage && pullMessage && (
        <div className={cn(
          'fixed bottom-4 right-4 z-50 px-3 py-2 rounded-md text-xs flex items-center gap-2 shadow-lg border',
          pullMessage.type === 'success'
            ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
            : 'bg-red-500/20 text-red-400 border-red-500/30',
        )}>
          <span>{pullMessage.message}</span>
          <button onClick={() => setPullMessage(null)} className="hover:opacity-70">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </>
  );
}
