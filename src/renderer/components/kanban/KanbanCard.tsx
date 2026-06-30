import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
  FolderOpen,
  Zap,
  ChevronDown,
  Check,
  Rocket,
} from 'lucide-react';
import type { KanbanTask, AutoCodeTaskState } from '../../../shared/types';
import type { Terminal } from '../../stores/terminal-store';
import { useKanbanStore } from '../../stores/kanban-store';
import { cn } from '../../../shared/utils';

interface KanbanCardProps {
  task: KanbanTask;
  terminal?: Terminal;
  maxIterations: number;
  autoMergeGlobal: boolean;
  autoCodeGlobal: boolean;
  /** When a filter is active, non-matching cards get dimmed */
  dimmed?: boolean;
  /** When a filter is active, matching cards get a strong highlight ring */
  highlighted?: boolean;
  isDragging: boolean;
  isPending: boolean;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  /** Drop fired ON this card. `position` says whether the dragged item was
   *  released on the top half ('before') or bottom half ('after'). The
   *  parent uses this to compute an orderIndex between neighbors. */
  onDropOnCard?: (targetTaskId: string, position: 'before' | 'after') => void;
  onClick: () => void;
  onRequeue: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onToggleAutoMerge: (taskId: string, override: boolean | null) => void;
  onToggleAutoCode: (taskId: string, enabled: boolean) => void;
  onDelete: (taskId: string) => void;
}

