import { useEffect, useRef, useState, useCallback } from 'react';
import { Bot, X, ExternalLink, GitBranch, GitMerge, GitPullRequest, GitCommitVertical, Play, Square, Clock, Smartphone, Copy, Check, Eraser, ChevronDown, ImagePlus, FileImage, File as FileIcon, Link, GripVertical, RotateCcw, Trash2, Terminal as TerminalIcon, FolderOpen, Eye, EyeOff, ArrowRight, Loader2, Zap, MessageSquare, CheckCircle2, ListTodo } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import QRCode from 'qrcode';
import { registerOutputCallback, unregisterOutputCallback, getAndClearSavedBuffer, useTerminalStore, type Terminal } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';
import type { AgentProviderId, AgentProviderMeta } from '../../../shared/types';
import { cn } from '../../../shared/utils';
import { SkillsDropdown } from './SkillsDropdown';
import { postTimeEntriesByDate } from '../../utils/time-tracking';

/** Format milliseconds to HH:MM:SS */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface TerminalPanelProps {
  terminal: Terminal;
  isActive: boolean;
  isSplit?: boolean;
  agentProviders: AgentProviderMeta[];
  skills?: import('../../../shared/types').ProjectSkill[];
  onInvokeAgent: (skipPermissions?: boolean) => void;
  onProviderChange: (provider: AgentProviderId) => void;
  onInvokeSkill?: (skill: import('../../../shared/types').ProjectSkill) => void;
  onMergeComplete?: () => void;
  onLinkTask?: () => void;
  onBaseBranchChange?: (branch: string) => void;
  availableBranches?: string[];
  onClose?: () => void;
  onFocus?: () => void;
  onDragHandleStart?: (e: React.DragEvent) => void;
  onDragHandleEnd?: (e: React.DragEvent) => void;
  isDraggedOver?: boolean;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico']);

/** Actions dropdown — sends prompt-based actions to the agent terminal */
function ActionsDropdown({ terminal, isSplit, onMergeComplete }: {
  terminal: Terminal;
  isSplit?: boolean;
  onMergeComplete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const sendPrompt = (prompt: string) => {
    window.electronAPI.sendTerminalInput(terminal.id, prompt + '\n');
    setOpen(false);
  };

  const isAgent = terminal.isClaudeMode;
  const taskLabel = terminal.task?.customId || terminal.task?.id || '';

  const actions: { icon: React.ReactNode; label: string; description?: string; action: () => void; agentOnly?: boolean }[] = [
    {
      icon: <GitMerge className="w-3.5 h-3.5" />,
      label: 'Complete Task',
      description: 'Merge, create PR, or push code',
      action: () => { setOpen(false); onMergeComplete(); },
    },
    {
      icon: <GitCommitVertical className="w-3.5 h-3.5" />,
      label: 'Commit Changes',
      action: () => sendPrompt(`Please commit all changes with a descriptive commit message based on what was changed.`),
      agentOnly: true,
    },
    {
      icon: <GitPullRequest className="w-3.5 h-3.5" />,
      label: 'Create PR',
      action: () => sendPrompt(`Please commit all changes, push the current branch to origin, and create a pull request. Use a descriptive title and summary based on the changes.`),
      agentOnly: true,
    },
    {
      icon: <MessageSquare className="w-3.5 h-3.5" />,
      label: 'Post Root Cause & Solution',
      description: `Comment on ${taskLabel}`,
      action: () => sendPrompt(`Please analyze the changes made in this session and post a comment to ClickUp task ${terminal.task?.id} summarizing the root cause of the issue and the solution. Include relevant file changes.`),
      agentOnly: true,
    },
    {
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      label: 'Set Ready for Review',
      description: `Update ${taskLabel} status`,
      action: () => sendPrompt(`Please update the ClickUp task ${terminal.task?.id} status to "ready for review".`),
      agentOnly: true,
    },
    {
      icon: <ListTodo className="w-3.5 h-3.5" />,
      label: 'Summarize Work',
      action: () => sendPrompt(`Please summarize all the work done in this session: what was changed, which files were modified, and any remaining items.`),
      agentOnly: true,
    },
  ];

  const visibleActions = isAgent ? actions : actions.filter((a) => !a.agentOnly);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
        title="Task actions"
      >
        <Zap className="w-3.5 h-3.5" />
        {!isSplit && 'Actions'}
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-30 py-1 overflow-hidden">
          {visibleActions.map((a, i) => (
            <button
              key={i}
              onClick={(e) => { e.stopPropagation(); a.action(); }}
              className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              <span className="mt-0.5 text-[var(--text-muted)]">{a.icon}</span>
              <div className="min-w-0">
                <div className="text-xs text-[var(--text-primary)]">{a.label}</div>
                {a.description && (
                  <div className="text-[10px] text-[var(--text-muted)] truncate">{a.description}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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

export function TerminalPanel({ terminal, isActive, isSplit, agentProviders, skills, onInvokeAgent, onProviderChange, onInvokeSkill, onMergeComplete, onLinkTask, onBaseBranchChange, availableBranches, onClose, onFocus, onDragHandleStart, onDragHandleEnd, isDraggedOver }: TerminalPanelProps) {
  const currentProvider = agentProviders.find((p) => p.id === terminal.agentProvider) || agentProviders[0];
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const readyRef = useRef(false);
  const bufferRef = useRef<string[]>([]);
  const needsResumRef = useRef(terminal.needsResume ?? false);

  // Drag and drop state
  const [isDragOver, setIsDragOver] = useState(false);
  interface DroppedFile { name: string; path: string; isImage: boolean; thumbnailUrl?: string; }
  const [droppedFiles, setDroppedFiles] = useState<DroppedFile[]>([]);
  const droppedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Provider dropdown
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  const initObserverRef = useRef<ResizeObserver | null>(null);

  // Remote control URL capture
  const rcBufferRef = useRef<string | null>(null);
  const rcTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // Time tracking
  const startTimer = useTerminalStore((s) => s.startTimer);
  const stopTimer = useTerminalStore((s) => s.stopTimer);
  const tracking = terminal.timeTracking;
  const isTimerRunning = !!tracking?.startedAt;

  // Keep needsResume ref in sync so xterm closure can read it
  useEffect(() => {
    needsResumRef.current = terminal.needsResume ?? false;
  }, [terminal.needsResume]);

  // Live elapsed display — tick every second while running
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isTimerRunning) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isTimerRunning]);

  const currentElapsed = tracking
    ? tracking.elapsed + (tracking.startedAt ? now - tracking.startedAt : 0)
    : 0;

  // Today's elapsed — only time tracked today (from API + current session's today-portion)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayMidnight = new Date(now).setHours(0, 0, 0, 0);
  const prevTodayMs = tracking && tracking.todayDate === todayStr ? (tracking.todayMs || 0) : 0;
  const sessionTodayMs = tracking?.startedAt
    ? Math.max(0, now - Math.max(tracking.startedAt, todayMidnight))
    : 0;
  const todayElapsed = prevTodayMs + sessionTodayMs;

  const handleToggleTimer = useCallback(async () => {
    if (isTimerRunning) {
      const result = stopTimer(terminal.id);
      // Sync session time to task manager, split by calendar day
      if (result && result.sessionStartMs && terminal.task) {
        const sessionMs = result.sessionEndMs - result.sessionStartMs;
        if (sessionMs > 0) {
          try {
            await postTimeEntriesByDate(terminal.task.id, result.sessionStartMs, result.sessionEndMs);
          } catch { /* non-critical */ }
        }
      }
    } else {
      startTimer(terminal.id);
    }
  }, [isTimerRunning, terminal.id, terminal.task, startTimer, stopTimer]);

  // Inline title rename state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);

  // Base branch picker state
  const [showBaseBranchMenu, setShowBaseBranchMenu] = useState(false);
  const baseBranchMenuRef = useRef<HTMLDivElement>(null);

  // Close provider dropdown on outside click
  useEffect(() => {
    if (!showProviderMenu) return;
    const handler = (e: MouseEvent) => {
      if (providerMenuRef.current && !providerMenuRef.current.contains(e.target as Node)) {
        setShowProviderMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showProviderMenu]);

  // Close base branch dropdown on outside click
  useEffect(() => {
    if (!showBaseBranchMenu) return;
    const handler = (e: MouseEvent) => {
      if (baseBranchMenuRef.current && !baseBranchMenuRef.current.contains(e.target as Node)) {
        setShowBaseBranchMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBaseBranchMenu]);

  /** Safe fit — xterm can throw if renderer isn't fully ready */
  const safeFit = () => {
    try {
      if (fitAddonRef.current && xtermRef.current && readyRef.current) {
        fitAddonRef.current.fit();
      }
    } catch { /* xterm renderer not ready yet */ }
  };

  /** Safe write — xterm can throw if renderer isn't fully ready */
  const safeWrite = (data: string) => {
    try {
      if (xtermRef.current && readyRef.current) {
        xtermRef.current.write(data);
      } else {
        bufferRef.current.push(data);
      }
    } catch {
      bufferRef.current.push(data);
    }
  };

  // Initialize xterm — deferred until container has non-zero dimensions
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    let disposed = false;

    // Restore saved output from previous session (before live data arrives)
    const savedBuffer = getAndClearSavedBuffer(terminal.id);
    if (savedBuffer) {
      bufferRef.current.push(savedBuffer);
      bufferRef.current.push('\r\n\x1b[90m--- Session restored ---\x1b[0m\r\n\r\n');
    }

    // Buffer output from the very start, before xterm even exists
    registerOutputCallback(terminal.id, (data) => {
      safeWrite(data);
      // Capture remote control URL from output
      if (rcBufferRef.current !== null) {
        rcBufferRef.current += data;
        // Strip ANSI escape codes and match URL
        const clean = rcBufferRef.current.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        const urlMatch = clean.match(/https:\/\/\S+/);
        if (urlMatch) {
          const url = urlMatch[0].replace(/[)\]}>.,;:!?'"+]+$/, '');
          setRemoteUrl(url);
          setCopied(false);
          rcBufferRef.current = null;
          if (rcTimeoutRef.current) { clearTimeout(rcTimeoutRef.current); rcTimeoutRef.current = null; }
        }
      }
    });

    const doInit = () => {
      if (disposed || xtermRef.current) return;

      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return; // not visible yet

      // Container is visible — disconnect init observer
      if (initObserverRef.current) {
        initObserverRef.current.disconnect();
        initObserverRef.current = null;
      }

      const xterm = new XTerm({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 14,
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

      // Open xterm inside rAF to ensure container is fully laid out
      requestAnimationFrame(() => {
        if (disposed || !xtermRef.current || !containerRef.current) return;

        try {
          xterm.open(containerRef.current);
        } catch {
          // open failed — container still not ready, retry
          xtermRef.current = null;
          fitAddonRef.current = null;
          setTimeout(() => doInit(), 100);
          return;
        }

        // Double rAF: wait for xterm's internal renderer to initialize
        requestAnimationFrame(() => {
          if (disposed || !fitAddonRef.current || !xtermRef.current) return;

          try {
            fitAddonRef.current.fit();
          } catch { /* renderer not ready */ }

          xtermRef.current.focus();
          readyRef.current = true;

          // Load WebGL renderer if GPU acceleration is enabled
          const gpuEnabled = useSettingsStore.getState().settings.terminalGpuAcceleration;
          if (gpuEnabled) {
            try {
              const addon = new WebglAddon();
              addon.onContextLoss(() => {
                // WebGL context lost — dispose and fall back to DOM renderer
                addon.dispose();
                webglAddonRef.current = null;
              });
              xtermRef.current!.loadAddon(addon);
              webglAddonRef.current = addon;
              // WebGL addon changes renderer metrics — re-fit to sync dimensions
              try { fitAddonRef.current!.fit(); } catch { /* not ready */ }
            } catch {
              // WebGL not supported — silently fall back to DOM renderer
            }
          }

          // Flush buffered output
          if (bufferRef.current.length > 0) {
            const pending = bufferRef.current.splice(0);
            for (const data of pending) {
              try { xtermRef.current!.write(data); } catch { /* skip */ }
            }
            // Re-fit after flushing buffered data to ensure dimensions are correct
            try { fitAddonRef.current!.fit(); } catch { /* not ready */ }
          }

          // Read final cols/rows after all addons loaded and buffer flushed
          const cols = xtermRef.current.cols;
          const rows = xtermRef.current.rows;
          if (cols > 0 && rows > 0) {
            window.electronAPI.resizeTerminal(terminal.id, cols, rows);
          }
        });
      });

      // Handle input — block while restore/resume banner is pending
      xterm.onData((data) => {
        if (needsResumRef.current) return;
        window.electronAPI.sendTerminalInput(terminal.id, data);
      });

      // Handle resize
      xterm.onResize(({ cols, rows }) => {
        window.electronAPI.resizeTerminal(terminal.id, cols, rows);
      });

      // Copy/paste handling + block input while resume banner is shown
      xterm.attachCustomKeyEventHandler((event) => {
        if (needsResumRef.current) return false; // block all keys while pending
        const isMod = event.metaKey || event.ctrlKey;

        if (event.key === 'Enter' && event.shiftKey && !isMod && event.type === 'keydown') {
          xterm.input('\x1b\n');
          return false;
        }

        if (isMod && (event.key === 'c' || event.key === 'C') && event.type === 'keydown') {
          if (xterm.hasSelection()) {
            const selection = xterm.getSelection();
            if (selection) navigator.clipboard.writeText(selection);
            return false;
          }
          return true;
        }

        if (event.ctrlKey && (event.key === 'v' || event.key === 'V') && event.type === 'keydown') {
          event.preventDefault();
          navigator.clipboard.readText().then((text) => {
            if (text) xterm.paste(text);
          });
          return false;
        }

        return true;
      });
    };

    // Try init after a frame, otherwise wait via ResizeObserver
    requestAnimationFrame(() => {
      if (disposed || xtermRef.current) return;
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        doInit();
      } else {
        initObserverRef.current = new ResizeObserver(() => {
          doInit();
        });
        initObserverRef.current.observe(container);
      }
    });

    return () => {
      disposed = true;
      unregisterOutputCallback(terminal.id);
      readyRef.current = false;
      bufferRef.current = [];
      rcBufferRef.current = null;
      if (rcTimeoutRef.current) { clearTimeout(rcTimeoutRef.current); rcTimeoutRef.current = null; }
      if (droppedTimerRef.current) { clearTimeout(droppedTimerRef.current); droppedTimerRef.current = null; }
      if (initObserverRef.current) { initObserverRef.current.disconnect(); initObserverRef.current = null; }
      if (webglAddonRef.current) { webglAddonRef.current.dispose(); webglAddonRef.current = null; }
      if (fitAddonRef.current) { fitAddonRef.current.dispose(); fitAddonRef.current = null; }
      if (xtermRef.current) { xtermRef.current.dispose(); xtermRef.current = null; }
    };
  }, [terminal.id, terminal.needsRestore]);

  // Fit on visibility change
  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    if (!xtermRef.current || !readyRef.current) return;

    requestAnimationFrame(() => {
      safeFit();
      xtermRef.current?.focus();
    });
  }, [isActive]);

  // Resize observer for ongoing resizes (only when xterm is ready)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let resizeTimeout: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (readyRef.current && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            safeFit();
          }
        }
      }, 80);
    });

    observer.observe(container);
    return () => {
      clearTimeout(resizeTimeout);
      observer.disconnect();
    };
  }, []);

  // Generate QR code when remoteUrl changes
  useEffect(() => {
    if (!remoteUrl) { setQrDataUrl(null); return; }
    QRCode.toDataURL(remoteUrl, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [remoteUrl]);

  // Drag and drop — attach native DOM listeners with capture to intercept before xterm

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    let dragCounter = 0;

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounter++;
      const hasFiles = e.dataTransfer?.types.includes('Files');
      const hasFilePath = e.dataTransfer?.types.includes('application/x-file-path');
      if (hasFiles || hasFilePath) {
        setIsDragOver(true);
      }
    };

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        setIsDragOver(false);
      }
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      dragCounter = 0;

      // Handle file path drag from FilesPanel
      const filePathData = e.dataTransfer?.getData('application/x-file-path');
      if (filePathData) {
        const needsQuoting = /[\s'"$`\\!&|;(){}]/.test(filePathData);
        const quoted = needsQuoting ? `"${filePathData.replace(/["$`\\]/g, '\\$&')}"` : filePathData;
        window.electronAPI.sendTerminalInput(terminal.id, quoted + ' ');
        if (xtermRef.current) xtermRef.current.focus();
        return;
      }

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const collected: DroppedFile[] = [];
      const pathStrings: string[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        let filePath: string | undefined;
        try {
          filePath = window.electronAPI.getPathForFile(file);
        } catch {
          filePath = (file as any).path;
        }
        if (!filePath) continue;

        const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
        const isImage = IMAGE_EXTENSIONS.has(ext);

        let thumbnailUrl: string | undefined;
        if (isImage) {
          thumbnailUrl = URL.createObjectURL(file);
        }

        collected.push({ name: file.name, path: filePath, isImage, thumbnailUrl });
        const needsQuoting = /[\s'"$`\\!&|;(){}]/.test(filePath);
        pathStrings.push(needsQuoting ? `"${filePath.replace(/["$`\\]/g, '\\$&')}"` : filePath);
      }

      if (pathStrings.length === 0) return;

      setDroppedFiles(collected);
      if (droppedTimerRef.current) clearTimeout(droppedTimerRef.current);
      droppedTimerRef.current = setTimeout(() => {
        setDroppedFiles((prev) => {
          for (const f of prev) {
            if (f.thumbnailUrl) URL.revokeObjectURL(f.thumbnailUrl);
          }
          return [];
        });
      }, 4000);

      const text = pathStrings.join(' ') + ' ';
      window.electronAPI.sendTerminalInput(terminal.id, text);
      if (xtermRef.current) xtermRef.current.focus();
    };

    // Use capture phase so we intercept before xterm's own handlers
    el.addEventListener('dragenter', onDragEnter, true);
    el.addEventListener('dragover', onDragOver, true);
    el.addEventListener('dragleave', onDragLeave, true);
    el.addEventListener('drop', onDrop, true);

    return () => {
      el.removeEventListener('dragenter', onDragEnter, true);
      el.removeEventListener('dragover', onDragOver, true);
      el.removeEventListener('dragleave', onDragLeave, true);
      el.removeEventListener('drop', onDrop, true);
    };
  }, [terminal.id]);

  return (
    <div ref={panelRef} className="flex flex-col h-full relative" onClick={onFocus}>
      {/* Terminal toolbar */}
      <div className={cn(
        'h-9 bg-[var(--bg-card)] border-b border-[var(--border)] flex items-center px-3 justify-between shrink-0',
        isSplit && isActive && 'border-b-[var(--accent)]',
        isDraggedOver && 'ring-2 ring-[var(--accent)] ring-inset',
      )}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isSplit && onDragHandleStart && (
            <div
              draggable
              onDragStart={onDragHandleStart}
              onDragEnd={onDragHandleEnd}
              className="cursor-grab active:cursor-grabbing shrink-0 -ml-1 p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              title="Drag to reorder"
            >
              <GripVertical className="w-3.5 h-3.5" />
            </div>
          )}
          {isEditingTitle ? (
            <input
              className="text-xs text-[var(--text-primary)] bg-transparent outline-none border-b border-[var(--accent)] truncate shrink-0 py-0 w-[120px]"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = editTitle.trim();
                  if (trimmed) updateTerminal(terminal.id, { title: trimmed });
                  setIsEditingTitle(false);
                } else if (e.key === 'Escape') {
                  setIsEditingTitle(false);
                }
              }}
              onBlur={() => {
                const trimmed = editTitle.trim();
                if (trimmed) updateTerminal(terminal.id, { title: trimmed });
                setIsEditingTitle(false);
              }}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : !terminal.task ? (
            <span
              className="text-xs text-[var(--text-secondary)] truncate shrink-0"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setIsEditingTitle(true);
                setEditTitle(terminal.title);
              }}
            >
              {terminal.title}
            </span>
          ) : null}
          {terminal.task && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (terminal.task?.url) window.electronAPI?.openExternal?.(terminal.task.url);
              }}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] hover:opacity-80 transition-opacity min-w-0 shrink"
              style={{
                backgroundColor: `${terminal.task.statusColor}20`,
                color: terminal.task.statusColor,
              }}
              title={`${terminal.task.name} — Click to open task`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: terminal.task.statusColor }}
              />
              {terminal.task.customId && (
                <span className="font-mono shrink-0">{terminal.task.customId}</span>
              )}
              <span className="truncate">{terminal.task.name}</span>
              <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
            </button>
          )}
          {terminal.worktreePath && (
            <span
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] bg-violet-500/15 text-violet-300 border border-violet-500/20 shrink-0"
              title={`Worktree: ${terminal.worktreePath}${terminal.worktreeBranch ? `\nBranch: ${terminal.worktreeBranch}` : ''}`}
            >
              <GitBranch className="w-2.5 h-2.5" />
              <span className="uppercase tracking-wide font-medium text-[9px]">Worktree</span>
              {terminal.worktreeBranch && (
                <span className="font-mono opacity-80">{terminal.worktreeBranch}</span>
              )}
            </span>
          )}
          {/* Base branch indicator */}
          {terminal.task && terminal.baseBranch && (
            <div className="relative shrink-0" ref={baseBranchMenuRef}>
              <button
                onClick={(e) => { e.stopPropagation(); setShowBaseBranchMenu(!showBaseBranchMenu); }}
                className="flex items-center gap-1 text-[10px] text-emerald-400/70 hover:text-emerald-400 transition-colors"
                title="Base branch — click to change"
              >
                <ArrowRight className="w-2.5 h-2.5" />
                <span className="font-mono">{terminal.baseBranch}</span>
                <ChevronDown className="w-2.5 h-2.5 opacity-50" />
              </button>
              {showBaseBranchMenu && availableBranches && (
                <div className="absolute top-full left-0 mt-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-20 max-h-[200px] overflow-y-auto min-w-[140px]">
                  {availableBranches.map((branch) => (
                    <button
                      key={branch}
                      onClick={(e) => {
                        e.stopPropagation();
                        onBaseBranchChange?.(branch);
                        setShowBaseBranchMenu(false);
                      }}
                      className={cn(
                        'w-full text-left px-3 py-1.5 text-xs font-mono transition-colors flex items-center gap-1.5',
                        branch === terminal.baseBranch
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                      )}
                    >
                      <GitBranch className="w-2.5 h-2.5 shrink-0 text-[var(--text-muted)]" />
                      {branch}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!terminal.task && !terminal.worktreePath && isSplit && (
            <span className="text-[10px] text-[var(--text-muted)] truncate">{terminal.cwd || '~'}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Time tracker */}
          {terminal.task && (
            <div className="flex items-center gap-1 mr-1">
              <button
                onClick={(e) => { e.stopPropagation(); handleToggleTimer(); }}
                className={cn(
                  'w-6 h-6 rounded-md flex items-center justify-center transition-colors',
                  isTimerRunning
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-sky-500/20 text-sky-400 hover:bg-sky-500/30'
                )}
                title={isTimerRunning ? 'Stop timer & sync time' : 'Start time tracking'}
              >
                {isTimerRunning ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              </button>
              {(todayElapsed > 0 || isTimerRunning) && (
                <span className={cn(
                  'text-[11px] font-mono tabular-nums',
                  isTimerRunning ? 'text-red-400' : 'text-[var(--text-muted)]'
                )}>
                  <Clock className="w-3 h-3 inline-block mr-0.5 -mt-px" />
                  {formatElapsed(todayElapsed)}
                </span>
              )}
            </div>
          )}
          {terminal.task && onMergeComplete && (
            <ActionsDropdown
              terminal={terminal}
              isSplit={isSplit}
              onMergeComplete={onMergeComplete}
            />
          )}
          {!terminal.task && onLinkTask && (
            <button
              onClick={(e) => { e.stopPropagation(); onLinkTask(); }}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
              title="Link a task to this terminal"
            >
              <Link className="w-3 h-3" />
              {!isSplit && 'Link Task'}
            </button>
          )}
          {!terminal.isClaudeMode && (
            <>
              {/* Provider dropdown */}
              <div className="relative" ref={providerMenuRef}>
                <button
                  onClick={(e) => { e.stopPropagation(); setShowProviderMenu(!showProviderMenu); }}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors"
                  title="Select AI provider"
                >
                  <Bot className="w-3 h-3" />
                  {!isSplit && (currentProvider?.displayName || terminal.agentProvider)}
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showProviderMenu && (
                  <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl overflow-hidden max-h-60 overflow-y-auto">
                    {agentProviders.map((p) => (
                      <button
                        key={p.id}
                        onClick={(e) => { e.stopPropagation(); onProviderChange(p.id); setShowProviderMenu(false); }}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors',
                          terminal.agentProvider === p.id ? 'font-medium' : 'text-[var(--text-secondary)]'
                        )}
                        style={terminal.agentProvider === p.id ? { color: p.color } : undefined}
                      >
                        <Bot className="w-3.5 h-3.5" />
                        {p.displayName}
                        {!p.available && <span className="text-[9px] text-[var(--text-muted)] ml-auto">(N/A)</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Skills dropdown */}
              {skills && skills.length > 0 && onInvokeSkill && (
                <SkillsDropdown skills={skills} onInvokeSkill={onInvokeSkill} />
              )}
              {/* Start button */}
              <button
                onClick={(e) => { e.stopPropagation(); onInvokeAgent(); }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors"
                style={{
                  backgroundColor: `${currentProvider?.color || '#6366f1'}20`,
                  color: currentProvider?.color || '#6366f1',
                }}
                title={`Start ${currentProvider?.displayName || terminal.agentProvider}`}
              >
                <Bot className="w-3.5 h-3.5" />
                {!isSplit && 'Start'}
              </button>
              {/* YOLO button — only for agents with yolo capability */}
              {currentProvider?.capabilities.yolo && (
                <button
                  onClick={(e) => { e.stopPropagation(); onInvokeAgent(true); }}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
                  title={`Start ${currentProvider.displayName} (skip permissions)`}
                >
                  <Bot className="w-3.5 h-3.5" />
                  {!isSplit && 'YOLO'}
                </button>
              )}
            </>
          )}
          {terminal.isClaudeMode && (
            <>
              {/* Mobile button — only for agents with remoteControl */}
              {currentProvider?.capabilities.remoteControl && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    rcBufferRef.current = '';
                    if (rcTimeoutRef.current) clearTimeout(rcTimeoutRef.current);
                    rcTimeoutRef.current = setTimeout(() => { rcBufferRef.current = null; rcTimeoutRef.current = null; }, 15000);
                    window.electronAPI.sendTerminalInput(terminal.id, '/remote-control');
                    setTimeout(() => window.electronAPI.sendTerminalInput(terminal.id, '\r'), 50);
                  }}
                  disabled={terminal.isClaudeBusy}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors',
                    terminal.isClaudeBusy
                      ? 'bg-[var(--text-muted)]/10 text-[var(--text-muted)] cursor-not-allowed opacity-50'
                      : 'bg-violet-500/20 text-violet-400 hover:bg-violet-500/30'
                  )}
                  title={terminal.isClaudeBusy ? `Wait for ${currentProvider.displayName} to finish` : 'Open remote control (mobile access)'}
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  {!isSplit && 'Mobile'}
                </button>
              )}
              {/* Clear button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.electronAPI.sendTerminalInput(terminal.id, '\x15');
                }}
                disabled={terminal.isClaudeBusy}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors',
                  terminal.isClaudeBusy
                    ? 'bg-[var(--text-muted)]/10 text-[var(--text-muted)] cursor-not-allowed opacity-50'
                    : 'bg-orange-500/20 text-orange-400 hover:bg-orange-500/30'
                )}
                title={terminal.isClaudeBusy ? `Wait for ${currentProvider?.displayName || 'agent'} to finish` : 'Clear input text'}
              >
                <Eraser className="w-3.5 h-3.5" />
                {!isSplit && 'Clear'}
              </button>
              {/* Active indicator */}
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs"
                style={{
                  backgroundColor: `${currentProvider?.color || '#22c55e'}20`,
                  color: currentProvider?.color || '#22c55e',
                }}
              >
                <Bot className={cn('w-3.5 h-3.5', terminal.isClaudeBusy && 'animate-pulse')} />
                {!isSplit && (terminal.isClaudeBusy ? 'Thinking...' : `${currentProvider?.displayName || 'Agent'} Active`)}
              </div>
            </>
          )}
          {/* Changes toggle */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              const store = useTerminalStore.getState();
              store.togglePreview(terminal.id);
            }}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors',
              terminal.previewOpen
                ? 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]/80'
            )}
            title={terminal.previewOpen ? 'Close changes panel' : 'Show code changes'}
          >
            <GitCommitVertical className="w-3.5 h-3.5" />
            {!isSplit && 'Changes'}
          </button>
          {isSplit && onClose && (
            <button
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--error)]/20 hover:text-[var(--error)] text-[var(--text-muted)] transition-all"
              title="Close terminal"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Remote control dialog */}
      {remoteUrl && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => { e.stopPropagation(); setRemoteUrl(null); }}
        >
          <div
            className="bg-[#1a1a2e] border border-violet-500/30 rounded-xl p-6 shadow-2xl flex flex-col items-center gap-4 max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-violet-300">
              <Smartphone className="w-5 h-5" />
              <span className="text-sm font-medium">Remote Control</span>
            </div>

            <div className="bg-white rounded-lg p-3">
              {qrDataUrl
                ? <img src={qrDataUrl} alt="QR Code" className="w-[180px] h-[180px]" />
                : <div className="w-[180px] h-[180px] flex items-center justify-center text-xs text-[var(--text-muted)]">Generating...</div>
              }
            </div>

            <p className="text-[11px] text-[var(--text-muted)] text-center">
              Scan with your phone or copy the link below
            </p>

            <div className="flex items-center gap-2 w-full bg-[#0f0f23] rounded-lg px-3 py-2 border border-[var(--border)]">
              <span className="text-[11px] text-violet-300 font-mono truncate flex-1 select-all">{remoteUrl}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(remoteUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] transition-colors shrink-0',
                  copied
                    ? 'bg-emerald-500/20 text-emerald-400'
                    : 'bg-violet-500/20 text-violet-300 hover:bg-violet-500/30'
                )}
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <div className="flex gap-2 w-full">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  window.electronAPI?.openExternal?.(remoteUrl);
                }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in Browser
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setRemoteUrl(null); }}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-[var(--text-muted)]/10 text-[var(--text-muted)] hover:bg-[var(--text-muted)]/20 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drop overlay — acts as the actual drop target so xterm can't swallow the event */}
      {isDragOver && (
        <div
          className="absolute inset-0 z-40 flex items-center justify-center bg-[#0f0f23]/80 backdrop-blur-sm border-2 border-dashed border-[var(--accent)] rounded-lg"
          onDragOver={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragOver(false);

            // Handle file path drag from FilesPanel
            const filePathData = e.dataTransfer?.getData('application/x-file-path');
            if (filePathData) {
              const needsQuoting = /[\s'"$`\\!&|;(){}]/.test(filePathData);
              const quoted = needsQuoting ? `"${filePathData.replace(/["$`\\]/g, '\\$&')}"` : filePathData;
              window.electronAPI.sendTerminalInput(terminal.id, quoted + ' ');
              if (xtermRef.current) xtermRef.current.focus();
              return;
            }

            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) return;

            const collected: DroppedFile[] = [];
            const pathStrings: string[] = [];

            for (let i = 0; i < files.length; i++) {
              const file = files[i];
              let filePath: string | undefined;
              try {
                filePath = window.electronAPI.getPathForFile(file);
              } catch {
                filePath = (file as any).path;
              }
              if (!filePath) continue;

              const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
              const isImage = IMAGE_EXTENSIONS.has(ext);

              let thumbnailUrl: string | undefined;
              if (isImage) {
                thumbnailUrl = URL.createObjectURL(file);
              }

              collected.push({ name: file.name, path: filePath, isImage, thumbnailUrl });
              const needsQuoting = /[\s'"$`\\!&|;(){}]/.test(filePath);
              pathStrings.push(needsQuoting ? `"${filePath.replace(/["$`\\]/g, '\\$&')}"` : filePath);
            }

            if (pathStrings.length === 0) return;

            setDroppedFiles(collected);
            if (droppedTimerRef.current) clearTimeout(droppedTimerRef.current);
            droppedTimerRef.current = setTimeout(() => {
              setDroppedFiles((prev) => {
                for (const f of prev) {
                  if (f.thumbnailUrl) URL.revokeObjectURL(f.thumbnailUrl);
                }
                return [];
              });
            }, 4000);

            const text = pathStrings.join(' ') + ' ';
            window.electronAPI.sendTerminalInput(terminal.id, text);
            if (xtermRef.current) xtermRef.current.focus();
          }}
        >
          <div className="flex flex-col items-center gap-3 text-[var(--accent)] pointer-events-none">
            <ImagePlus className="w-10 h-10 drop-shadow-lg" />
            <span className="text-sm font-medium">Drop to paste file path</span>
          </div>
        </div>
      )}

      {/* Dropped files toast — shows image thumbnails + file names */}
      {droppedFiles.length > 0 && (
        <div className="absolute bottom-3 right-3 z-40 flex flex-col gap-2 animate-in slide-in-from-bottom-2 fade-in duration-200">
          {droppedFiles.map((f, i) => (
            <div
              key={i}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-[#1a1a2e]/95 border border-[var(--accent)]/30 shadow-xl backdrop-blur-sm max-w-[320px]"
            >
              {f.isImage && f.thumbnailUrl ? (
                <img
                  src={f.thumbnailUrl}
                  alt={f.name}
                  className="w-10 h-10 rounded object-cover border border-white/10 shrink-0"
                />
              ) : (
                <div className="w-10 h-10 rounded bg-[var(--accent)]/10 flex items-center justify-center shrink-0">
                  <FileIcon className="w-5 h-5 text-[var(--accent)]" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs text-[var(--text-primary)] font-medium truncate">{f.name}</div>
                <div className="text-[10px] text-[var(--text-muted)] truncate font-mono">{f.path}</div>
              </div>
              {f.isImage && (
                <FileImage className="w-3.5 h-3.5 text-[var(--accent)] shrink-0 opacity-60" />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Terminal container */}
      {terminal.needsRestore ? (
        <RestoreBanner terminal={terminal} />
      ) : (
        <div className="flex-1 relative">
          <div ref={containerRef} className="absolute inset-0 bg-[#0f0f23] p-1" />
          {terminal.isResuming && (
            <div className="absolute inset-0 z-10 bg-[#0f0f23]/80 backdrop-blur-sm flex items-center justify-center">
              <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] shadow-2xl">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
                <span className="text-sm text-[var(--text-secondary)]">
                  {terminal.agentSessionId ? 'Resuming session...' : 'Starting agent...'}
                </span>
              </div>
            </div>
          )}
          {terminal.needsResume && (
            <ResumeBanner terminal={terminal} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Restore Banner ────────────────────────────────────────────

function RestoreBanner({ terminal }: { terminal: Terminal }) {
  const activateTerminal = useTerminalStore((s) => s.activateTerminal);
  const discardTerminal = useTerminalStore((s) => s.discardTerminal);
  const [restoring, setRestoring] = useState(false);

  const handleRestore = async () => {
    setRestoring(true);
    await activateTerminal(terminal.id);
  };

  return (
    <div className="flex-1 bg-[#0f0f23] flex items-center justify-center">
      <div className="max-w-sm w-full mx-4 text-center space-y-4">
        {/* Icon */}
        <div className="flex justify-center">
          <div className="w-14 h-14 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center">
            {terminal.agentSessionId ? (
              <Bot className="w-7 h-7 text-emerald-400" />
            ) : (
              <TerminalIcon className="w-7 h-7 text-blue-400" />
            )}
          </div>
        </div>

        {/* Info */}
        <div>
          <h3 className="text-sm font-medium text-[var(--text-primary)] mb-1">
            {terminal.title}
          </h3>
          {terminal.cwd && (
            <p className="text-[11px] text-[var(--text-muted)] flex items-center justify-center gap-1 font-mono">
              <FolderOpen className="w-3 h-3" />
              {terminal.cwd}
            </p>
          )}
          {terminal.needsRestore && (
            <p className="text-[11px] text-emerald-400/70 mt-1">
              Agent: {terminal.agentProvider}
              {terminal.skipPermissions && ' • YOLO'}
              {terminal.agentSessionId
                ? <span className="text-[10px] text-[var(--text-muted)] ml-1 font-mono">({terminal.agentSessionId})</span>
                : <span className="text-[10px] text-amber-400/70 ml-1">(no session — will use --continue)</span>
              }
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => discardTerminal(terminal.id)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--border)] text-sm text-[var(--text-muted)] hover:text-red-400 hover:border-red-400/30 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Discard
          </button>
          <button
            onClick={handleRestore}
            disabled={restoring}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-60"
          >
            {restoring ? (
              <>
                <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                Restoring...
              </>
            ) : (
              <>
                <RotateCcw className="w-3.5 h-3.5" />
                Restore
              </>
            )}
          </button>
        </div>

        <p className="text-[10px] text-[var(--text-muted)] opacity-60">
          Previous session from last run
        </p>
      </div>
    </div>
  );
}

// ─── Resume Banner (overlay on terminal) ──────────────────────

function ResumeBanner({ terminal }: { terminal: Terminal }) {
  const resumeTerminalAgent = useTerminalStore((s) => s.resumeTerminalAgent);
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);
  const [resuming, setResuming] = useState(false);

  const handleResume = async () => {
    setResuming(true);
    await resumeTerminalAgent(terminal.id);
  };

  const handleDismiss = () => {
    updateTerminal(terminal.id, { needsResume: false });
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col justify-end">
      {/* Transparent click-blocker covers the terminal area */}
      <div className="flex-1" />
      <div className="bg-gradient-to-t from-[#0f0f23] via-[#0f0f23]/95 to-transparent pt-8 pb-4 px-4">
      <div className="flex items-center justify-center gap-3">
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Bot className="w-4 h-4 text-emerald-400" />
          <span>Agent session available — resume to continue where you left off</span>
        </div>
        <button
          onClick={handleDismiss}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--text-muted)] transition-colors"
        >
          Dismiss
        </button>
        <button
          onClick={handleResume}
          disabled={resuming}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 text-xs font-medium hover:bg-emerald-500/30 transition-colors disabled:opacity-60"
        >
          {resuming ? (
            <><RotateCcw className="w-3.5 h-3.5 animate-spin" /> Resuming...</>
          ) : (
            <><Play className="w-3.5 h-3.5" /> Resume Agent</>
          )}
        </button>
      </div>
      </div>
    </div>
  );
}
