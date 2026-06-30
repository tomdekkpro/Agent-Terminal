import { useState, useMemo } from 'react';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import type { KanbanTask } from '../../../shared/types';
import type { Terminal } from '../../stores/terminal-store';
import { KanbanCard } from './KanbanCard';
import { cn } from '../../../shared/utils';

interface KanbanColumnProps {
  /** ClickUp status name — the column maps 1-1 to this status. */
  status: string;
  label: string;
  color: string;
  tasks: KanbanTask[];
  terminalsByTaskId: Map<string, Terminal>;
  maxIterations: number;
  autoMergeGlobal: boolean;
  autoCodeGlobal: boolean;
  autoCodeFilter: 'coding' | 'awaiting-review' | 'escalated' | null;
  pendingMoves: Record<string, string>;
  /** When true the column renders as a thin rail (cards not mounted). */
  collapsed: boolean;
  onToggleCollapse: (status: string) => void;
  draggingTaskId: string | null;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDrop: (to: string) => void;
  /** Drop landed on a specific card. `position` says which side of the
   *  target card — used by the parent to allocate an orderIndex between
   *  neighbors. When this fires, the column's own onDrop should NOT also
   *  fire (cards stopPropagation). */
  onDropOnCard: (targetTaskId: string, position: 'before' | 'after', status: string) => void;
  onCardClick: (task: KanbanTask) => void;
  onRequeue: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onToggleAutoMerge: (taskId: string, override: boolean | null) => void;
  onToggleAutoCode: (taskId: string, enabled: boolean) => void;
  onDelete: (taskId: string) => void;
}

export function KanbanColumn({
  status,
  label,
  color,
  tasks,
  terminalsByTaskId,
  maxIterations,
  autoMergeGlobal,
  autoCodeGlobal,
  autoCodeFilter,
  pendingMoves,
  collapsed,
  onToggleCollapse,
  draggingTaskId,
  onDragStart,
  onDragEnd,
  onDrop,
  onDropOnCard,
  onCardClick,
  onRequeue,
  onRunNow,
  onToggleAutoMerge,
  onToggleAutoCode,
  onDelete,
}: KanbanColumnProps) {
  const [isOver, setIsOver] = useState(false);

  const activeCount = useMemo(() => {
    let n = 0;
    for (const task of tasks) {
      const term = terminalsByTaskId.get(task.clickupTaskId);
      if (term?.isClaudeBusy || term?.status === 'claude-active' || task.autoCodeState === 'coding') {
        n++;
      }
    }
    return n;
  }, [tasks, terminalsByTaskId]);

  // Collapsed: a thin rail showing the accent cap, count and a vertical label.
  // Cards aren't mounted (lighter render) but the column still accepts drops.
  if (collapsed) {
    return (
      <div
        onClick={() => onToggleCollapse(status)}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setIsOver(true); }}
        onDragLeave={(e) => { if (e.currentTarget.contains(e.relatedTarget as Node)) return; setIsOver(false); }}
        onDrop={(e) => { e.preventDefault(); setIsOver(false); onDrop(status); }}
        title={`Expand "${label}" — ${tasks.length} task${tasks.length !== 1 ? 's' : ''}`}
        className={cn(
          'group flex flex-col items-center w-11 shrink-0 rounded-2xl border overflow-hidden glass-card cursor-pointer transition-all duration-200',
          isOver ? 'border-[var(--accent)]/60 ring-2 ring-[var(--accent)]/50' : 'border-[var(--border)] hover:border-[var(--accent)]/40',
        )}
      >
        <div className="h-[3px] w-full shrink-0" style={{ background: `linear-gradient(90deg, ${color}, transparent)`, boxShadow: `0 0 14px -2px ${color}` }} />
        <div className="flex flex-col items-center gap-2 py-3 flex-1">
          <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors" />
          <span className="font-mono-ui text-[10px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)]/80 rounded-full px-1.5 py-0.5">
            {tasks.length}
          </span>
          <span
            className="font-display text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-secondary)] [writing-mode:vertical-rl] rotate-180 whitespace-nowrap"
            style={{ textShadow: `0 0 10px ${color}55` }}
          >
            {label}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setIsOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setIsOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        onDrop(status);
      }}
      className={cn(
        'flex flex-col w-72 shrink-0 rounded-2xl border overflow-hidden transition-all duration-200 glass-card',
        isOver ? 'border-[var(--accent)]/60 ring-2 ring-[var(--accent)]/50' : 'border-[var(--border)]',
      )}
    >
      {/* Status-colored luminous cap — the column's 1-1 ClickUp status identity */}
      <div
        className="h-[3px] w-full shrink-0"
        style={{ background: `linear-gradient(90deg, ${color}, ${color}33 70%, transparent)`, boxShadow: `0 0 14px -2px ${color}` }}
      />
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: color, boxShadow: `0 0 8px 0 ${color}` }}
          />
          <h2 className="font-display text-xs font-semibold text-[var(--text-primary)] uppercase tracking-[0.08em] truncate" title={label}>
            {label}
          </h2>
          <span className="font-mono-ui text-[10px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)]/80 rounded-full px-1.5 py-0.5 shrink-0">
            {tasks.length}
          </span>
          {activeCount > 0 && (
            <span
              className="flex items-center gap-1 text-[10px] font-medium text-[var(--accent)] bg-[var(--accent)]/10 rounded-full px-1.5 py-0.5 shrink-0"
              title={`${activeCount} active`}
            >
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              {activeCount}
            </span>
          )}
        </div>
        <button
          onClick={() => onToggleCollapse(status)}
          title={`Collapse "${label}"`}
          className="shrink-0 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-24">
        {tasks.length === 0 && (
          <div className="text-center text-[10px] text-[var(--text-muted)] italic py-6">
            Drop here
          </div>
        )}
        {tasks.map((task) => {
          // The "awaiting QC" badge counts both awaiting-review and merging
          // (waiting + not done), so its filter must highlight both too.
          const matchesFilter = autoCodeFilter
            ? autoCodeFilter === 'awaiting-review'
              ? task.autoCodeState === 'awaiting-review' || task.autoCodeState === 'merging'
              : task.autoCodeState === autoCodeFilter
            : true;
          return (
            <KanbanCard
              key={task.id}
              task={task}
              terminal={terminalsByTaskId.get(task.clickupTaskId)}
              maxIterations={maxIterations}
              autoMergeGlobal={autoMergeGlobal}
              autoCodeGlobal={autoCodeGlobal}
              dimmed={!!autoCodeFilter && !matchesFilter}
              highlighted={!!autoCodeFilter && matchesFilter}
              isDragging={draggingTaskId === task.id}
              isPending={task.id in pendingMoves}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDropOnCard={(targetId, position) => onDropOnCard(targetId, position, status)}
              onClick={() => onCardClick(task)}
              onRequeue={onRequeue}
              onRunNow={onRunNow}
              onToggleAutoMerge={onToggleAutoMerge}
              onToggleAutoCode={onToggleAutoCode}
              onDelete={onDelete}
            />
          );
        })}
      </div>
    </div>
  );
}
