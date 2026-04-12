import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Monitor, Server } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useDevServerStore } from '../../stores/dev-server-store';
import { registerOutputCallback, unregisterOutputCallback } from '../../stores/terminal-store';
import { cn } from '../../../shared/utils';
import type { DevServerType } from '../../../shared/types';

const TERMINAL_THEME = {
  background: '#0f0f23',
  foreground: '#e2e8f0',
  cursor: '#e2e8f0',
  cursorAccent: '#0f0f23',
  selectionBackground: '#6366f140',
  selectionForeground: '#e2e8f0',
  black: '#1e1e3a',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#f8fafc',
};

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 260;
const MAX_HEIGHT = 500;

export function DevServerLogPanel() {
  const activeLog = useDevServerStore((s) => s.activeLog);
  const status = useDevServerStore((s) => s.status);
  const terminalIds = useDevServerStore((s) => s.terminalIds);
  const closeLog = useDevServerStore((s) => s.closeLog);
  const toggleLog = useDevServerStore((s) => s.toggleLog);

  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const bufferRef = useRef<string[]>([]);
  const readyRef = useRef(false);
  const activeKeyRef = useRef<string | null>(null);

  const projectId = activeLog?.projectId ?? '';
  const type = activeLog?.type ?? 'frontend';
  const k = `${projectId}:${type}`;
  const terminalId = activeLog ? terminalIds[k] : undefined;
  const serverStatus = activeLog ? (status[projectId]?.[type] || 'stopped') : 'stopped';

  const otherType: DevServerType = type === 'frontend' ? 'backend' : 'frontend';
  const otherKey = `${projectId}:${otherType}`;
  const otherStatus = activeLog ? status[projectId]?.[otherType] : undefined;
  const otherTerminalId = activeLog ? terminalIds[otherKey] : undefined;

  /** Safe write — xterm can throw if renderer isn't fully ready */
  const safeWrite = useCallback((data: string) => {
    try {
      if (xtermRef.current && readyRef.current) {
        xtermRef.current.write(data);
      } else {
        bufferRef.current.push(data);
      }
    } catch {
      bufferRef.current.push(data);
    }
  }, []);

  // Create / tear down xterm when panel opens or the active terminal changes
  useEffect(() => {
    if (!activeLog || !terminalId || !containerRef.current) return;
    const currentKey = `${activeLog.projectId}:${activeLog.type}:${terminalId}`;

    // Skip if already showing this terminal
    if (activeKeyRef.current === currentKey && xtermRef.current) return;

    // Cleanup previous xterm if switching terminals
    if (xtermRef.current) {
      if (activeKeyRef.current) {
        const prevTid = activeKeyRef.current.split(':').slice(2).join(':');
        unregisterOutputCallback(prevTid);
      }
      xtermRef.current.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      readyRef.current = false;
      bufferRef.current = [];
    }

    activeKeyRef.current = currentKey;
    const container = containerRef.current;
    const tid = terminalId;

    // Register output callback early to buffer data
    registerOutputCallback(tid, (data) => safeWrite(data));

    const xterm = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'Cascadia Code, Consolas, Courier New, monospace',
      lineHeight: 1.2,
      theme: TERMINAL_THEME,
      allowProposedApi: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      window.electronAPI?.openExternal?.(uri);
    });

    xterm.loadAddon(fitAddon);
    xterm.loadAddon(webLinksAddon);

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    requestAnimationFrame(() => {
      if (!xtermRef.current || !container) return;
      try {
        xterm.open(container);
      } catch {
        xtermRef.current = null;
        fitAddonRef.current = null;
        return;
      }

      requestAnimationFrame(() => {
        if (!fitAddonRef.current || !xtermRef.current) return;
        try { fitAddonRef.current.fit(); } catch { /* not ready */ }
        readyRef.current = true;

        // Flush buffered output
        if (bufferRef.current.length > 0) {
          const pending = bufferRef.current.splice(0);
          for (const data of pending) {
            try { xtermRef.current!.write(data); } catch { /* skip */ }
          }
          // Re-fit after flushing buffered data to ensure dimensions are correct
          try { fitAddonRef.current!.fit(); } catch { /* not ready */ }
        }

        // Resize the PTY to match the panel (read cols/rows after flush + re-fit)
        const cols = xtermRef.current.cols;
        const rows = xtermRef.current.rows;
        if (cols > 0 && rows > 0) {
          window.electronAPI.resizeTerminal(tid, cols, rows);
        }
      });
    });

    // Forward keyboard input to the PTY
    xterm.onData((data) => {
      window.electronAPI.sendTerminalInput(tid, data);
    });

    return () => {
      unregisterOutputCallback(tid);
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
        fitAddonRef.current = null;
        readyRef.current = false;
        bufferRef.current = [];
      }
      activeKeyRef.current = null;
    };
  }, [activeLog, terminalId, safeWrite]);

  // Re-fit xterm when panel height changes
  useEffect(() => {
    if (!fitAddonRef.current || !readyRef.current || !terminalId) return;
    // Delay to let the DOM settle after resize
    const timer = setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        if (xtermRef.current && terminalId) {
          const cols = xtermRef.current.cols;
          const rows = xtermRef.current.rows;
          if (cols > 0 && rows > 0) {
            window.electronAPI.resizeTerminal(terminalId, cols, rows);
          }
        }
      } catch { /* ignore */ }
    }, 50);
    return () => clearTimeout(timer);
  }, [height, terminalId]);

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

          {/* Tab for other type if it has a running terminal */}
          {otherTerminalId && otherStatus && otherStatus !== 'stopped' && (
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
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={closeLog}
            className="flex items-center gap-1 px-1.5 h-5 rounded text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] transition-all"
            title="Close log panel"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{ minHeight: 0 }}
      />
    </div>
  );
}
