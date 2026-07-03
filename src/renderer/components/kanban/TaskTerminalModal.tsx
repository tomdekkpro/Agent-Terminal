import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Copy,
  Check,
  Loader2,
  Hash,
  FolderOpen,
  Pencil,
  Save,
  Link as LinkIcon,
  Maximize2,
  Minimize2,
  Bot,
  ChevronDown,
  Eraser,
  GitCommitVertical,
  Search,
  Rocket,
} from 'lucide-react';
import type { KanbanTask, AgentProviderMeta, AgentProviderId, TaskManagerTask, TerminalTask } from '../../../shared/types';
import { useTerminalStore, type Terminal } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useProjectStore } from '../../stores/project-store';
import { useKanbanStore, type AutoCodeLogEntry } from '../../stores/kanban-store';
import { TerminalPanel, ActionsDropdown } from '../terminal/TerminalPanel';
import { ChangesSplitLayout, TaskPickerModal } from '../terminal/TerminalView';
import { cn } from '../../../shared/utils';
import { resolveSessionCwd, buildSessionCandidates } from '../../lib/resolve-session-cwd';
import { useCompleteTaskFlow } from '../../hooks/useCompleteTaskFlow';

interface TaskTerminalModalProps {
  task: KanbanTask | null;
  onClose: () => void;
}

/** Convert KanbanTask snapshot → TerminalTask for use with the existing terminal infrastructure */
function toTerminalTask(t: KanbanTask): TerminalTask {
  return {
    id: t.clickupTaskId,
    customId: t.clickupCustomId,
    name: t.clickupName,
    status: t.clickupStatus,
    statusColor: t.clickupStatusColor || '#888',
    url: t.clickupUrl,
    // Local KanbanTasks have no task-manager link; surface that as 'none'
    // so downstream UI (PR title prefix, task-manager actions) skips them.
    provider: t.provider === 'local' ? 'none' : 'clickup',
  };
}

/** Status pill + dropdown — change the task's status straight from the task
 *  detail header. Writes through the kanban store's moveTask so the board
 *  stays 1-1 with ClickUp (optimistic move + revert-on-reject), and mirrors
 *  the result onto any terminal linked to the same task so its toolbar chip
 *  updates immediately instead of waiting for the next poll. */
