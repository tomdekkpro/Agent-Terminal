import { useCallback, useRef, useState } from 'react';
import { CommentsPanel } from './CommentsPanel';
import { cn } from '../../../shared/utils';

interface CommentsSplitLayoutProps {
  /** The content the comments sit beside — a terminal, or whatever the host
   *  surface shows in its place (e.g. the Auto Code progress panel). */
  children: React.ReactNode;
  taskId: string;
  taskLabel?: string;
  taskName?: string;
  taskUrl?: string;
  projectPath?: string;
  onClose: () => void;
  onSendToAgent?: (text: string) => void;
}

/**
 * Side-by-side layout for the comments panel, with a draggable splitter —
 * the same shape as ChangesSplitLayout so opening Comments behaves exactly
 * like opening Changes: the terminal gives up half its width instead of being
 * covered by an overlay.
 */
export function CommentsSplitLayout({
  children,
  taskId,
  taskLabel,
  taskName,
  taskUrl,
  projectPath,
  onClose,
  onSendToAgent,
}: CommentsSplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [splitPercent, setSplitPercent] = useState(55);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);

    const onMouseMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      setSplitPercent(Math.min(Math.max((x / rect.width) * 100, 20), 80));
    };

    const onMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  return (
    <div ref={containerRef} className="flex h-full relative">
      {/* While dragging, this swallows mouse events so the terminal below
          doesn't start a text selection mid-drag. */}
      {isDragging && <div className="absolute inset-0 z-50 cursor-col-resize" />}

      <div className="relative min-w-0 min-h-0" style={{ width: `${splitPercent}%` }}>
        {children}
      </div>

      <div
        className={cn(
          'w-1.5 shrink-0 cursor-col-resize relative group transition-colors',
          isDragging ? 'bg-[var(--accent)]' : 'bg-[var(--border)] hover:bg-[var(--accent)]',
        )}
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-y-0 -left-2 -right-2 z-10" />
      </div>

      <div className="min-w-0 min-h-0" style={{ width: `${100 - splitPercent}%` }}>
        <CommentsPanel
          fill
          taskId={taskId}
          taskLabel={taskLabel}
          taskName={taskName}
          taskUrl={taskUrl}
          projectPath={projectPath}
          onClose={onClose}
          onSendToAgent={onSendToAgent}
        />
      </div>
    </div>
  );
}
