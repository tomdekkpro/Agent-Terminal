import { useState, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { KanbanTask, KanbanTaskStatus } from '../../../shared/types';
import type { Terminal } from '../../stores/terminal-store';
import { KanbanCard } from './KanbanCard';
import { cn } from '../../../shared/utils';

interface KanbanColumnProps {
  status: KanbanTaskStatus;
  label: string;
  color: string;
  tasks: KanbanTask[];
  terminalsByTaskId: Map<string, Terminal>;
  maxIterations: number;
  autoMergeGlobal: boolean;
  autoFixGlobal: boolean;
  autoFixFilter: 'fixing' | 'awaiting-qc' | 'escalated' | null;
  pendingMoves: Record<string, KanbanTaskStatus>;
  draggingTaskId: string | null;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDrop: (to: KanbanTaskStatus) => void;
  onCardClick: (task: KanbanTask) => void;
  onRequeue: (taskId: string) => void;
  onToggleAutoMerge: (taskId: string, override: boolean | null) => void;
  onToggleAutoFix: (taskId: string, override: boolean | null) => void;
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
  autoFixGlobal,
  autoFixFilter,
  pendingMoves,
  draggingTaskId,
  onDragStart,
  onDragEnd,
  onDrop,
  onCardClick,
  onRequeue,
  onToggleAutoMerge,
  onToggleAutoFix,
  onDelete,
}: KanbanColumnProps) {
  const [isOver, setIsOver] = useState(false);

  const activeCount = useMemo(() => {
    let n = 0;
    for (const task of tasks) {
      const term = terminalsByTaskId.get(task.clickupTaskId);
      if (term?.isClaudeBusy || term?.status === 'claude-active' || task.autoFixState === 'fixing') {
        n++;
      }
    }
    return n;
  }, [tasks, terminalsByTaskId]);

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
        'flex flex-col w-72 shrink-0 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]',
        isOver && 'ring-2 ring-[var(--accent)]/60',
      )}
    >
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <h2 className="text-sm font-medium text-[var(--text-primary)] uppercase tracking-wide truncate">
            {label}
          </h2>
          <span className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded-full px-1.5 py-0.5 shrink-0">
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
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-24">
        {tasks.length === 0 && (
          <div className="text-center text-[10px] text-[var(--text-muted)] italic py-6">
            Drop here
          </div>
        )}
        {tasks.map((task) => {
          const matchesFilter = autoFixFilter ? task.autoFixState === autoFixFilter : true;
          return (
            <KanbanCard
              key={task.id}
              task={task}
              terminal={terminalsByTaskId.get(task.clickupTaskId)}
              maxIterations={maxIterations}
              autoMergeGlobal={autoMergeGlobal}
              autoFixGlobal={autoFixGlobal}
              dimmed={!!autoFixFilter && !matchesFilter}
              highlighted={!!autoFixFilter && matchesFilter}
              isDragging={draggingTaskId === task.id}
              isPending={task.id in pendingMoves}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onClick={() => onCardClick(task)}
              onRequeue={onRequeue}
              onToggleAutoMerge={onToggleAutoMerge}
              onToggleAutoFix={onToggleAutoFix}
              onDelete={onDelete}
            />
          );
        })}
      </div>
    </div>
  );
}
