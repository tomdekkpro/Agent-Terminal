import { useEffect, useRef, useState, useMemo } from 'react';
import { DollarSign, CheckCircle2, RefreshCw } from 'lucide-react';
import type { KanbanTask, KanbanDailyCostBreakdown } from '../../../shared/types';
import { cn } from '../../../shared/utils';

interface Props {
  /** All visible Kanban tasks — used to compute the "completed today/week" counts. */
  tasks: KanbanTask[];
}

const POLL_MS = 30_000;

function fmtMoney(n: number): string {
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 100) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

function fmtMoneyExact(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Local-TZ YYYY-MM-DD — must match aggregator's formatting. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shortWeekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' });
}

export function KanbanCostSummary({ tasks }: Props) {
  const [data, setData] = useState<KanbanDailyCostBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = async () => {
    if (!window.electronAPI.kanbanDailyCost) return;
    setLoading(true);
    try {
      const result = await window.electronAPI.kanbanDailyCost();
      if (result?.success && result.data) setData(result.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
    // Re-fetch when the visible task set changes (import / delete) so totals
    // stay accurate without waiting for the next poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks.length]);

  // Close pinned popover on outside click
  useEffect(() => {
    if (!pinned) return;
    const handler = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pinned]);

  // Done-today / done-this-week counts come straight from the visible task
  // list. We use `updatedAt` as a proxy for "completed at" — KanbanTasks
  // don't track a dedicated completedAt field, but `done` tasks rarely get
  // touched again, so updatedAt is close enough for an at-a-glance summary.
  const doneCounts = useMemo(() => {
    const today = localDateKey(new Date());
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 6);
    const weekStartKey = localDateKey(weekStart);
    let doneToday = 0;
    let doneWeek = 0;
    for (const t of tasks) {
      if (t.kanbanStatus !== 'done') continue;
      const d = (t.updatedAt || '').slice(0, 10);
      if (!d) continue;
      if (d >= weekStartKey) doneWeek += 1;
      if (d === today) doneToday += 1;
    }
    return { doneToday, doneWeek };
  }, [tasks]);

  const today = data?.today ?? 0;
  const week = data?.week ?? 0;
  const total = data?.total ?? 0;
  const maxBar = Math.max(...(data?.byDay.map((b) => b.cost) || [0]), 0.01);

  const handleEnter = () => {
    if (pinned) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(true), 120);
  };
  const handleLeave = () => {
    if (pinned) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setOpen(false), 250);
  };
  const handleClick = () => {
    if (pinned) {
      setPinned(false);
      setOpen(false);
    } else {
      setPinned(true);
      setOpen(true);
      void refresh();
    }
  };

  // Don't render if we have no data and no completed work — keeps the header
  // clean for first-time users with an empty board.
  if (!data && doneCounts.doneWeek === 0) return null;

  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={handleClick}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
        title="Today's spend & completed tasks — click for details"
      >
        <DollarSign className="w-3 h-3" />
        <span className="text-xs font-mono font-semibold tabular-nums">
          Today {fmtMoney(today)}
        </span>
        {doneCounts.doneToday > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-emerald-300 ml-1 pl-1.5 border-l border-emerald-500/30">
            <CheckCircle2 className="w-2.5 h-2.5" />
            {doneCounts.doneToday}
          </span>
        )}
      </button>

      {open && (
        <div
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          className="absolute top-full left-0 mt-1 w-72 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-50 p-3 space-y-3"
        >
          <div className="flex items-center justify-between border-b border-[var(--border)] pb-2">
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              Spend & Completion
            </span>
            <button
              onClick={() => void refresh()}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] flex items-center gap-1"
              title="Refresh"
            >
              <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
              Refresh
            </button>
          </div>

          {/* Top-line numbers */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Today</div>
              <div className="text-sm font-semibold text-emerald-400 font-mono tabular-nums">
                {fmtMoneyExact(today)}
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">
                {doneCounts.doneToday} done
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">7 Days</div>
              <div className="text-sm font-semibold text-emerald-400 font-mono tabular-nums">
                {fmtMoneyExact(week)}
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">
                {doneCounts.doneWeek} done
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">All Time</div>
              <div className="text-sm font-semibold text-[var(--text-primary)] font-mono tabular-nums">
                {fmtMoneyExact(total)}
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">
                cumulative
              </div>
            </div>
          </div>

          {/* 7-day bar chart */}
          {data?.byDay && data.byDay.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">
                Last 7 Days
              </div>
              <div className="flex items-end gap-1 h-16">
                {data.byDay.map((day) => {
                  const pct = (day.cost / maxBar) * 100;
                  const isToday = day.date === localDateKey(new Date());
                  return (
                    <div
                      key={day.date}
                      className="flex-1 flex flex-col items-center justify-end h-full gap-0.5"
                      title={`${day.date}: ${fmtMoneyExact(day.cost)}`}
                    >
                      <div
                        className={cn(
                          'w-full rounded-sm transition-all',
                          isToday ? 'bg-emerald-400' : 'bg-emerald-500/40',
                        )}
                        style={{ height: `${Math.max(pct, 2)}%` }}
                      />
                      <div
                        className={cn(
                          'text-[9px] font-mono',
                          isToday ? 'text-emerald-400 font-semibold' : 'text-[var(--text-muted)]',
                        )}
                      >
                        {shortWeekday(day.date)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="text-[10px] text-[var(--text-muted)] pt-1 border-t border-[var(--border)]">
            Computed from Claude session JSONL files. Local timezone.
          </div>
        </div>
      )}
    </div>
  );
}