function autoCodeBadge(state: AutoCodeTaskState): {
  label: string;
  icon: typeof Wrench;
  className: string;
  spin?: boolean;
} | null {
  switch (state) {
    case 'coding':
      return { label: 'Coding', icon: Loader2, className: 'bg-blue-500/10 text-blue-400', spin: true };
    case 'awaiting-review':
      return { label: 'In Review', icon: Clock, className: 'bg-yellow-500/10 text-yellow-400' };
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
  autoCodeGlobal,
  dimmed,
  highlighted,
  isDragging,
  isPending,
  onDragStart,
  onDragEnd,
  onDropOnCard,
  onClick,
  onRequeue,
  onRunNow,
  onToggleAutoMerge,
  onToggleAutoCode,
  onDelete,
}: KanbanCardProps) {
  /** Drop indicator state — set during dragover, cleared on dragleave/drop.
   *  Renders a thin highlighted line above ('before') or below ('after')
   *  the card so the user sees where the released item will land. */
  const [insertHint, setInsertHint] = useState<'before' | 'after' | null>(null);

  // Inline status dropdown — change ClickUp status straight from the card.
  // Rendered through a portal (fixed position) so the column's scroll doesn't
  // clip it. Reads the board's statuses + write-back action from the store.
  const statuses = useKanbanStore((s) => s.statuses);
  const moveTask = useKanbanStore((s) => s.moveTask);
  const [statusMenu, setStatusMenu] = useState<{ top: number; left: number } | null>(null);
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!statusMenu) return;
    const onDown = (e: MouseEvent) => {
      if (statusMenuRef.current?.contains(e.target as Node)) return;
      setStatusMenu(null);
    };
    const onScroll = () => setStatusMenu(null);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [statusMenu]);

  const openStatusMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = statusBtnRef.current?.getBoundingClientRect();
    if (!r) return;
    setStatusMenu({ top: r.bottom + 4, left: r.left });
  };
  const pickStatus = (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    setStatusMenu(null);
    if (name.trim().toLowerCase() !== (task.clickupStatus || '').trim().toLowerCase()) {
      void moveTask(task.id, name);
    }
  };

  const badge = autoCodeBadge(task.autoCodeState);
  const iteration = task.iterationCount || 0;
  const isEscalated = task.autoCodeState === 'escalated';
  const override = task.autoMergeOverride;
  const effectiveAutoMerge = override === true || override === false ? override : autoMergeGlobal;
  const hasSession = !!task.agentSessionId;

  // Strict opt-in: auto-code only follows tasks explicitly enabled (default off).
  // Local tasks have no ClickUp QC signal, so the toggle is hidden for them.
  const autoCodeOn = task.autoCodeEnabled === true;
  const canAutoCode = task.provider !== 'local';

  // "Active" = something is happening on this task right now. Three sources:
  //  1. agent is actively processing a prompt (terminal.isClaudeBusy)
  //  2. terminal is in claude-active mode (agent running even if idle between prompts)
  //  3. orchestrator is mid-fix for this task
  const agentBusy = !!terminal?.isClaudeBusy;
  const agentActive = terminal?.status === 'claude-active';
  const fixing = task.autoCodeState === 'coding';
  const isActive = agentBusy || agentActive || fixing;

  const handleAutoMergeToggle = () => {
    let next: boolean | null;
    if (override === null || override === undefined) next = autoMergeGlobal ? false : true;
    else if (override === true) next = false;
    else next = null;
    onToggleAutoMerge(task.id, next);
  };

  const handleAutoCodeToggle = () => {
    onToggleAutoCode(task.id, !autoCodeOn);
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
      onDragOver={(e) => {
        if (!onDropOnCard) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const half = rect.top + rect.height / 2;
        setInsertHint(e.clientY < half ? 'before' : 'after');
      }}
      onDragLeave={() => setInsertHint(null)}
      onDrop={(e) => {
        if (!onDropOnCard) return;
        e.preventDefault();
        e.stopPropagation(); // don't bubble to column's "drop at end" handler
        const rect = e.currentTarget.getBoundingClientRect();
        const half = rect.top + rect.height / 2;
        const position: 'before' | 'after' = e.clientY < half ? 'before' : 'after';
        setInsertHint(null);
        onDropOnCard(task.id, position);
      }}
      onClick={onClick}
      className={cn(
        'group lift relative border rounded-xl bg-[var(--bg-card)] p-3 cursor-grab active:cursor-grabbing shadow-[var(--shadow-card)]',
        'hover:border-[var(--accent)]/50 hover:shadow-[var(--shadow-float)]',
        isActive
          ? 'border-[var(--accent)]/60 ring-1 ring-[var(--accent)]/30 shadow-[0_0_0_3px_rgba(124,140,255,0.14)]'
          : 'border-[var(--border)]',
        isDragging && 'opacity-50',
        isPending && 'ring-1 ring-[var(--accent)]/50',
        dimmed && 'opacity-25 hover:opacity-60',
        highlighted && 'ring-2 ring-[var(--accent)] shadow-[0_0_0_4px_rgba(99,102,241,0.25)]',
      )}
    >
      {/* Drop position indicator — thin line above/below to show where the
          dragged card will land if released. */}
      {insertHint === 'before' && (
        <div className="absolute -top-1 left-0 right-0 h-0.5 bg-[var(--accent)] rounded-full pointer-events-none" />
      )}
      {insertHint === 'after' && (
        <div className="absolute -bottom-1 left-0 right-0 h-0.5 bg-[var(--accent)] rounded-full pointer-events-none" />
      )}
      {/* Top row: customId + ClickUp status + actions */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          {task.clickupCustomId && (
            <code className="font-mono-ui text-[10px] text-[var(--accent)] bg-[var(--accent-soft)] px-1.5 py-0.5 rounded shrink-0">
              {task.clickupCustomId}
            </code>
          )}
          {task.clickupStatus && (
            statuses.length > 0 ? (
              <button
                ref={statusBtnRef}
                onClick={openStatusMenu}
                className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide hover:brightness-125 transition"
                style={{
                  backgroundColor: `${task.clickupStatusColor || '#94a3b8'}20`,
                  color: task.clickupStatusColor || '#94a3b8',
                }}
                title={`Status: ${task.clickupStatus} — click to change`}
              >
                {task.clickupStatus}
                <ChevronDown className="w-2.5 h-2.5 opacity-70" />
              </button>
            ) : (
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
            )
          )}
          {isPending && (
            <span className="text-[10px] text-[var(--accent)] flex items-center gap-1">
              <Clock className="w-2.5 h-2.5 animate-pulse" />
              moving…
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {canAutoCode && task.autoCodeState !== 'coding' && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRunNow(task.id);
              }}
              title="Run Auto Code now — implement or fix this task immediately (if its ClickUp status allows), without waiting for the next poll"
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--accent)]/10 text-[var(--text-muted)] hover:text-[var(--accent)] transition-all"
            >
              <Zap className="w-3 h-3" />
            </button>
          )}
          {canAutoCode && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleAutoCodeToggle();
              }}
              title={
                autoCodeOn
                  ? autoCodeGlobal
                    ? 'Auto Code ENABLED for this task — it implements from the description and fixes QC feedback automatically (click to disable)'
                    : 'Auto Code enabled for this task, but the global Auto Code switch is OFF in Settings — nothing will run until it\'s turned on'
                  : 'Auto Code off (default). Click to enroll this task in the auto-code loop.'
              }
              className={cn(
                'opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-tertiary)] transition-all relative',
                autoCodeOn ? 'opacity-100 text-green-400' : 'text-[var(--text-muted)]',
              )}
            >
              <Wrench className="w-3 h-3" />
              {!autoCodeOn && (
                // Strike-through slash to signal "turned off"
                <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="block w-[14px] h-[1.5px] bg-current rotate-45 rounded-full" />
                </span>
              )}
            </button>
          )}
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
          {task.projectPath && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                void window.electronAPI.openPath(task.projectPath);
              }}
              title={`Open project folder: ${task.projectPath}`}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
            >
              <FolderOpen className="w-3 h-3" />
            </button>
          )}
          {task.clickupUrl && task.provider !== 'local' && (
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
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              const msg = task.provider === 'local'
                ? `Delete "${task.clickupName}"? This local task cannot be recovered.`
                : `Remove "${task.clickupName}" from your Kanban? The ClickUp task is not deleted.`;
              if (confirm(msg)) {
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
      <h3 className="font-display text-sm font-medium text-[var(--text-primary)] leading-snug mb-2 line-clamp-3">
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

      {/* Priority / release / tags row */}
      {(task.clickupPriority || task.clickupReleaseVersion || (task.clickupTags && task.clickupTags.length > 0)) && (
        <div className="flex items-center gap-1 flex-wrap mb-2">
          {task.clickupReleaseVersion && (
            <span
              className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono-ui font-medium"
              style={{ backgroundColor: 'rgba(34, 211, 238, 0.12)', color: 'var(--accent-2)' }}
              title={`Release version: ${task.clickupReleaseVersion}`}
            >
              <Rocket className="w-2.5 h-2.5" />
              {task.clickupReleaseVersion}
            </span>
          )}
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
                  <span className="relative flex w-2 h-2 shrink-0" title={agentBusy ? 'Agent processing…' : fixing ? 'Auto Code running…' : 'Agent active'}>
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
          {task.useWorktree === false ? (
            <span
              className="flex items-center gap-1 shrink-0 text-amber-400"
              title="No worktree — runs on the project's checked-out branch"
            >
              <GitBranch className="w-3 h-3" />
              <span className="text-[10px]">current branch</span>
            </span>
          ) : (
            <>
              {task.worktreeBranch && (
                <>
                  <GitBranch className="w-3 h-3 shrink-0 ml-0.5" />
                  <span className="truncate font-mono">{task.worktreeBranch}</span>
                </>
              )}
              {task.baseBranch && (
                <span
                  className="truncate font-mono text-[var(--text-muted)] shrink-0"
                  title={`Worktree forked from ${task.baseBranch} — merge/PR target`}
                >
                  ← {task.baseBranch}
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {task.usage && (task.usage.cost > 0 || task.usage.outputTokens > 0) && (
            <span
              className="text-[10px] font-mono font-semibold text-emerald-400 shrink-0 mr-1"
              title={
                `Session usage${task.usage.model ? ` (${task.usage.model})` : ''}\n` +
                `Input:        ${task.usage.inputTokens.toLocaleString()} tokens\n` +
                `Output:       ${task.usage.outputTokens.toLocaleString()} tokens\n` +
                `Cache write:  ${task.usage.cacheCreationTokens.toLocaleString()} tokens\n` +
                `Cache read:   ${task.usage.cacheReadTokens.toLocaleString()} tokens\n` +
                `Cost:         $${task.usage.cost.toFixed(4)}`
              }
            >
              ${task.usage.cost.toFixed(2)}
            </span>
          )}
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

      {/* Status dropdown — portal so it floats above the column's scroll clip */}
      {statusMenu && createPortal(
        <div
          ref={statusMenuRef}
          className="fixed z-[100] min-w-[180px] max-h-72 overflow-y-auto glass-card border border-[var(--border)] rounded-lg shadow-xl py-1"
          style={{ top: statusMenu.top, left: statusMenu.left }}
        >
          <div className="px-3 py-1 text-[9px] font-display uppercase tracking-wider text-[var(--text-muted)]">
            Set status
          </div>
          {statuses.map((s) => {
            const active = s.name.trim().toLowerCase() === (task.clickupStatus || '').trim().toLowerCase();
            return (
              <button
                key={s.name}
                onClick={(e) => pickStatus(e, s.name)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--bg-tertiary)] transition-colors',
                  active && 'bg-[var(--accent-soft)]',
                )}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color, boxShadow: `0 0 6px 0 ${s.color}` }} />
                <span className="truncate flex-1 text-left text-[var(--text-primary)]">{s.name}</span>
                {active && <Check className="w-3 h-3 text-[var(--accent)] shrink-0" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
