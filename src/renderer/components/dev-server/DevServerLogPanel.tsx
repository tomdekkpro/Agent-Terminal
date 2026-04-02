import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Trash2, ArrowDown, Monitor, Server } from 'lucide-react';
import { useDevServerStore } from '../../stores/dev-server-store';
import { useSettingsStore } from '../../stores/settings-store';
import { cn } from '../../../shared/utils';
import type { DevServerType } from '../../../shared/types';

// Strip ANSI escape sequences (colors, cursor, etc.)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[^[\]]/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 220;
const MAX_HEIGHT = 500;

export function DevServerLogPanel() {
  const activeLog = useDevServerStore((s) => s.activeLog);
  const logs = useDevServerStore((s) => s.logs);
  const status = useDevServerStore((s) => s.status);
  const closeLog = useDevServerStore((s) => s.closeLog);
  const toggleLog = useDevServerStore((s) => s.toggleLog);
  const clearLog = useDevServerStore((s) => s.clearLog);
  const terminalFont = useSettingsStore((s) => s.settings.terminalFontFamily);
  const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);

  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);

  const projectId = activeLog?.projectId ?? '';
  const type = activeLog?.type ?? 'frontend';
  const k = `${projectId}:${type}`;
  const entries = activeLog ? (logs[k] || []) : [];
  const serverStatus = activeLog ? (status[projectId]?.[type] || 'stopped') : 'stopped';

  const otherType: DevServerType = type === 'frontend' ? 'backend' : 'frontend';
  const otherStatus = activeLog ? status[projectId]?.[otherType] : undefined;

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }, []);

  // Resize drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { startY: e.clientY, startH: height };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startY - ev.clientY;
      const newH = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, resizeRef.current.startH + delta));
      setHeight(newH);
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [height]);

  if (!activeLog) return null;

  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg-primary)] flex flex-col" style={{ height }}>
      {/* Resize handle */}
      <div
        className="h-1 cursor-ns-resize hover:bg-[var(--accent)]/30 transition-colors shrink-0"
        onMouseDown={handleResizeStart}
      />

      {/* Header */}
      <div className="h-8 flex items-center justify-between px-3 bg-[var(--bg-secondary)] border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-1">
          {/* Tab for current type */}
          <button
            className={cn(
              'flex items-center gap-1 px-2 h-6 rounded text-[10px] font-medium transition-all',
              type === 'frontend'
                ? 'bg-[#22c55e]/15 text-[#22c55e]'
                : 'bg-[#6366f1]/15 text-[#6366f1]',
            )}
          >
            {type === 'frontend' ? <Monitor className="w-3 h-3" /> : <Server className="w-3 h-3" />}
            <span>{type === 'frontend' ? 'Frontend' : 'Backend'}</span>
            <span className={cn(
              'w-1.5 h-1.5 rounded-full ml-1',
              serverStatus === 'running' ? 'bg-[#22c55e]' :
              serverStatus === 'starting' ? 'bg-[#f59e0b] animate-pulse' :
              serverStatus === 'error' ? 'bg-[#ef4444]' : 'bg-[var(--text-muted)]/40',
            )} />
          </button>

          {/* Tab for other type if it has status */}
          {otherStatus && otherStatus !== 'stopped' && (
            <button
              onClick={() => toggleLog(projectId, otherType)}
              className="flex items-center gap-1 px-2 h-6 rounded text-[10px] font-medium text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] transition-all"
            >
              {otherType === 'frontend' ? <Monitor className="w-3 h-3" /> : <Server className="w-3 h-3" />}
              <span>{otherType === 'frontend' ? 'Frontend' : 'Backend'}</span>
              <span className={cn(
                'w-1.5 h-1.5 rounded-full ml-1',
                otherStatus === 'running' ? 'bg-[#22c55e]' :
                otherStatus === 'starting' ? 'bg-[#f59e0b] animate-pulse' :
                otherStatus === 'error' ? 'bg-[#ef4444]' : 'bg-[var(--text-muted)]/40',
              )} />
            </button>
          )}

          <span className="text-[10px] text-[var(--text-muted)] ml-2">
            {entries.length} lines
          </span>
        </div>

        <div className="flex items-center gap-1">
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }}
              className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] transition-all"
              title="Scroll to bottom"
            >
              <ArrowDown className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={() => clearLog(projectId, type)}
            className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] transition-all"
            title="Clear logs"
          >
            <Trash2 className="w-3 h-3" />
          </button>
          <button
            onClick={closeLog}
            className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] transition-all"
            title="Close log panel"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto leading-[1.5] px-3 py-1 select-text"
        style={{ fontFamily: terminalFont, fontSize: Math.max(terminalFontSize - 2, 10) }}
      >
        {entries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-xs">
            {serverStatus === 'stopped' ? 'Server is stopped' : 'Waiting for output...'}
          </div>
        ) : (
          entries.map((entry, i) => (
            <div key={i} className="whitespace-pre-wrap break-all text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]/50">
              {stripAnsi(entry.text.endsWith('\n') ? entry.text.slice(0, -1) : entry.text)}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
