import {
  ExternalLink,
  Terminal as TerminalIcon,
  GitBranch,
  Clock,
  AlertTriangle,
  RotateCw,
  Wrench,
  Loader2,
  CheckCircle2,
  GitPullRequestDraft,
  Lock,
  Unlock,
  Trash2,
  Play,
} from 'lucide-react';
import type { KanbanTask, AutoFixTaskState } from '../../../shared/types';
import type { Terminal } from '../../stores/terminal-store';
import { cn } from '../../../shared/utils';

interface KanbanCardProps {
  task: KanbanTask;
  terminal?: Terminal;
  maxIterations: number;
  autoMergeGlobal: boolean;
  autoFixGlobal: boolean;
  /** When a filter is active, non-matching cards get dimmed */
  dimmed?: boolean;
  /** When a filter is active, matching cards get a strong highlight ring */
  highlighted?: boolean;
  isDragging: boolean;
  isPending: boolean;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onClick: () => void;
  onRequeue: (taskId: string) => void;
  onToggleAutoMerge: (taskId: string, override: boolean | null) => void;
  onToggleAutoFix: (taskId: string, override: boolean | null) => void;
  onDelete: (taskId: string) => void;
}

function autoFixBadge(state: AutoFixTaskState): {
  label: string;
  icon: typeof Wrench;
  className: string;
  spin?: boolean;
} | null {
  switch (state) {
    case 'fixing':
      return { label: 'Fixing', icon: Loader2, className: 'bg-blue-500/10 text-blue-400', spin: true };
    case 'awaiting-qc':
      return { label: 'Awaiting QC', icon: Clock, className: 'bg-yellow-500/10 text-yellow-400' };
    case 'escalated':
      return { label: 'Escalated', icon: AlertTriangle, className: 'bg-red-500/10 text-red-400' };
    case 'merging':
      return { label: 'Merging', icon: GitPullRequestDraft, className: 'bg-purple-500/10 text-purple-400' };
    case 'done':
      return { label: 'Done', icon: CheckCircle2, className: 'bg-green-500/10 text-green-400' };
    default:
      return null;
  }
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return '';
  const ts = typeof iso === 'string' ? Number(iso) || Date.parse(iso) : Number(iso);
  if (!ts || Number.isNaN(ts)) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function KanbanCard({
  task,
  terminal,
  maxIterations,
  autoMergeGlobal,
  autoFixGlobal,
  dimmed,
  highlighted,
  isDragging,
  isPending,
  onDragStart,
  onDragEnd,
  onClick,
  onRequeue,
  onToggleAutoMerge,
  onToggleAutoFix,
  onDelete,
}: KanbanCardProps) {
  const badge = autoFixBadge(task.autoFixState);
  const iteration = task.iterationCount || 0;
  const isEscalated = task.autoFixState === 'escalated';
  const override = task.autoMergeOverride;
  const effectiveAutoMerge = override === true || override === false ? override : autoMergeGlobal;
  const hasSession = !!task.agentSessionId;

  const fixOverride = task.autoFixOverride;
  const effectiveAutoFix = fixOverride === true || fixOverride === false ? fixOverride : autoFixGlobal;

  // "Active" = something is happening on this task right now. Three sources:
  //  1. agent is actively processing a prompt (terminal.isClaudeBusy)
  //  2. terminal is in claude-active mode (agent running even if idle between prompts)
  //  3. orchestrator is mid-fix for this task
  const agentBusy = !!terminal?.isClaudeBusy;
  const agentActive = terminal?.status === 'claude-active';
  const fixing = task.autoFixState === 'fixing';
  const isActive = agentBusy || agentActive || fixing;

  const handleAutoMergeToggle = () => {
    let next: boolean | null;
    if (override === null || override === undefined) next = autoMergeGlobal ? false : true;
    else if (override === true) next = false;
    else next = null;
    onToggleAutoMerge(task.id, next);
  };

  const handleAutoFixToggle = () => {
    let next: boolean | null;
    if (fixOverride === null || fixOverride === undefined) next = autoFixGlobal ? false : true;
    else if (fixOverride === true) next = false;
    else next = null;
    onToggleAutoFix(task.id, next);
  };

  const terminalStatusColor: Record<string, string> = {
    'idle': 'bg-[var(--text-muted)]',
    'running': 'bg-blue-400',
    'claude-active': 'bg-purple-400',
    'exited': 'bg-[var(--border)]',
  };

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', task.id);
        onDragStart(task.id);
        if (e.currentTarget instanceof HTMLElement) {
          e.currentTarget.style.opacity = '0.5';
        }
      }}
      onDragEnd={(e) => {
        onDragEnd();
        if (e.currentTarget instanceof HTMLElement) {
          e.currentTarget.style.opacity = '1';
        }
      }}
      onClick={onClick}
      className={cn(
        'group relative border rounded-lg bg-[var(--bg-primary)] p-3 cursor-grab active:cursor-grabbing transition-all',
        'hover:border-[var(--accent)]/50',
        isActive
          ? 'border-[var(--accent)]/60 ring-1 ring-[var(--accent)]/30 shadow-[0_0_0_3px_rgba(99,102,241,0.12)]'
          : 'border-[var(--border)]',
        isDragging && 'opacity-50',
        isPending && 'ring-1 ring-[var(--accent)]/50',
        dimmed && 'opacity-25 hover:opacity-60',
        highlighted && 'ring-2 ring-[var(--accent)] shadow-[0_0_0_4px_rgba(99,102,241,0.25)]',
      )}
    >
      {/* Top row: customId + ClickUp status + actions */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          {task.clickupCustomId && (
            <code className="text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded shrink-0">
              {task.clickupCustomId}
            </code>
          )}
          {task.clickupStatus && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
              style={{
                backgroundColor: `${task.clickupStatusColor || '#94a3b8'}20`,
                color: task.clickupStatusColor || '#94a3b8',
              }}
              title={`ClickUp status: ${task.clickupStatus}`}
            >
              {task.clickupStatus}
            </span>
          )}
          {isPending && (
            <span className="text-[10px] text-[var(--accent)] flex items-center gap-1">
              <Clock className="w-2.5 h-2.5 animate-pulse" />
              moving…
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleAutoFixToggle();
            }}
            title={
              fixOverride === true
                ? 'Auto-Fix FORCED ON for this task (click to disable, then clear)'
                : fixOverride === false
                  ? 'Auto-Fix DISABLED for this task (click to clear override)'
                  : autoFixGlobal
                    ? 'Auto-Fix follows global (on). Click to override OFF for this task.'
                    : 'Auto-Fix follows global (off). Click to override ON for this task.'
            }
            className={cn(
              'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-tertiary)] transition-all relative',
              fixOverride === true && 'opacity-100 text-green-400',
              fixOverride === false && 'opacity-100 text-red-400',
              fixOverride == null && 'text-[var(--text-muted)]',
            )}
          >
            <Wrench className="w-3 h-3" />
            {!effectiveAutoFix && (
              // Strike-through slash to signal "turned off"
              <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="block w-[14px] h-[1.5px] bg-current rotate-45 rounded-full" />
              </span>
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleAutoMergeToggle();
            }}
            title={
              override === true
                ? 'Auto-merge FORCED (click to disable, then clear)'
                : override === false
                  ? 'Auto-merge DISABLED (click to clear override)'
                  : autoMergeGlobal
                    ? 'Auto-merge follows global (on). Click to override OFF.'
                    : 'Auto-merge follows global (off). Click to override ON.'
            }
            className={cn(
              'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-tertiary)] transition-all',
              override === true && 'opacity-100 text-green-400',
              override === false && 'opacity-100 text-red-400',
              override == null && 'text-[var(--text-muted)]',
            )}
          >
            {effectiveAutoMerge ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              window.electronAPI.openExternal(task.clickupUrl);
            }}
            title="Open in ClickUp"
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Remove "${task.clickupName}" from your Kanban? The ClickUp task is not deleted.`)) {
                onDelete(task.id);
              }
            }}
            title="Remove from Kanban"
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400 transition-all"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Title */}
      <h3 className="text-sm text-[var(--text-primary)] leading-snug mb-2 line-clamp-3">
        {task.clickupName}
      </h3>

      {/* Auto-fix badge row */}
      {(badge || iteration > 0 || task.lastError) && (
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {badge && (
            <span className={cn('flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium', badge.className)}>
              <badge.icon className={cn('w-2.5 h-2.5', badge.spin && 'animate-spin')} />
              {badge.label}
            </span>
          )}
          {iteration > 0 && (
            <span
              title={`Fix attempt ${iteration} of ${maxIterations}`}
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded font-mono',
                iteration >= maxIterations
                  ? 'bg-red-500/10 text-red-400'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
              )}
            >
              {iteration}/{maxIterations}
            </span>
          )}
          {isEscalated && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRequeue(task.id);
              }}
              title="Reset iteration count and re-queue"
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
            >
              <RotateCw className="w-2.5 h-2.5" />
              Re-queue
            </button>
          )}
          {task.lastError && !isEscalated && (
            <span
              title={task.lastError}
              className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-orange-500/10 text-orange-400 max-w-full truncate"
            >
              {task.lastError.slice(0, 60)}
            </span>
          )}
        </div>
      )}

      {/* Priority / tags row */}
      {(task.clickupPriority || (task.clickupTags && task.clickupTags.length > 0)) && (
        <div className="flex items-center gap-1 flex-wrap mb-2">
          {task.clickupPriority && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-medium"
              style={{ backgroundColor: `${task.clickupPriority.color}20`, color: task.clickupPriority.color }}
            >
              {task.clickupPriority.name}
            </span>
          )}
          {(task.clickupTags || []).slice(0, 3).map((tag) => (
            <span
              key={tag.name}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ backgroundColor: tag.bgColor || 'var(--bg-tertiary)', color: tag.fgColor || 'var(--text-muted)' }}
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}

      {/* Footer: session + terminal + assignees + updated */}
      <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-[var(--border)]">
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] min-w-0">
          {terminal ? (
            <>
              {isActive ? (
                <>
                  <span className="relative flex w-2 h-2 shrink-0" title={agentBusy ? 'Agent processing…' : fixing ? 'Auto-fix running…' : 'Agent active'}>
                    <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-60 animate-ping" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--accent)]" />
                  </span>
                  <Loader2 className="w-3 h-3 shrink-0 animate-spin text-[var(--accent)]" />
                </>
              ) : (
                <>
                  <span
                    className={cn('w-1.5 h-1.5 rounded-full shrink-0', terminalStatusColor[terminal.status] || 'bg-[var(--text-muted)]')}
                  />
                  <TerminalIcon className="w-3 h-3 shrink-0" />
                </>
              )}
              <span className="truncate">{terminal.title}</span>
            </>
          ) : hasSession ? (
            <>
              <Play className="w-3 h-3 shrink-0 text-[var(--accent)]" />
              <span className="truncate">Resume session</span>
            </>
          ) : (
            <>
              <Play className="w-3 h-3 shrink-0" />
              <span className="italic">Click to start</span>
            </>
          )}
          {task.worktreeBranch && (
            <>
              <GitBranch className="w-3 h-3 shrink-0 ml-0.5" />
              <span className="truncate font-mono">{task.worktreeBranch}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {(task.clickupAssignees || []).slice(0, 3).map((a, i) => (
            <span
              key={a.id}
              title={a.username}
              className="w-4 h-4 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border)] text-[9px] font-medium text-[var(--text-muted)] flex items-center justify-center"
              style={{ marginLeft: i > 0 ? '-4px' : 0 }}
            >
              {a.initials || a.username.slice(0, 2).toUpperCase()}
            </span>
          ))}
          <span className="text-[10px] text-[var(--text-muted)] ml-1">{formatRelative(task.clickupUpdatedAt || task.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}
