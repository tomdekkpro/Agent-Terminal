import { Inbox, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import type { TaskManagerTask } from '../../../shared/types';
import { BacklogCard } from './BacklogCard';
import { cn } from '../../../shared/utils';

interface BacklogColumnProps {
  tasks: TaskManagerTask[];
  loading: boolean;
  error: string | null;
  importingIds: Set<string>;
  canStart: boolean;
  onRefresh: () => void;
  onStart: (task: TaskManagerTask) => void;
}

export function BacklogColumn({
  tasks,
  loading,
  error,
  importingIds,
  canStart,
  onRefresh,
  onStart,
}: BacklogColumnProps) {
  return (
    <div className="flex flex-col w-72 shrink-0 rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-secondary)]/50">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <Inbox className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          <h2 className="text-sm font-medium text-[var(--text-primary)] uppercase tracking-wide truncate">
            Backlog
          </h2>
          <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded-full px-1.5 py-0.5 shrink-0">
            {tasks.length}
          </span>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh backlog from ClickUp"
          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-24">
        {loading && tasks.length === 0 && (
          <div className="py-6 flex items-center justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
          </div>
        )}

        {error && !loading && (
          <div className="px-2 py-3 text-[11px] text-red-400 space-y-1.5">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
            <button
              onClick={onRefresh}
              className="text-[var(--accent)] hover:underline text-[11px]"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && tasks.length === 0 && (
          <div className="text-center text-[10px] text-[var(--text-muted)] italic py-6 px-2">
            Nothing in the backlog for this user. Adjust backlog statuses in Settings → Auto-Fix, or pick another assignee.
          </div>
        )}

        {tasks.map((task) => (
          <BacklogCard
            key={task.id}
            task={task}
            importing={importingIds.has(task.id)}
            canStart={canStart}
            onStart={onStart}
          />
        ))}
      </div>
    </div>
  );
}