function TaskStatusDropdown({ task }: { task: KanbanTask }) {
  const statuses = useKanbanStore((s) => s.statuses);
  const moveTask = useKanbanStore((s) => s.moveTask);
  const pendingStatus = useKanbanStore((s) => s.pendingMoves[task.id]);
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Statuses may not be loaded yet if the modal opens before the board did.
  useEffect(() => {
    if (statuses.length === 0) void useKanbanStore.getState().loadStatuses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    const onScroll = () => setMenu(null);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [menu]);

  const statusColorFor = (name: string) =>
    statuses.find((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase())?.color;

  // While a move is in flight, show the destination status (optimistic — the
  // store reverts pendingMoves if ClickUp rejects the change).
  const currentName = (pendingStatus || task.clickupStatus || '').trim();
  const color = statusColorFor(currentName) || task.clickupStatusColor || '#94a3b8';

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setMenu({ top: r.bottom + 4, left: r.left });
  };

  const pickStatus = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    setMenu(null);
    if (name.trim().toLowerCase() === (task.clickupStatus || '').trim().toLowerCase()) return;
    await moveTask(task.id, name);
    // Mirror the confirmed change onto any linked terminal's task chip.
    const after = useKanbanStore.getState().tasks.find((t) => t.id === task.id);
    if (!after || (after.clickupStatus || '').trim().toLowerCase() !== name.trim().toLowerCase()) return;
    const newColor = statusColorFor(name) || after.clickupStatusColor || '#94a3b8';
    const termStore = useTerminalStore.getState();
    for (const term of termStore.terminals) {
      if (term.task?.id === task.clickupTaskId) {
        termStore.updateTerminal(term.id, {
          task: { ...term.task, status: name, statusColor: newColor },
        });
      }
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={openMenu}
        disabled={!!pendingStatus || statuses.length === 0}
        className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide hover:opacity-80 transition-opacity disabled:opacity-60"
        style={{
          backgroundColor: `${color}20`,
          color,
        }}
        title="Change task status"
      >
        {pendingStatus && <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />}
        {currentName}
        <ChevronDown className="w-2.5 h-2.5 shrink-0 opacity-60" />
      </button>

      {/* Portal so the header's overflow doesn't clip the menu */}
      {menu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-[180px] max-h-72 overflow-y-auto glass-card border border-[var(--border)] rounded-lg shadow-xl py-1"
          style={{ top: menu.top, left: menu.left }}
        >
          <div className="px-3 py-1 text-[9px] font-display uppercase tracking-wider text-[var(--text-muted)]">
            Set status
          </div>
          {statuses.map((s) => {
            const active = s.name.trim().toLowerCase() === currentName.toLowerCase();
            return (
              <button
                key={s.name}
                onClick={(e) => void pickStatus(e, s.name)}
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
    </>
  );
}

/** Short-form copy helper */
function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={label ? `Copy ${label}` : 'Copy'}
      className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
    >
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

/** Inline editor for manually setting (or replacing) a task's agent session id.
 *  Used when auto-capture lost the id and the user wants to resume an existing
 *  Claude conversation. */
function SessionIdEditor({
  task,
  agentProviders,
}: {
  task: KanbanTask;
  agentProviders: AgentProviderMeta[];
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.agentSessionId || '');
  const [provider, setProvider] = useState<AgentProviderId>(task.agentProvider || 'claude');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setValue(task.agentSessionId || '');
    setProvider(task.agentProvider || 'claude');
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Session ID is required');
      return;
    }
    // Claude session ids are UUIDs — accept anything that looks roughly like one
    // (8-4-4-4-12 hex). Other providers may use different formats, so only
    // hard-fail when the format is clearly wrong for Claude.
    if (provider === 'claude' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
      setError('Claude session IDs are UUIDs (e.g. 1a2b3c4d-…)');
      return;
    }
    if (trimmed === task.agentSessionId && provider === task.agentProvider) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Clear agentCwd so the resume flow re-probes candidates for this new id.
      await useKanbanStore.getState().updateTask(task.id, {
        agentSessionId: trimmed,
        agentProvider: provider,
        agentCwd: undefined,
      });
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <Hash className="w-3 h-3 text-[var(--text-muted)]" />
        <input
          type="text"
          autoFocus
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') cancel();
          }}
          placeholder="Paste session ID (UUID)"
          disabled={saving}
          className="font-mono text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 w-[280px] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] placeholder:text-[var(--text-muted)] disabled:opacity-50"
        />
        {agentProviders.length > 0 ? (
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as AgentProviderId)}
            disabled={saving}
            className="text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] disabled:opacity-50"
          >
            {agentProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName || p.id}</option>
            ))}
          </select>
        ) : null}
        <button
          onClick={save}
          disabled={saving || !value.trim()}
          title="Save session ID"
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-green-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
        </button>
        <button
          onClick={cancel}
          disabled={saving}
          title="Cancel"
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    );
  }

  if (task.agentSessionId) {
    return (
      <div className="flex items-center gap-1" title="Agent session id — used to resume the agent on reopen">
        <Hash className="w-3 h-3" />
        <span className="font-mono">
          {task.agentSessionId.slice(0, 8)}…{task.agentSessionId.slice(-4)}
        </span>
        <CopyButton text={task.agentSessionId} label="session id" />
        <button
          onClick={open}
          title="Edit session ID — paste an existing one to resume that conversation"
          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
        >
          <Pencil className="w-3 h-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={open}
      title="Manually paste a session ID to resume an existing agent conversation"
      className="flex items-center gap-1 italic opacity-70 hover:opacity-100 hover:text-[var(--text-primary)] transition-all"
    >
      <Pencil className="w-3 h-3" />
      <span>No agent session — set session ID</span>
    </button>
  );
}

/** Inline base-branch picker for the task meta row. Lists the project's local
 *  branches and lets the user change the branch the worktree forks from /
 *  merges into. "" clears the override → falls back to origin/HEAD. */
