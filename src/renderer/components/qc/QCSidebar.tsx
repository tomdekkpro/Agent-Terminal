import { useState, useMemo } from 'react';
import { Plus, Trash2, Search, Pin, X, ShieldCheck, CheckCircle, XCircle, Loader2, Timer, FolderOpen, Clock } from 'lucide-react';
import type { InsightsSessionMeta } from '../../../shared/types';
import { cn } from '../../../shared/utils';

interface QCSidebarProps {
  sessions: InsightsSessionMeta[];
  activeSessionId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m${remSecs > 0 ? ` ${remSecs}s` : ''}`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h${remMins > 0 ? ` ${remMins}m` : ''}`;
}

function getDateGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const monthAgo = new Date(today.getTime() - 30 * 86400000);

  if (d >= today) return 'Today';
  if (d >= yesterday) return 'Yesterday';
  if (d >= weekAgo) return 'Last 7 days';
  if (d >= monthAgo) return 'Last 30 days';
  return 'Older';
}

function folderName(path?: string): string | null {
  if (!path) return null;
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || null;
}

interface GroupedSessions {
  label: string;
  sessions: InsightsSessionMeta[];
}

export function QCSidebar({
  sessions,
  activeSessionId,
  searchQuery,
  onSearchChange,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onTogglePin,
}: QCSidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const startRename = (id: string, currentTitle: string) => {
    setRenamingId(id);
    setRenameText(currentTitle);
  };

  const commitRename = () => {
    if (renamingId && renameText.trim()) {
      onRename(renamingId, renameText.trim());
    }
    setRenamingId(null);
  };

  const { pinnedSessions, groupedSessions } = useMemo(() => {
    const filtered = searchQuery
      ? sessions.filter((s) =>
          s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (s.projectPath && s.projectPath.toLowerCase().includes(searchQuery.toLowerCase()))
        )
      : sessions;

    const pinned = filtered.filter((s) => s.pinned);
    const unpinned = filtered.filter((s) => !s.pinned);

    const groups: GroupedSessions[] = [];
    const groupOrder = ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Older'];

    for (const label of groupOrder) {
      const matching = unpinned.filter((s) => getDateGroup(s.updatedAt) === label);
      if (matching.length > 0) {
        groups.push({ label, sessions: matching });
      }
    }

    return { pinnedSessions: pinned, groupedSessions: groups };
  }, [sessions, searchQuery]);

  const renderSession = (s: InsightsSessionMeta) => {
    return (
      <div
        key={s.id}
        onClick={() => onSelect(s.id)}
        className={cn(
          'group px-3 py-2.5 cursor-pointer border-l-2 transition-colors',
          s.id === activeSessionId
            ? 'bg-[var(--accent)]/10 border-[var(--accent)]'
            : 'border-transparent hover:bg-[var(--bg-tertiary)]',
        )}
        style={s.linkedTaskColor ? {
          backgroundColor: s.id === activeSessionId ? undefined : `${s.linkedTaskColor}15`,
          borderLeftColor: s.id === activeSessionId ? undefined : s.linkedTaskColor,
        } : undefined}
      >
        {renamingId === s.id ? (
          <input
            autoFocus
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setRenamingId(null);
            }}
            className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--accent)] rounded px-1.5 py-0.5 outline-none"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="flex items-start justify-between gap-1">
            <div
              className="flex-1 min-w-0"
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename(s.id, s.title);
              }}
            >
              <div className="flex items-center gap-1.5">
                <ShieldCheck className={cn('w-3 h-3 shrink-0',
                  s.qcStatus === 'completed' && (s.qcFailed ?? 0) > 0 ? 'text-red-400'
                  : s.qcStatus === 'completed' && s.qcFailed === 0 ? 'text-emerald-400'
                  : 'text-amber-400',
                )} />
                <p className={cn('text-sm truncate',
                  s.qcStatus === 'completed' && (s.qcFailed ?? 0) > 0
                    ? 'text-red-400'
                    : 'text-[var(--text-primary)]',
                )}>{s.title}</p>
                {s.qcStatus === 'running' && (
                  <Loader2 className="w-3 h-3 text-blue-400 animate-spin shrink-0" />
                )}
                {s.qcStatus === 'completed' && s.qcFailed === 0 && (
                  <CheckCircle className="w-3 h-3 text-emerald-400 shrink-0" />
                )}
                {s.qcStatus === 'completed' && (s.qcFailed ?? 0) > 0 && (
                  <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {s.qcStatus === 'completed' && s.qcTotal ? (
                  <span className="flex items-center gap-1 text-[10px]">
                    <span className="text-emerald-400">{s.qcPassed ?? 0}P</span>
                    {(s.qcFailed ?? 0) > 0 && <span className="text-red-400">{s.qcFailed}F</span>}
                    <span className="text-[var(--text-muted)]">/{s.qcTotal}</span>
                    {s.qcDurationMs != null && (
                      <span className="flex items-center gap-0.5 text-[var(--text-muted)]">
                        <Timer className="w-2.5 h-2.5" />
                        {formatDuration(s.qcDurationMs)}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="flex items-center gap-0.5 text-[10px] text-amber-400">
                    <Clock className="w-2.5 h-2.5" />
                    {s.qcStatus === 'running' ? 'Running...' : s.qcStatus === 'generating' ? 'Generating...' : 'Draft'}
                  </span>
                )}
                <span className="text-[10px] text-[var(--text-muted)]">{formatDate(s.updatedAt)}</span>
                {folderName(s.projectPath) && (
                  <span className="flex items-center gap-0.5 text-[10px] text-[var(--text-muted)] truncate">
                    <FolderOpen className="w-2.5 h-2.5 shrink-0" />
                    {folderName(s.projectPath)}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-0.5 shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={(e) => { e.stopPropagation(); onTogglePin(s.id); }}
                className={cn(
                  'w-5 h-5 rounded flex items-center justify-center transition-colors',
                  s.pinned
                    ? 'text-[var(--accent)] opacity-100'
                    : 'text-[var(--text-muted)] hover:text-[var(--accent)]',
                )}
                title={s.pinned ? 'Unpin' : 'Pin to top'}
              >
                <Pin className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] transition-colors"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="w-64 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-[var(--border)]">
        <span className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">
          QC Tests
        </span>
        <button
          onClick={onNew}
          className="w-6 h-6 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          title="New QC test"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search QC tests..."
            className="w-full text-xs bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md pl-7 pr-7 py-1.5 outline-none focus:border-[var(--accent)] placeholder:text-[var(--text-muted)]"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-1">
        {pinnedSessions.length === 0 && groupedSessions.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] text-center py-8">
            {searchQuery ? 'No matching QC tests' : 'No QC tests yet'}
          </p>
        )}

        {/* Pinned section */}
        {pinnedSessions.length > 0 && (
          <>
            <div className="px-3 py-1.5 flex items-center gap-1.5">
              <Pin className="w-3 h-3 text-[var(--accent)]" />
              <span className="text-[10px] font-medium text-[var(--accent)] uppercase tracking-wider">Pinned</span>
            </div>
            {pinnedSessions.map(renderSession)}
          </>
        )}

        {/* Date-grouped sections */}
        {groupedSessions.map((group) => (
          <div key={group.label}>
            <div className="px-3 py-1.5 mt-1">
              <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                {group.label}
              </span>
            </div>
            {group.sessions.map(renderSession)}
          </div>
        ))}
      </div>
    </div>
  );
}
