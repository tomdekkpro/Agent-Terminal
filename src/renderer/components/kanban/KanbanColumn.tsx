import { useState, useMemo, useRef, useEffect } from 'react';
import { Loader2, Settings2, Check } from 'lucide-react';
import type { AppSettings, KanbanTask, KanbanTaskStatus } from '../../../shared/types';
import type { Terminal } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';
import { KanbanCard } from './KanbanCard';
import { cn } from '../../../shared/utils';

/** Which settings field holds the ClickUp status list mapped to each column. */
const COLUMN_SETTING_KEY: Record<KanbanTaskStatus, keyof AppSettings> = {
  'todo': 'kanbanBacklogStatuses',
  'in-progress': 'kanbanInProgressStatuses',
  'review': 'kanbanReviewStatuses',
  'failed': 'kanbanFailedStatuses',
  'done': 'kanbanDoneStatuses',
};

interface KanbanColumnProps {
  status: KanbanTaskStatus;
  label: string;
  color: string;
  tasks: KanbanTask[];
  terminalsByTaskId: Map<string, Terminal>;
  maxIterations: number;
  autoMergeGlobal: boolean;
  autoCodeGlobal: boolean;
  autoCodeFilter: 'coding' | 'awaiting-review' | 'escalated' | null;
  pendingMoves: Record<string, KanbanTaskStatus>;
  draggingTaskId: string | null;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onDrop: (to: KanbanTaskStatus) => void;
  /** Drop landed on a specific card. `position` says which side of the
   *  target card — used by the parent to allocate an orderIndex between
   *  neighbors. When this fires, the column's own onDrop should NOT also
   *  fire (cards stopPropagation). */
  onDropOnCard: (targetTaskId: string, position: 'before' | 'after', status: KanbanTaskStatus) => void;
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

  const settingKey = COLUMN_SETTING_KEY[status];
  const mappedStatuses = useSettingsStore((s) => s.settings[settingKey] as string);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState('');
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close the mapping popover on outside click / Escape
  useEffect(() => {
    if (!showSettings) return;
    const onClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setShowSettings(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowSettings(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [showSettings]);

  const openSettings = () => {
    setDraft(mappedStatuses || '');
    setShowSettings(true);
  };

  const saveMapping = () => {
    void updateSettings({ [settingKey]: draft.trim() });
    setShowSettings(false);
  };

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

        {/* Per-column status mapping */}
        <div className="relative shrink-0" ref={settingsRef}>
          <button
            onClick={() => (showSettings ? setShowSettings(false) : openSettings())}
            title={`Edit which ClickUp statuses map to "${label}"`}
            className={cn(
              'p-1 rounded transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]',
              showSettings && 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]',
            )}
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          {showSettings && (
            <div className="absolute z-50 top-full right-0 mt-1 w-64 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                <span className="text-xs font-medium text-[var(--text-primary)]">{label} — ClickUp statuses</span>
              </div>
              <p className="text-[10px] text-[var(--text-muted)] mb-2">
                Comma-separated, case-insensitive. Tasks with these ClickUp statuses land in this column.
              </p>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveMapping();
                }}
                rows={3}
                placeholder="e.g. in progress, developing"
                autoFocus
                className="w-full px-2 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none"
              />
              <div className="flex items-center justify-end gap-2 mt-2">
                <button
                  onClick={() => setShowSettings(false)}
                  className="px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={saveMapping}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
                >
                  <Check className="w-3 h-3" />
                  Save
                </button>
              </div>
            </div>
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