function BaseBranchEditor({ task }: { task: KanbanTask }) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const projectPath = task.projectPath;

  // Reset the search box each time the dropdown opens
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const filtered = query.trim()
    ? branches.filter((b) => b.toLowerCase().includes(query.trim().toLowerCase()))
    : branches;

  // Load branches when the dropdown is opened
  useEffect(() => {
    if (!open || !projectPath) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.electronAPI.listBranches(projectPath)
      .then((result: any) => {
        if (cancelled) return;
        if (result?.success) {
          setBranches(Array.isArray(result.branches) ? result.branches : []);
          setCurrentBranch(result.current || '');
        } else {
          setError(result?.error || 'Failed to load branches');
        }
      })
      .catch((err: any) => { if (!cancelled) setError(err?.message || 'Failed to load branches'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectPath]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = async (branch: string) => {
    setOpen(false);
    if (branch === (task.baseBranch || '')) return;
    setSaving(true);
    try {
      await useKanbanStore.getState().updateTask(task.id, { baseBranch: branch || undefined });
    } finally {
      setSaving(false);
    }
  };

  if (!projectPath) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        title={
          task.baseBranch
            ? `Base branch — worktree forks from / merges into ${task.baseBranch}. Click to change.`
            : 'Select a base branch (defaults to origin/HEAD)'
        }
      >
        <span>←</span>
        <span className="font-mono">{task.baseBranch || 'Default'}</span>
        {saving
          ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
          : <ChevronDown className={cn('w-2.5 h-2.5 transition-transform', open && 'rotate-180')} />}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[240px] bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="p-1.5 border-b border-[var(--border)]">
            <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border)]">
              <Search className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setOpen(false); }
                  if (e.key === 'Enter' && filtered.length > 0) { void select(filtered[0]); }
                }}
                placeholder="Search branches…"
                className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] focus:outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
          </div>
          <div className="max-h-[240px] overflow-y-auto">
            {!query.trim() && (
              <button
                type="button"
                onClick={() => select('')}
                className={cn(
                  'w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors flex items-center gap-2',
                  !task.baseBranch && 'bg-[var(--accent)]/10 text-[var(--accent)]',
                )}
                title="Use the project's default remote branch (origin/HEAD)"
              >
                <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                <span>Default (origin/HEAD)</span>
              </button>
            )}
            {loading && (
              <div className="px-3 py-3 text-xs text-[var(--text-muted)] flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Loading…
              </div>
            )}
            {error && !loading && <div className="px-3 py-3 text-xs text-red-400">{error}</div>}
            {!loading && !error && branches.length === 0 && (
              <div className="px-3 py-3 text-xs text-[var(--text-muted)]">No local branches found.</div>
            )}
            {!loading && !error && branches.length > 0 && filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-[var(--text-muted)]">No branches match “{query.trim()}”.</div>
            )}
            {!loading && !error && filtered.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => select(b)}
                className={cn(
                  'w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors flex items-center gap-2',
                  b === task.baseBranch && 'bg-[var(--accent)]/10 text-[var(--accent)]',
                )}
              >
                <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
                <span className="truncate flex-1">{b}</span>
                {b === currentBranch && (
                  <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide shrink-0">current</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Stable empty reference so the selector below doesn't return a fresh array
 *  every render (which would defeat zustand's equality check). */
const EMPTY_LOG: AutoCodeLogEntry[] = [];

function formatClock(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

/** Live view of what Auto Code is doing on a task whose headless run is in
 *  flight. The run isn't a viewable terminal, so we stream the orchestrator's
 *  progress breadcrumbs instead — no "Resume" click needed. When the run
 *  finishes, the modal's setup effect takes over and opens the resumed session
 *  so the full transcript becomes visible. */
function AutoCodeProgressPanel({ task }: { task: KanbanTask }) {
  const logs = useKanbanStore((s) => s.autoCodeLogs[task.id] || EMPTY_LOG);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest line in view as progress streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  const levelColor = (level: AutoCodeLogEntry['level']) =>
    level === 'error' ? 'text-red-400' : level === 'warn' ? 'text-amber-400' : 'text-[var(--text-secondary)]';

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 gap-3">
      <div className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
        <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" />
        <span className="font-medium">Auto Code is working on this task…</span>
        {(task.iterationCount || 0) > 0 && (
          <span className="text-[11px] font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">
            attempt {task.iterationCount}
          </span>
        )}
      </div>
      <p className="text-[11px] text-[var(--text-muted)] -mt-1">
        The agent runs in the background (not an interactive terminal). Progress is shown below; when it finishes,
        this view switches to the agent session automatically so you can inspect the full transcript.
      </p>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3 font-mono text-[11px] leading-relaxed"
      >
        {logs.length === 0 ? (
          <div className="text-[var(--text-muted)] italic">Waiting for the first progress update…</div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-[var(--text-muted)] shrink-0">{formatClock(entry.at)}</span>
              <span className={cn('whitespace-pre-wrap break-words', levelColor(entry.level))}>{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function TaskTerminalModal({ task, onClose }: TaskTerminalModalProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const projects = useProjectStore((s) => s.projects);
  const settings = useSettingsStore((s) => s.settings);
  const refreshClickup = useKanbanStore((s) => s.refreshClickupSnapshots);

  // Project that owns this task — needed by useCompleteTaskFlow
  const taskProject = task
    ? (projects.find((p) => p.path === task.projectPath)
       || projects.find((p) => p.id === task.projectId)
       || null)
    : null;

  // Complete-task flow (Merge Locally / Create PR / Branch & PR / Commit only)
  const { openCompleteTask, modal: completeTaskModal, statusBanner: completeTaskBanner } =
    useCompleteTaskFlow(
      taskProject ? { path: taskProject.path } : null,
      settings.taskManagerProvider !== 'none',
    );

  const [isFullscreen, setIsFullscreen] = useState(true);
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);
  const [agentProviders, setAgentProviders] = useState<AgentProviderMeta[]>([]);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const setupRef = useRef<string | null>(null); // dedupe effect across strict-mode double-invoke

  // Link-to-ClickUp flow for local tasks
  const linkLocalToClickup = useKanbanStore((s) => s.linkLocalToClickup);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);

  const handleLinkPicked = useCallback(async (picked: TaskManagerTask) => {
    if (!task) return;
    setShowLinkPicker(false);
    setLinking(true);
    setLinkError(null);
    const updated = await linkLocalToClickup(task.id, picked);
    setLinking(false);
    if (!updated) {
      // linkLocalToClickup writes the error to the global store; surface it locally too.
      setLinkError(useKanbanStore.getState().error || 'Failed to link to ClickUp');
      useKanbanStore.getState().clearError();
      setTimeout(() => setLinkError(null), 6000);
      return;
    }
    // Sync the terminal's task pointer to the new ClickUp id so subsequent
    // "Complete Task" / "Open in ClickUp" actions use the real ClickUp task.
    if (terminalId) {
      updateTerminal(terminalId, { task: toTerminalTask(updated) });
    }
  }, [task, linkLocalToClickup, terminalId, updateTerminal]);

  // Load agent providers once
  useEffect(() => {
    if (agentProviders.length > 0) return;
    window.electronAPI.getAgentProviders?.().then((result: any) => {
      if (result?.success && Array.isArray(result.data)) setAgentProviders(result.data);
    }).catch(() => {});
  }, [agentProviders.length]);

  // Open: find an existing terminal for this ClickUp task, or create one
  useEffect(() => {
    if (!task) {
      setTerminalId(null);
      setupRef.current = null;
      return;
    }
    // While Auto Code is actively running this task headlessly, don't create a
    // terminal or resume the stored session: the run isn't a viewable PTY, and
    // resuming a session the headless agent is still writing would spawn a
    // second, conflicting agent. Show the live progress panel instead. Once the
    // run finishes (autoCodeState changes off 'coding'), this effect re-runs and
    // sets up the terminal — auto-resuming the just-saved session so the result
    // is visible with no manual click.
    if (task.autoCodeState === 'coding') return;
    if (setupRef.current === task.id) return;
    setupRef.current = task.id;

    const existing = useTerminalStore
      .getState()
      .terminals.find((t) => t.task?.id === task.clickupTaskId);

    if (existing) {
      setTerminalId(existing.id);
      useTerminalStore.getState().setActiveTerminal(existing.id);

      // If the terminal has session data the KanbanTask doesn't, sync it back.
      // This heals records where restoreState() brought the session in from
      // disk without going through the live session-id event.
      const patch: Partial<KanbanTask> = {};
      if (existing.agentSessionId && !task.agentSessionId) patch.agentSessionId = existing.agentSessionId;
      if (existing.agentProvider && !task.agentProvider) patch.agentProvider = existing.agentProvider;
      if (existing.worktreePath && !task.worktreePath) patch.worktreePath = existing.worktreePath;
      if (existing.worktreeBranch && !task.worktreeBranch) patch.worktreeBranch = existing.worktreeBranch;
      if (existing.baseBranch && !task.baseBranch) patch.baseBranch = existing.baseBranch;
      if (Object.keys(patch).length > 0) {
        void useKanbanStore.getState().updateTask(task.id, patch);
      }
      return;
    }

    // Need to create a new terminal for this task
    const project = projects.find((p) => p.path === task.projectPath)
      || projects.find((p) => p.id === task.projectId)
      || null;

    if (!project) {
      setSetupError('This task references a project path that no longer exists. Re-import the task or add the project in Settings.');
      return;
    }

    setSettingUp(true);
    setSetupError(null);

    (async () => {
      try {
        // The project is in the store, but its folder may have been deleted or
        // moved. Spawning a PTY in a missing directory throws Windows error 267,
        // so bail out with a clear message before creating anything.
        const projExists = await window.electronAPI.pathExists(project.path);
        if (!(projExists?.success && projExists.data?.isDirectory)) {
          setSetupError('The project folder for this task was not found on disk. Reconnect or move the project, then try again.');
          setSettingUp(false);
          return;
        }

        const terminal = addTerminal(project.path, project.id);
        if (!terminal) {
          setSetupError('Could not create a terminal — maximum reached?');
          setSettingUp(false);
          return;
        }

        const title = `${task.clickupCustomId || task.clickupTaskId} · ${task.clickupName.slice(0, 40)}`;
        const worktreeName = (task.clickupCustomId || task.clickupTaskId).replace(/[^a-zA-Z0-9_-]/g, '-');
        const sep = project.path.includes('\\') ? '\\' : '/';

        // useWorktree=false → run directly on the project's checked-out branch.
        // No worktree creation, no --worktree flag, baseBranch comes from
        // whatever the project is currently on.
        const wantsWorktree = task.useWorktree !== false;

        // Stale-session guard: if a stored agent session lived in a worktree
        // that no longer exists (deleted after merge, manually removed), the
        // resume can't run. Drop the session + worktree pointers so this opens
        // as a fresh "Start" instead of failing to resume into a missing path.
        let sessionId = task.agentSessionId;
        let agentCwd = task.agentCwd;
        let storedWorktreePath = task.worktreePath;
        let storedWorktreeBranch = task.worktreeBranch;
        if (sessionId && wantsWorktree && storedWorktreePath) {
          const wtExists = await window.electronAPI.pathExists(storedWorktreePath);
          if (wtExists?.success && wtExists.data && !wtExists.data.isDirectory) {
            sessionId = undefined;
            agentCwd = undefined;
            storedWorktreePath = undefined;
            storedWorktreeBranch = undefined;
            void useKanbanStore.getState().updateTask(task.id, {
              agentSessionId: undefined,
              agentProvider: undefined,
              agentCwd: undefined,
              worktreePath: undefined,
              worktreeBranch: undefined,
            });
          }
        }

        if (!wantsWorktree) {
          updateTerminal(terminal.id, {
            task: toTerminalTask(task),
            cwd: project.path,
            worktreePath: undefined,
            worktreeBranch: undefined,
            title,
          } as Partial<Terminal>);

          try {
            const br = await window.electronAPI.listBranches(project.path);
            if (br?.success && br.current) {
              updateTerminal(terminal.id, { baseBranch: br.current });
            }
          } catch { /* non-critical */ }

          await window.electronAPI.createTerminal({
            id: terminal.id,
            cwd: project.path,
            cols: 80,
            rows: 24,
          });

          if (sessionId) {
            const agentId: AgentProviderId = task.agentProvider || 'claude';
            updateTerminal(terminal.id, {
              agentSessionId: sessionId,
              agentProvider: agentId,
              isClaudeMode: true,
              status: 'claude-active',
            });
            try {
              await window.electronAPI.resumeAgent(terminal.id, agentId, {
                sessionId,
                cwd: project.path,
              });
            } catch {
              updateTerminal(terminal.id, { isClaudeMode: false, status: 'idle' });
            }
          }

          setTerminalId(terminal.id);
          return;
        }

        const nativeWorktreePath = `${project.path}${sep}.claude${sep}worktrees${sep}${worktreeName}`;
        const nativeBranch = `worktree-${worktreeName}`;
        const legacyWorktreePath = `${project.path}${sep}.task-worktrees${sep}${worktreeName}`;

        // Pre-create the native worktree so git ops (status, push, PR) work
        // before / between Claude runs. createTaskWorktree is idempotent.
        // Pass through the user-selected baseBranch so the worktree forks
        // from the right branch (falls back to origin/HEAD inside the handler).
        let worktreePath = nativeWorktreePath;
        let worktreeBranch = nativeBranch;
        try {
          const wt = await window.electronAPI.createTaskWorktree(project.path, worktreeName, task.baseBranch);
          if (wt?.success && wt.data) {
            worktreePath = wt.data;
            if (wt.branch) worktreeBranch = wt.branch;
          }
        } catch { /* non-critical — claude --worktree will create it */ }

        // Detect legacy `.task-worktrees/<id>` sessions (pre-v1.14.0). Native
        // worktrees living under `.claude/worktrees/<name>` use Claude's own
        // `--resume <id>` cross-worktree resolution (see Common Workflows
        // docs) and don't need cwd probing.
        const isLegacyWorktree = !!storedWorktreePath && storedWorktreePath.includes('.task-worktrees');

        // Legacy path only: probe candidate cwds to find the conversation file.
        const resolved = isLegacyWorktree
          ? await resolveSessionCwd(
              sessionId,
              buildSessionCandidates({
                agentCwd,
                worktreePath: storedWorktreePath,
                nativeWorktreePath,
                computedWorktreePath: legacyWorktreePath,
                projectPath: project.path,
              }),
            )
          : null;

        // PTY cwd: legacy → wherever the session was found.
        // Native → project root; `claude --worktree <name>` cd's into the worktree itself.
        const cwd = isLegacyWorktree ? (resolved?.cwd || project.path) : project.path;

        updateTerminal(terminal.id, {
          task: toTerminalTask(task),
          cwd,
          worktreePath: isLegacyWorktree
            ? (resolved?.isWorktree ? resolved.cwd : worktreePath)
            : worktreePath,
          worktreeBranch: isLegacyWorktree && resolved?.isWorktree && storedWorktreeBranch
            ? storedWorktreeBranch
            : worktreeBranch,
          title,
        } as Partial<Terminal>);

        // Base branch — prefer the one the task was imported with (so the
        // merge/PR target matches what the worktree was actually forked
        // from). Fall back to the project's current branch otherwise.
        if (task.baseBranch) {
          updateTerminal(terminal.id, { baseBranch: task.baseBranch });
        } else {
          try {
            const br = await window.electronAPI.listBranches(project.path);
            if (br?.success && br.current) {
              updateTerminal(terminal.id, { baseBranch: br.current });
            }
          } catch { /* non-critical */ }
        }

        await window.electronAPI.createTerminal({
          id: terminal.id,
          cwd,
          cols: 80,
          rows: 24,
        });

        // Resume the stored agent session.
        // - Native: pass --worktree <name> + --resume <id>; cwd stays at project root.
        // - Legacy: cd to the probed cwd and run --resume <id> (no --worktree flag).
        const shouldResume = sessionId && (!isLegacyWorktree || resolved);
        if (shouldResume) {
          const agentId: AgentProviderId = task.agentProvider || 'claude';
          updateTerminal(terminal.id, {
            agentSessionId: sessionId,
            agentProvider: agentId,
            isClaudeMode: true,
            status: 'claude-active',
          });
          try {
            await window.electronAPI.resumeAgent(terminal.id, agentId, {
              sessionId,
              cwd,
              worktreeName: isLegacyWorktree ? undefined : worktreeName,
            });
          } catch {
            updateTerminal(terminal.id, { isClaudeMode: false, status: 'idle' });
          }
        }

        setTerminalId(terminal.id);
      } catch (err) {
        setSetupError(err instanceof Error ? err.message : 'Failed to set up terminal');
      } finally {
        setSettingUp(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.autoCodeState]);

  // Close on Escape
  useEffect(() => {
    if (!task) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [task, onClose]);

  // Close the provider dropdown on outside click
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

  const terminal: Terminal | undefined = terminalId ? terminals.find((t) => t.id === terminalId) : undefined;
  const currentProvider = terminal ? agentProviders.find((p) => p.id === terminal.agentProvider) : undefined;

  const handleInvokeAgent = useCallback(async (skipPermissions?: boolean) => {
    if (!terminal) return;
    const agentId = terminal.agentProvider;
    const project = projects.find((p) => p.id === terminal.projectId);
    const model = project?.agentModel || settings.agentModels?.[agentId] || undefined;
    // Pass --worktree <id> when this terminal is bound to a task so Claude
    // creates / reuses <repo>/.claude/worktrees/<id>. Skip for non-Claude
    // providers (flag is Claude-specific) and for tasks the user opted out of
    // worktree mode (`useWorktree === false`) — those run on the project's
    // checked-out branch.
    const worktreeName = terminal.task && agentId === 'claude' && task?.useWorktree !== false
      ? (terminal.task.customId || terminal.task.id).replace(/[^a-zA-Z0-9_-]/g, '-')
      : undefined;
    const result = await window.electronAPI.invokeAgent(terminal.id, agentId, {
      cwd: project?.path || terminal.cwd,
      skipPermissions,
      model,
      worktreeName,
    });
    if (result.success) {
      useTerminalStore.getState().setClaudeMode(terminal.id, true);
      if (skipPermissions) {
        useTerminalStore.getState().updateTerminal(terminal.id, { skipPermissions: true });
      }
      // Send the task context as the first prompt. Local tasks have no
      // ClickUp source — use the description stored on the KanbanTask.
      const kanbanTask = task; // narrow for closure
      if (terminal.task && kanbanTask) {
        if (kanbanTask.provider === 'local') {
          const parts: string[] = [
            `I'm working on task: ${kanbanTask.clickupName}`,
          ];
          if (kanbanTask.description) {
            const desc = kanbanTask.description.length > 4000
              ? kanbanTask.description.slice(0, 4000) + '\n…(truncated)'
              : kanbanTask.description;
            parts.push(`Description:\n${desc}`);
          }
          const prompt = parts.join('\n');
          setTimeout(() => {
            window.electronAPI.sendTerminalInput(terminal.id, prompt + '\n');
          }, 3000);
        } else {
          const taskId = terminal.task.id;
          window.electronAPI.getTaskManagerTask(taskId).then((res: any) => {
            if (!res?.success || !res.data) return;
            const t = res.data as TaskManagerTask;
            const parts: string[] = [
              `I'm working on task ${t.customId || t.id}: ${t.name}`,
              `Status: ${t.status.name}`,
            ];
            if (t.priority) parts.push(`Priority: ${t.priority.name}`);
            if (t.description) {
              const desc = t.description.length > 1000 ? t.description.slice(0, 1000) + '...' : t.description;
              parts.push(`Description:\n${desc}`);
            }
            if (t.url) parts.push(`URL: ${t.url}`);
            const prompt = parts.join('\n');
            setTimeout(() => {
              window.electronAPI.sendTerminalInput(terminal.id, prompt + '\n');
            }, 3000);
          }).catch(() => { /* non-critical */ });
        }
      }
    }
  }, [terminal, projects, settings.agentModels, task]);

  const handleProviderChange = useCallback((provider: AgentProviderId) => {
    if (!terminal) return;
    useTerminalStore.getState().setAgentProvider(terminal.id, provider);
    // Unified agent: persist the choice on the KanbanTask so the auto-code loop
    // uses the same agent the user picked here for interactive runs.
    if (task) void useKanbanStore.getState().updateTask(task.id, { agentProvider: provider });
  }, [terminal, task]);

  const handleCloseTerminal = useCallback(async () => {
    if (!terminal) return;
    await window.electronAPI.destroyTerminal(terminal.id);
    removeTerminal(terminal.id);
    setTerminalId(null);
    onClose();
  }, [terminal, removeTerminal, onClose]);

  if (!task) return null;

  // Headless Auto Code run in flight → show live progress instead of trying to
  // attach a terminal / resume a session.
  const isAutoCoding = task.autoCodeState === 'coding';

  return (
    <div
      onClick={onClose}
      className={cn(
        'z-50 bg-black/50 flex items-stretch justify-center',
        // Fullscreen fills the board region (its relative parent in KanbanView)
        // so the sidebar + Kanban header stay visible. Windowed centers a card
        // over the whole window.
        isFullscreen ? 'absolute inset-0 p-0' : 'fixed inset-0 p-4',
      )}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-full flex flex-col bg-[var(--bg-secondary)] border border-[var(--border)] shadow-2xl overflow-hidden',
          isFullscreen ? 'max-w-none rounded-none' : 'max-w-[1400px] rounded-xl',
        )}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[var(--border)] flex items-start gap-3">
          <div className="flex-1 min-w-0">
            {/* Title row */}
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {task.clickupCustomId && (
                <code className="text-xs font-mono text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded shrink-0">
                  {task.clickupCustomId}
                </code>
              )}
              <TaskStatusDropdown task={task} />
              {task.clickupPriority && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{ backgroundColor: `${task.clickupPriority.color}20`, color: task.clickupPriority.color }}
                >
                  {task.clickupPriority.name}
                </span>
              )}
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
              {task.provider === 'local' ? (
                settings.taskManagerProvider === 'clickup' && (
                  <button
                    onClick={() => setShowLinkPicker(true)}
                    disabled={linking}
                    className="flex items-center gap-1 text-xs text-[var(--accent)] hover:opacity-80 transition-opacity disabled:opacity-50"
                    title="Attach this local task to an existing ClickUp task"
                  >
                    {linking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LinkIcon className="w-3.5 h-3.5" />}
                    Link to ClickUp
                  </button>
                )
              ) : (
                task.clickupUrl && (
                  <button
                    onClick={() => window.electronAPI.openExternal(task.clickupUrl)}
                    className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    title="Open in ClickUp"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    ClickUp
                  </button>
                )
              )}
            </div>
            <h2 className="text-base font-semibold text-[var(--text-primary)] truncate">
              {task.clickupName}
            </h2>

            {/* Meta row: session id, PR, branch, project */}
            <div className="flex items-center gap-4 flex-wrap mt-1.5 text-[11px] text-[var(--text-muted)]">
              <SessionIdEditor task={task} agentProviders={agentProviders} />
              {task.prUrl && (
                <button
                  onClick={() => window.electronAPI.openExternal(task.prUrl!)}
                  className="flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors"
                  title="Open pull request"
                >
                  <GitPullRequest className="w-3 h-3 text-purple-400" />
                  <span className="text-purple-400">PR</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </button>
              )}
              {task.useWorktree === false ? (
                <div
                  className="flex items-center gap-1 text-amber-400"
                  title="No worktree — agent runs on the project's checked-out branch"
                >
                  <GitBranch className="w-3 h-3" />
                  <span>Current branch</span>
                </div>
              ) : task.worktreeBranch && (
                <div className="flex items-center gap-1" title="Git branch for this task's worktree">
                  <GitBranch className="w-3 h-3" />
                  <span className="font-mono">{task.worktreeBranch}</span>
                  <CopyButton text={task.worktreeBranch} label="branch name" />
                </div>
              )}
              <BaseBranchEditor task={task} />
              {task.projectPath && (
                <div className="flex items-center gap-1 truncate max-w-[260px]" title={task.projectPath}>
                  <FolderOpen className="w-3 h-3" />
                  <span className="truncate">{task.projectPath}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Unified task controls (Actions, provider, Start/Clear, Changes).
                The embedded terminal's own toolbar is hidden via hideToolbar. */}
            {terminal && (
              <>
                {terminal.task && (
                  <ActionsDropdown
                    terminal={terminal}
                    onMergeComplete={() => openCompleteTask(terminal)}
                  />
                )}
                {!terminal.isClaudeMode ? (
                  <>
                    {/* Provider dropdown */}
                    <div className="relative" ref={providerMenuRef}>
                      <button
                        onClick={() => setShowProviderMenu((v) => !v)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors"
                        title="Select AI provider"
                      >
                        <Bot className="w-3 h-3" />
                        {currentProvider?.displayName || terminal.agentProvider}
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {showProviderMenu && (
                        <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl overflow-hidden max-h-60 overflow-y-auto">
                          {agentProviders.map((p) => (
                            <button
                              key={p.id}
                              onClick={() => { handleProviderChange(p.id); setShowProviderMenu(false); }}
                              className={cn(
                                'w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] transition-colors',
                                terminal.agentProvider === p.id ? 'font-medium' : 'text-[var(--text-secondary)]',
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
                    {/* Start */}
                    <button
                      onClick={() => handleInvokeAgent()}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors"
                      style={{
                        backgroundColor: `${currentProvider?.color || '#6366f1'}20`,
                        color: currentProvider?.color || '#6366f1',
                      }}
                      title={`Start ${currentProvider?.displayName || terminal.agentProvider}`}
                    >
                      <Bot className="w-3.5 h-3.5" />
                      Start
                    </button>
                    {/* YOLO — only for agents that support skip-permissions */}
                    {currentProvider?.capabilities.yolo && (
                      <button
                        onClick={() => handleInvokeAgent(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors"
                        title={`Start ${currentProvider.displayName} (skip permissions)`}
                      >
                        <Bot className="w-3.5 h-3.5" />
                        YOLO
                      </button>
                    )}
                  </>
                ) : (
                  /* Clear input — shown while the agent is active */
                  <button
                    onClick={() => window.electronAPI.sendTerminalInput(terminal.id, '\x15')}
                    disabled={terminal.isClaudeBusy}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors',
                      terminal.isClaudeBusy
                        ? 'bg-[var(--text-muted)]/10 text-[var(--text-muted)] cursor-not-allowed opacity-50'
                        : 'bg-orange-500/20 text-orange-400 hover:bg-orange-500/30',
                    )}
                    title={terminal.isClaudeBusy ? `Wait for ${currentProvider?.displayName || 'agent'} to finish` : 'Clear input text'}
                  >
                    <Eraser className="w-3.5 h-3.5" />
                    Clear
                  </button>
                )}
                {/* Changes toggle */}
                <button
                  onClick={() => useTerminalStore.getState().togglePreview(terminal.id)}
                  className={cn(
                    'flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors',
                    terminal.previewOpen
                      ? 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]/80',
                  )}
                  title={terminal.previewOpen ? 'Close changes panel' : 'Show code changes'}
                >
                  <GitCommitVertical className="w-3.5 h-3.5" />
                  Changes
                </button>
                <div className="h-5 w-px bg-[var(--border)] mx-1" />
              </>
            )}
            <button
              onClick={() => refreshClickup()}
              title="Refresh ClickUp snapshot"
              className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <Hash className="w-4 h-4" />
            </button>
            <button
              onClick={() => setIsFullscreen((v) => !v)}
              title={isFullscreen ? 'Exit full screen' : 'Full screen'}
              className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {setupError && (
            <div className="m-4 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {setupError}
            </div>
          )}

          {isAutoCoding ? (
            <AutoCodeProgressPanel task={task} />
          ) : (
          <>
          {settingUp && !terminal && (
            <div className="flex-1 flex items-center justify-center gap-2 text-[var(--text-muted)]">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">
                {task.agentSessionId ? 'Resuming agent session…' : 'Setting up terminal…'}
              </span>
            </div>
          )}

          {completeTaskBanner}

          {linkError && (
            <div className="m-4 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 flex items-start justify-between gap-2">
              <span>{linkError}</span>
              <button
                onClick={() => setLinkError(null)}
                className="text-red-400 hover:opacity-70"
                title="Dismiss"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {terminal && (
            <div className={cn('flex-1 min-h-0 flex flex-col')}>
              {terminal.previewOpen ? (
                <ChangesSplitLayout terminal={terminal}>
                  <TerminalPanel
                    key={terminal.id}
                    terminal={terminal}
                    isActive={true}
                    hideToolbar
                    agentProviders={agentProviders}
                    skills={projects.find((p) => p.id === terminal.projectId)?.skills}
                    onInvokeAgent={handleInvokeAgent}
                    onProviderChange={handleProviderChange}
                    onMergeComplete={() => openCompleteTask(terminal)}
                    onClose={handleCloseTerminal}
                    onFocus={() => useTerminalStore.getState().setActiveTerminal(terminal.id)}
                  />
                </ChangesSplitLayout>
              ) : (
                <TerminalPanel
                  key={terminal.id}
                  terminal={terminal}
                  isActive={true}
                  hideToolbar
                  agentProviders={agentProviders}
                  skills={projects.find((p) => p.id === terminal.projectId)?.skills}
                  onInvokeAgent={handleInvokeAgent}
                  onProviderChange={handleProviderChange}
                  onMergeComplete={() => openCompleteTask(terminal)}
                  onClose={handleCloseTerminal}
                  onFocus={() => useTerminalStore.getState().setActiveTerminal(terminal.id)}
                />
              )}
            </div>
          )}
          </>
          )}
        </div>
        {/* CompleteTask modal — must live inside the stopPropagation wrapper so
            clicks (e.g. opening the PR split-button dropdown) don't bubble up
            to the backdrop and dismiss the Kanban modal. */}
        {completeTaskModal}
        {showLinkPicker && (
          <TaskPickerModal
            mode="link"
            onSelect={handleLinkPicked}
            onCancel={() => setShowLinkPicker(false)}
          />
        )}
      </div>
    </div>
  );
}
