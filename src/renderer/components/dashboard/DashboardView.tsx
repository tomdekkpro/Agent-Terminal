import { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  LayoutDashboard, Plus, Play, Loader2, Pencil, Trash2, X,
  AlertTriangle, Sparkles, CheckCircle2, CalendarClock, Bell,
  ListChecks, Github, Globe, GripVertical,
} from 'lucide-react';
import { useDashboardStore, subscribeDashboardEvents, type SaveNoticeInput } from '../../stores/dashboard-store';
import { UsageSummaryCard } from './UsageSummaryCard';
import { useProjectStore } from '../../stores/project-store';
import type { DashboardNotice, NoticeSource } from '../../../shared/types';
import { cn, formatRelativeTime } from '../../../shared/utils';

const SOURCE_META: Record<NoticeSource, { label: string; icon: typeof Github; hint: string }> = {
  clickup: { label: 'ClickUp', icon: ListChecks, hint: 'Pull your tasks from the configured list' },
  github: { label: 'GitHub', icon: Github, hint: 'Use the gh CLI + repo (pick a project below)' },
  web: { label: 'Web', icon: Globe, hint: 'Search & fetch external websites' },
};
const ALL_SOURCES: NoticeSource[] = ['clickup', 'github', 'web'];

const EXAMPLE_PROMPTS = [
  'List all tasks that need priority today, ordered by urgency, and explain why.',
  'Which tasks have been waiting for review the longest? Flag anything over 2 days.',
  'Give me a short standup summary of what changed across my tasks since yesterday.',
  'What should I work on first this morning? Pick the top 3 and why.',
];

function StatusPill({ notice }: { notice: DashboardNotice }) {
  if (notice.status === 'running') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-blue-400">
        <Loader2 className="w-3 h-3 animate-spin" /> Generating…
      </span>
    );
  }
  if (notice.status === 'error') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-red-400" title={notice.lastError}>
        <AlertTriangle className="w-3 h-3" /> Failed
      </span>
    );
  }
  if (notice.lastRunAt) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
        <CheckCircle2 className="w-3 h-3 text-green-400" /> Updated {formatRelativeTime(notice.lastRunAt)}
      </span>
    );
  }
  return <span className="text-[11px] text-[var(--text-muted)]">Not run yet</span>;
}

