import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  Activity as ActivityIcon,
  Wrench,
  ShieldCheck,
  GitPullRequestDraft,
  CheckCheck,
  Trash2,
  ExternalLink,
  LayoutDashboard,
} from 'lucide-react';
import type { ActivityEvent, ActivitySource, ActivityLevel } from '../../../shared/types';
import { useActivityStore } from '../../stores/activity-store';
import { cn } from '../../../shared/utils';

const SOURCE_ICON: Record<ActivitySource, typeof Wrench> = {
  'auto-code': Wrench,
  qc: ShieldCheck,
  'code-review': GitPullRequestDraft,
  dashboard: LayoutDashboard,
};

const SOURCE_LABEL: Record<ActivitySource, string> = {
  'auto-code': 'Auto Code',
  qc: 'QC',
  'code-review': 'Code Review',
  dashboard: 'Dashboard',
};

const LEVEL_DOT: Record<ActivityLevel, string> = {
  info: 'bg-[var(--text-muted)]',
  success: 'bg-green-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
};

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function ActivityRow({ item, onClick }: { item: ActivityEvent; onClick: () => void }) {
  const Icon = SOURCE_ICON[item.source] || ActivityIcon;
  const clickable = !!item.url;
  return (
    <button
      onClick={onClick}
      disabled={!clickable && item.read}
      className={cn(
        'w-full text-left flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors',
        item.read
          ? 'border-transparent bg-transparent hover:bg-[var(--bg-tertiary)]'
          : 'border-[var(--border)] bg-[var(--bg-tertiary)]/40 hover:bg-[var(--bg-tertiary)]',
        clickable && 'cursor-pointer',
      )}
    >
      <span className="relative mt-0.5 shrink-0">
        <Icon className="w-4 h-4 text-[var(--text-muted)]" />
        {!item.read && (
          <span className={cn('absolute -top-1 -right-1 w-2 h-2 rounded-full', LEVEL_DOT[item.level])} />
        )}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', LEVEL_DOT[item.level])} />
          <span className={cn('text-sm truncate', item.read ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)] font-medium')}>
            {item.title}
          </span>
          {item.url && <ExternalLink className="w-3 h-3 text-[var(--text-muted)] shrink-0" />}
        </div>
        {item.message && (
          <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">{item.message}</p>
        )}
        <div className="flex items-center gap-2 mt-1 text-[10px] text-[var(--text-muted)]">
          <span className="px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] border border-[var(--border)] uppercase tracking-wide">
            {SOURCE_LABEL[item.source] || item.source}
          </span>
          <span>{relativeTime(item.at)}</span>
        </div>
      </div>
    </button>
  );
}

/** Notification bell for the global top bar. Shows the unread count as a badge
 *  and opens a popover with the full activity feed (grouped by day). */
export function NotificationBell() {
  const items = useActivityStore((s) => s.items);
  const loading = useActivityStore((s) => s.loading);
  const markRead = useActivityStore((s) => s.markRead);
  const markAllRead = useActivityStore((s) => s.markAllRead);
  const clear = useActivityStore((s) => s.clear);

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Panel position — computed from the bell button so the portal-rendered
  // panel stays anchored to it. Anchoring by `right` keeps the panel pinned
  // to the bell's right edge on window resize.
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);

  const unread = items.reduce((n, i) => n + (i.read ? 0 : 1), 0);

  // Close on outside click + Escape. Allow Ctrl+B (from App) to toggle.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onToggle = () => setOpen((v) => !v);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('agent-terminal:toggle-notifications', onToggle);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('agent-terminal:toggle-notifications', onToggle);
    };
  }, []);

  // Anchor the panel to the bell whenever it opens (and re-anchor on resize —
  // the top bar is fixed, so only window size changes can move the bell).
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      setPanelPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  // Group by day (items already arrive newest-first from main).
  const groups: { key: string; items: ActivityEvent[] }[] = [];
  for (const item of items) {
    const key = dayKey(item.at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }

  const handleRowClick = (item: ActivityEvent) => {
    if (!item.read) void markRead(item.id);
    if (item.url) void window.electronAPI.openExternal(item.url);
  };

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Notifications  (Ctrl+B)"
        className={cn(
          'relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors',
          open
            ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]',
        )}
      >
        <Bell className="w-[18px] h-[18px]" />
        {unread > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {/* Portal + high z-index so the panel floats above modal overlays
          (e.g. the Kanban task detail, which uses z-50) instead of being
          painted over by them. */}
      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          className="fixed z-[110] w-[26rem] max-w-[calc(100vw-2rem)] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden flex flex-col"
          style={{ top: panelPos.top, right: panelPos.right }}
        >
          {/* Header */}
          <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-[var(--accent)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Notifications</h2>
              {unread > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)] text-white font-medium">
                  {unread}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => void markAllRead()}
                disabled={unread === 0}
                title="Mark all as read"
                className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <CheckCheck className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => void clear()}
                disabled={items.length === 0}
                title="Clear the activity feed"
                className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed px-2 py-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto px-2 py-2 max-h-[70vh]">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center text-[var(--text-muted)] gap-2 py-10">
                <ActivityIcon className="w-8 h-8 opacity-40" />
                <p className="text-sm">{loading ? 'Loading…' : 'No notifications yet'}</p>
                <p className="text-xs max-w-xs">
                  Auto-fix pushes, escalations, QC failures, and auto-merges will show up here.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {groups.map((g) => (
                  <div key={g.key}>
                    <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] px-1 mb-1">
                      {g.key}
                    </div>
                    <div className="space-y-1">
                      {g.items.map((item) => (
                        <ActivityRow key={item.id} item={item} onClick={() => handleRowClick(item)} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
