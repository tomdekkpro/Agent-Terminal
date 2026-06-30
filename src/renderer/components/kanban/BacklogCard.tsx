import { ExternalLink, Play, Loader2, Flag, Clock, Rocket } from 'lucide-react';
import type { TaskManagerTask } from '../../../shared/types';
import { cn, formatRelativeTime, parseTimestamp } from '../../../shared/utils';

interface BacklogCardProps {
  task: TaskManagerTask;
  importing: boolean;
  canStart: boolean;
  onStart: (task: TaskManagerTask) => void;
}

/** Convert ClickUp priority id → label + color. Falls back to raw name when id is missing. */
function priorityDisplay(priority: TaskManagerTask['priority']): { label: string; color: string; rank: number } | null {
  if (!priority) return null;
  const id = priority.id ? parseInt(priority.id, 10) : Number.NaN;
  const rank = Number.isFinite(id) ? id : 999;
  return { label: priority.name, color: priority.color || '#94a3b8', rank };
}

export function BacklogCard({ task, importing, canStart, onStart }: BacklogCardProps) {
  const priority = priorityDisplay(task.priority);
  const createdAgo = formatRelativeTime(task.createdAt);
  const createdTs = parseTimestamp(task.createdAt);
  const createdFull = Number.isNaN(createdTs) ? '' : new Date(createdTs).toLocaleString();

  return (
    <div
      onClick={() => {
        if (canStart && !importing) onStart(task);
      }}
      className={cn(
        'group border border-[var(--border)] rounded-lg bg-[var(--bg-primary)] p-3 transition-colors',
        canStart && !importing
          ? 'cursor-pointer hover:border-[var(--accent)]/50'
          : 'opacity-70 cursor-not-allowed',
      )}
      title={canStart ? 'Click to import and start working' : 'Select a project in Settings first'}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          {task.customId && (
            <code className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded shrink-0">
              {task.customId}
            </code>
          )}
          {priority && (
            <span
              className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded font-medium"
              style={{ backgroundColor: `${priority.color}20`, color: priority.color }}
              title={`Priority: ${priority.label}`}
            >
              <Flag className="w-2.5 h-2.5" />
              {priority.label}
            </span>
          )}
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
            style={{ backgroundColor: `${task.status.color}20`, color: task.status.color }}
          >
            {task.status.name}
          </span>
          {task.releaseVersion && (
            <span
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono-ui font-medium"
              style={{ backgroundColor: 'rgba(34, 211, 238, 0.12)', color: 'var(--accent-2)' }}
              title={`Release version: ${task.releaseVersion}`}
            >
              <Rocket className="w-2.5 h-2.5" />
              {task.releaseVersion}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.electronAPI.openExternal(task.url);
            }}
            title="Open in ClickUp"
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Title */}
      <h3 className="text-sm text-[var(--text-primary)] leading-snug mb-1.5 line-clamp-3">
        {task.name}
      </h3>

      {/* Created time */}
      {createdAgo && (
        <div
          className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] mb-2"
          title={createdFull ? `Created ${createdFull}` : undefined}
        >
          <Clock className="w-2.5 h-2.5 shrink-0" />
          <span>Created {createdAgo}</span>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-[var(--border)]">
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--accent)] font-medium">
          {importing ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Starting…
            </>
          ) : canStart ? (
            <>
              <Play className="w-3 h-3" />
              Click to start
            </>
          ) : (
            <span className="text-[var(--text-muted)] italic">Project required</span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {task.assignees.slice(0, 3).map((a, i) => (
            <span
              key={a.id}
              title={a.username}
              className="w-4 h-4 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border)] text-[9px] font-medium text-[var(--text-muted)] flex items-center justify-center"
              style={{ marginLeft: i > 0 ? '-4px' : 0 }}
            >
              {a.initials || a.username.slice(0, 2).toUpperCase()}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