function NoticeCard({
  notice,
  onRun,
  onEdit,
  onDelete,
  onToggleEnabled,
  onReorder,
  onResize,
  draggingId,
  onDragStart,
  onDragEnd,
}: {
  notice: DashboardNotice;
  onRun: (id: string) => void;
  onEdit: (n: DashboardNotice) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (n: DashboardNotice) => void;
  onReorder: (draggedId: string, targetId: string, position: 'before' | 'after') => void;
  onResize: (id: string, width: number, height: number) => void;
  draggingId: string | null;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  const running = notice.status === 'running';
  const cardRef = useRef<HTMLDivElement>(null);
  const [insertHint, setInsertHint] = useState<'before' | 'after' | null>(null);

  // Persist size after the user finishes dragging the resize corner.
  const savedSize = useRef({ w: notice.width || 0, h: notice.height || 0 });
  const firstObs = useRef(true);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (firstObs.current) { firstObs.current = false; return; }
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      if (Math.abs(w - savedSize.current.w) < 4 && Math.abs(h - savedSize.current.h) < 4) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { savedSize.current = { w, h }; onResize(notice.id, w, h); }, 500);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [notice.id, onResize]);

  const isDropTarget = draggingId && draggingId !== notice.id;

  return (
    <div
      ref={cardRef}
      style={{ width: notice.width ?? 460, height: notice.height, minWidth: 300, minHeight: 220, maxWidth: '100%' }}
      onDragOver={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        setInsertHint(e.clientX < r.left + r.width / 2 ? 'before' : 'after');
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setInsertHint(null); }}
      onDrop={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const pos: 'before' | 'after' = e.clientX < r.left + r.width / 2 ? 'before' : 'after';
        setInsertHint(null);
        onReorder(draggingId!, notice.id, pos);
      }}
      className={cn(
        'relative rounded-2xl border border-[var(--border)] glass-card overflow-hidden flex flex-col [resize:both]',
        draggingId === notice.id && 'opacity-50',
      )}
    >
      {/* Drop indicator */}
      {insertHint === 'before' && <div className="absolute top-2 bottom-2 -left-0.5 w-1 rounded-full bg-[var(--accent)] pointer-events-none z-10" />}
      {insertHint === 'after' && <div className="absolute top-2 bottom-2 -right-0.5 w-1 rounded-full bg-[var(--accent)] pointer-events-none z-10" />}

      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[var(--border)] shrink-0">
        <div className="min-w-0 flex items-start gap-2">
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', notice.id);
              if (cardRef.current) e.dataTransfer.setDragImage(cardRef.current, 24, 24);
              onDragStart(notice.id);
            }}
            onDragEnd={onDragEnd}
            title="Drag to reorder"
            className="mt-0.5 shrink-0 cursor-grab active:cursor-grabbing text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            <GripVertical className="w-4 h-4" />
          </span>
          <div className="min-w-0">
          <h3 className="font-display text-sm font-semibold text-[var(--text-primary)] truncate">{notice.title}</h3>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className="flex items-center gap-1 text-[11px] text-[var(--text-secondary)]">
              <CalendarClock className="w-3 h-3" />
              {notice.scheduleTime ? <span className="font-mono-ui">{notice.scheduleTime}</span> : 'Manual'}
            </span>
            <StatusPill notice={notice} />
            <div className="flex items-center gap-1">
              {(notice.sources ?? ['clickup']).map((s) => {
                const M = SOURCE_META[s];
                if (!M) return null;
                const Icon = M.icon;
                return (
                  <span key={s} title={M.label} className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)]/80 text-[var(--text-muted)]">
                    <Icon className="w-2.5 h-2.5" />
                    {M.label}
                  </span>
                );
              })}
            </div>
          </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Enabled toggle */}
          <button
            onClick={() => onToggleEnabled(notice)}
            title={notice.enabled ? 'Scheduled — click to pause' : 'Paused — click to enable schedule'}
            className={cn(
              'relative w-9 h-5 rounded-full transition-colors duration-200 mr-1',
              notice.enabled ? 'bg-green-500' : 'bg-[var(--bg-tertiary)]',
            )}
          >
            <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200', notice.enabled ? 'translate-x-4' : 'translate-x-0.5')} />
          </button>
          <button
            onClick={() => onRun(notice.id)}
            disabled={running}
            title="Run now"
            className="p-1.5 rounded-lg hover:bg-[var(--accent)]/10 text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => onEdit(notice)} title="Edit" className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { if (confirm(`Delete notice "${notice.title}"?`)) onDelete(notice.id); }}
            title="Delete"
            className="p-1.5 rounded-lg hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Prompt */}
      <div className="px-4 py-2 text-[11px] text-[var(--text-muted)] italic border-b border-[var(--border)] line-clamp-2 shrink-0">
        “{notice.prompt}”
      </div>

      {/* Result */}
      <div className="px-4 py-3 flex-1 min-h-0 overflow-y-auto">
        {notice.status === 'error' ? (
          <div className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{notice.lastError || 'Run failed.'}</span>
          </div>
        ) : notice.lastResult ? (
          <div className="insights-prose text-sm text-[var(--text-secondary)] pr-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{notice.lastResult}</ReactMarkdown>
          </div>
        ) : running ? (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] py-4 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Generating your briefing…
          </div>
        ) : (
          <div className="text-xs text-[var(--text-muted)] py-4 text-center">
            No result yet — hit <Play className="w-3 h-3 inline -mt-0.5" /> to run it now.
          </div>
        )}
      </div>
    </div>
  );
}

