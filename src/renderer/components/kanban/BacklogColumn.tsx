import { useState, useRef, useEffect, type UIEvent } from 'react';
import { Inbox, Loader2, AlertTriangle, RefreshCw, ArrowUpDown, Check } from 'lucide-react';
import type { TaskManagerTask, BacklogSortBy } from '../../../shared/types';
import { BACKLOG_SORT_LABELS } from '../../../shared/types';
import { BacklogCard } from './BacklogCard';
import { cn } from '../../../shared/utils';

interface BacklogColumnProps {
  tasks: TaskManagerTask[];
  loading: boolean;
  /** True while the next page is being appended (infinite scroll). */
  loadingMore: boolean;
  /** True when more pages exist beyond what's loaded. */
  hasMore: boolean;
  error: string | null;
  importingIds: Set<string>;
  canStart: boolean;
  sortBy: BacklogSortBy;
  onSortChange: (sort: BacklogSortBy) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onStart: (task: TaskManagerTask) => void;
}

const SORT_ORDER: BacklogSortBy[] = ['priority', 'created-desc', 'created-asc', 'updated-desc'];

export function BacklogColumn({
  tasks,
  loading,
  loadingMore,
  hasMore,
  error,
  importingIds,
  canStart,
  sortBy,
  onSortChange,
  onRefresh,
  onLoadMore,
  onStart,
}: BacklogColumnProps) {
  const [showSort, setShowSort] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);

  // Infinite scroll: fetch the next page when the user nears the bottom.
  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    if (!hasMore || loading || loadingMore) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) onLoadMore();
  };

  // Close the sort menu on outside click
  useEffect(() => {
    if (!showSort) return;
    const handler = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setShowSort(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSort]);

  return (
    <div className="flex flex-col w-72 shrink-0 rounded-2xl border border-dashed border-[var(--border)] overflow-hidden glass-card">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <Inbox className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          <h2 className="font-display text-xs font-semibold text-[var(--text-primary)] uppercase tracking-[0.08em] truncate">
            Backlog
          </h2>
          <span className="font-mono-ui text-[10px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)]/80 rounded-full px-1.5 py-0.5 shrink-0">
            {tasks.length}{hasMore ? '+' : ''}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Sort selector */}
          <div className="relative" ref={sortRef}>
            <button
              onClick={() => setShowSort((s) => !s)}
              title={`Order by: ${BACKLOG_SORT_LABELS[sortBy]}`}
              className={cn(
                'flex items-center gap-1 px-1.5 py-1 rounded text-[10px] font-medium transition-colors',
                'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]',
                showSort && 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]',
              )}
            >
              <ArrowUpDown className="w-3 h-3" />
              <span className="max-w-[80px] truncate">{BACKLOG_SORT_LABELS[sortBy]}</span>
            </button>
            {showSort && (
              <div className="absolute z-50 top-full right-0 mt-1 min-w-[160px] bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                <div className="px-3 py-1 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
                  Order by
                </div>
                {SORT_ORDER.map((opt) => (
                  <button
                    key={opt}
                    onClick={() => { onSortChange(opt); setShowSort(false); }}
                    className={cn(
                      'w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] flex items-center justify-between gap-2',
                      opt === sortBy ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]',
                    )}
                  >
                    <span>{BACKLOG_SORT_LABELS[opt]}</span>
                    {opt === sortBy && <Check className="w-3 h-3 shrink-0" />}
                  </button>
                ))}
              </div>
            )}
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
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-24" onScroll={handleScroll}>
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

        {/* Lazy-load footer: spinner while appending; manual fallback button
            in case the scroll threshold isn't reached (e.g. large viewport). */}
        {loadingMore && (
          <div className="py-3 flex items-center justify-center gap-1.5 text-[10px] text-[var(--text-muted)]">
            <Loader2 className="w-3 h-3 animate-spin" />
            Loading more…
          </div>
        )}
        {hasMore && !loadingMore && !loading && tasks.length > 0 && (
          <button
            onClick={onLoadMore}
            className="w-full py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