function NoticeModal({
  initial,
  onClose,
  onSave,
}: {
  initial: DashboardNotice | null;
  onClose: () => void;
  onSave: (input: SaveNoticeInput) => Promise<void>;
}) {
  const projects = useProjectStore((s) => s.projects);
  const [title, setTitle] = useState(initial?.title || '');
  const [prompt, setPrompt] = useState(initial?.prompt || '');
  const [time, setTime] = useState(initial?.scheduleTime || '08:00');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [projectPath, setProjectPath] = useState(initial?.projectPath || '');
  const [sources, setSources] = useState<NoticeSource[]>(initial?.sources ?? ['clickup']);
  const [urls, setUrls] = useState((initial?.urls || []).join('\n'));
  const [busy, setBusy] = useState(false);

  const canSave = title.trim() && prompt.trim();
  const toggleSource = (s: NoticeSource) =>
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const submit = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    await onSave({
      id: initial?.id,
      title: title.trim(),
      prompt: prompt.trim(),
      scheduleTime: time,
      enabled,
      projectPath: projectPath || undefined,
      sources,
      urls: sources.includes('web')
        ? urls.split('\n').map((u) => u.trim()).filter(Boolean)
        : undefined,
    });
    setBusy(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-[var(--border)] glass-card shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
          <h2 className="font-display text-base font-semibold text-[var(--text-primary)]">
            {initial ? 'Edit Notice' : 'New Notice'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Morning priorities"
              className="w-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] placeholder:text-[var(--text-muted)]"
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="e.g. List all tasks that need priority today and explain why."
              className="w-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] placeholder:text-[var(--text-muted)] resize-none"
            />
            {!initial && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {EXAMPLE_PROMPTS.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setPrompt(ex)}
                    className="text-[10px] px-2 py-1 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors text-left"
                  >
                    {ex.length > 42 ? ex.slice(0, 42) + '…' : ex}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sources / tools */}
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Sources the AI can use</label>
            <div className="flex flex-wrap gap-2">
              {ALL_SOURCES.map((s) => {
                const M = SOURCE_META[s];
                const Icon = M.icon;
                const on = sources.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleSource(s)}
                    title={M.hint}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors',
                      on
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'border-[var(--border)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" /> {M.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
              {sources.length
                ? sources.map((s) => SOURCE_META[s].hint).join(' · ')
                : 'No sources — the AI answers from the prompt alone.'}
            </p>
          </div>

          {/* Websites for the Web source */}
          {sources.includes('web') && (
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                Websites <span className="text-[var(--text-muted)]">(optional, one per line)</span>
              </label>
              <textarea
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
                rows={2}
                placeholder="https://status.example.com&#10;https://news.ycombinator.com"
                className="w-full text-xs bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] placeholder:text-[var(--text-muted)] resize-none font-mono-ui"
              />
            </div>
          )}

          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Run daily at</label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] font-mono-ui"
              />
            </div>
            <label className="flex items-center gap-2 mt-5 cursor-pointer select-none">
              <button
                type="button"
                onClick={() => setEnabled((v) => !v)}
                className={cn('relative w-9 h-5 rounded-full transition-colors', enabled ? 'bg-green-500' : 'bg-[var(--bg-tertiary)]')}
              >
                <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform', enabled ? 'translate-x-4' : 'translate-x-0.5')} />
              </button>
              <span className="text-xs text-[var(--text-secondary)]">Schedule enabled</span>
            </label>
          </div>

          {projects.length > 0 && (
            <div>
              <label className="block text-xs text-[var(--text-secondary)] mb-1.5">
                Run from project{' '}
                <span className="text-[var(--text-muted)]">{sources.includes('github') ? '(used for GitHub / gh)' : '(optional)'}</span>
              </label>
              <select
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                className="w-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              >
                <option value="">Default</option>
                {projects.map((p) => <option key={p.id} value={p.path}>{p.name}</option>)}
              </select>
              {sources.includes('github') && !projectPath && (
                <p className="flex items-center gap-1 text-[10px] text-amber-400 mt-1.5">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  Pick a project so the notice can read its GitHub repo with the gh CLI.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!canSave || busy}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {initial ? 'Save' : 'Create Notice'}
          </button>
        </div>
      </div>
    </div>
  );
}

const orderKey = (n: DashboardNotice) =>
  typeof n.orderIndex === 'number' ? n.orderIndex : (Date.parse(n.createdAt) || 0);

export function DashboardView() {
  const { notices, loading, error, load, save, remove, run } = useDashboardStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<DashboardNotice | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    load();
    return subscribeDashboardEvents();
  }, [load]);

  const sortedNotices = [...notices].sort((a, b) => orderKey(a) - orderKey(b));

  const openNew = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (n: DashboardNotice) => { setEditing(n); setModalOpen(true); };

  /** Persist a partial change, re-sending the required fields save() expects. */
  const persist = useCallback((n: DashboardNotice, patch: Partial<SaveNoticeInput>) => {
    void save({
      id: n.id, title: n.title, prompt: n.prompt, scheduleTime: n.scheduleTime,
      enabled: n.enabled, projectPath: n.projectPath, sources: n.sources, urls: n.urls,
      ...patch,
    });
  }, [save]);

  const toggleEnabled = (n: DashboardNotice) => persist(n, { enabled: !n.enabled });
  const handleResize = useCallback((id: string, width: number, height: number) => {
    const n = notices.find((x) => x.id === id);
    if (n) persist(n, { width, height });
  }, [notices, persist]);

  const handleReorder = useCallback((draggedId: string, targetId: string, position: 'before' | 'after') => {
    setDraggingId(null);
    if (draggedId === targetId) return;
    const dragged = notices.find((n) => n.id === draggedId);
    if (!dragged) return;
    const list = [...notices].sort((a, b) => orderKey(a) - orderKey(b)).filter((n) => n.id !== draggedId);
    const idx = list.findIndex((n) => n.id === targetId);
    if (idx < 0) return;
    const tKey = orderKey(list[idx]);
    let newOrder: number;
    if (position === 'before') {
      const prev = idx > 0 ? list[idx - 1] : undefined;
      newOrder = prev ? (orderKey(prev) + tKey) / 2 : tKey - 1;
    } else {
      const next = idx < list.length - 1 ? list[idx + 1] : undefined;
      newOrder = next ? (tKey + orderKey(next)) / 2 : tKey + 1;
    }
    persist(dragged, { orderIndex: newOrder });
  }, [notices, persist]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-[var(--border)] glass px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] shadow-[var(--glow-accent)]">
            <LayoutDashboard className="w-[18px] h-[18px]" />
          </span>
          <div>
            <h1 className="font-display text-lg font-semibold tracking-tight text-[var(--text-primary)]">Dashboard</h1>
            <p className="text-xs text-[var(--text-muted)]">Scheduled AI briefings from your tasks</p>
          </div>
          {notices.length > 0 && (
            <span className="font-mono-ui text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)]/80 border border-[var(--border)] px-2 py-0.5 rounded-full ml-1">
              {notices.length}
            </span>
          )}
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" /> New Notice
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg px-4 py-3 border border-red-500/20">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Claude Code usage summary — always visible */}
        <div className="max-w-6xl mx-auto mb-5">
          <UsageSummaryCard />
        </div>

        {loading && notices.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-[var(--accent)] animate-spin" />
          </div>
        ) : notices.length === 0 ? (
          <div className="max-w-xl mx-auto text-center py-16">
            <span className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)] shadow-[var(--glow-accent)] mb-5">
              <Sparkles className="w-8 h-8" />
            </span>
            <h2 className="font-display text-xl font-semibold text-[var(--text-primary)] mb-2">Create your first Notice</h2>
            <p className="text-sm text-[var(--text-muted)] mb-6">
              Describe what you want to see — like <span className="text-[var(--text-secondary)]">“all tasks that need priority today”</span> —
              pick a time, and it'll auto-generate a fresh briefing every morning.
            </p>
            <button
              onClick={openNew}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
            >
              <Bell className="w-4 h-4" /> New Notice
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-4 items-start max-w-6xl mx-auto">
            {sortedNotices.map((n) => (
              <NoticeCard
                key={n.id}
                notice={n}
                onRun={run}
                onEdit={openEdit}
                onDelete={remove}
                onToggleEnabled={toggleEnabled}
                onReorder={handleReorder}
                onResize={handleResize}
                draggingId={draggingId}
                onDragStart={setDraggingId}
                onDragEnd={() => setDraggingId(null)}
              />
            ))}
          </div>
        )}
      </div>

      {modalOpen && (
        <NoticeModal
          initial={editing}
          onClose={() => setModalOpen(false)}
          onSave={async (input) => { await save(input); }}
        />
      )}
    </div>
  );
}
