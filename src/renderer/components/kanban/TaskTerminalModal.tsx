import { useState, useEffect, useCallback, useRef } from 'react';
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
} from 'lucide-react';
import type { KanbanTask, AgentProviderMeta, AgentProviderId, TaskManagerTask, TerminalTask } from '../../../shared/types';
import { useTerminalStore, type Terminal } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useProjectStore } from '../../stores/project-store';
import { useKanbanStore } from '../../stores/kanban-store';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { cn } from '../../../shared/utils';

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
    provider: 'clickup',
  };
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

export function TaskTerminalModal({ task, onClose }: TaskTerminalModalProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const projects = useProjectStore((s) => s.projects);
  const settings = useSettingsStore((s) => s.settings);
  const refreshClickup = useKanbanStore((s) => s.refreshClickupSnapshots);

  const [agentProviders, setAgentProviders] = useState<AgentProviderMeta[]>([]);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const setupRef = useRef<string | null>(null); // dedupe effect across strict-mode double-invoke

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
        const terminal = addTerminal(project.path, project.id);
        if (!terminal) {
          setSetupError('Could not create a terminal — maximum reached?');
          setSettingUp(false);
          return;
        }

        let cwd = project.path;
        const title = `${task.clickupCustomId || task.clickupTaskId} · ${task.clickupName.slice(0, 40)}`;
        const sanitized = (task.clickupCustomId || task.clickupTaskId).replace(/[^a-zA-Z0-9_-]/g, '-');
        const sep = project.path.includes('\\') ? '\\' : '/';
        const computedWorktreePath = `${project.path}${sep}.task-worktrees${sep}${sanitized}`;
        const normalize = (p: string) => p.replace(/[/\\]+/g, '/').replace(/\/$/, '').toLowerCase();

        // Probe candidate cwds in priority order to find where Claude actually
        // stored this session. agentCwd (set in v1.13.1+) is most accurate;
        // worktreePath / projectPath cover legacy tasks. Whichever location
        // holds the conversation file wins — that's where we resume from.
        let sessionCwd: string | null = null;
        let sessionMatchedWorktree = false;
        if (task.agentSessionId) {
          const seen = new Set<string>();
          type Candidate = { cwd: string; isWorktree: boolean };
          const raw: Candidate[] = [
            task.agentCwd ? { cwd: task.agentCwd, isWorktree: !!task.worktreePath && normalize(task.agentCwd) === normalize(task.worktreePath) } : null,
            task.worktreePath ? { cwd: task.worktreePath, isWorktree: true } : null,
            { cwd: computedWorktreePath, isWorktree: true },
            { cwd: project.path, isWorktree: false },
          ].filter((c): c is Candidate => !!c);
          const candidates = raw.filter((c) => {
            const key = normalize(c.cwd);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });

          for (const candidate of candidates) {
            try {
              const exists = await window.electronAPI.claudeSessionExists(candidate.cwd, task.agentSessionId);
              if (exists?.data) {
                sessionCwd = candidate.cwd;
                sessionMatchedWorktree = candidate.isWorktree;
                break;
              }
            } catch { /* try next */ }
          }
        }

        if (sessionCwd) {
          cwd = sessionCwd;
          const patch: Partial<Terminal> = {
            task: toTerminalTask(task),
            cwd,
            title,
          };
          if (sessionMatchedWorktree) {
            patch.worktreePath = sessionCwd;
            if (task.worktreeBranch) patch.worktreeBranch = task.worktreeBranch;
          }
          updateTerminal(terminal.id, patch);
        } else {
          // No findable session — fall back to creating/reusing a worktree
          try {
            const wt = await window.electronAPI.createTaskWorktree(project.path, sanitized);
            if (wt?.success && wt.data) {
              cwd = wt.data;
              updateTerminal(terminal.id, {
                task: toTerminalTask(task),
                cwd,
                worktreePath: wt.data,
                worktreeBranch: wt.branch,
                title,
              });
            } else {
              updateTerminal(terminal.id, {
                task: toTerminalTask(task),
                title,
              });
            }
          } catch {
            updateTerminal(terminal.id, { task: toTerminalTask(task) });
          }
        }

        // Base branch
        try {
          const br = await window.electronAPI.listBranches(project.path);
          if (br?.success && br.current) {
            updateTerminal(terminal.id, { baseBranch: br.current });
          }
        } catch { /* non-critical */ }

        // Create PTY
        await window.electronAPI.createTerminal({
          id: terminal.id,
          cwd,
          cols: 80,
          rows: 24,
        });

        // Resume the stored agent session — only if the conversation file is
        // actually findable from the cwd we're about to run from. Otherwise
        // leave the terminal idle so the user can start a fresh session
        // instead of seeing "No conversation found with session id".
        if (task.agentSessionId && sessionCwd) {
          const agentId: AgentProviderId = task.agentProvider || 'claude';
          updateTerminal(terminal.id, {
            agentSessionId: task.agentSessionId,
            agentProvider: agentId,
            isClaudeMode: true,
            status: 'claude-active',
          });
          try {
            await window.electronAPI.resumeAgent(terminal.id, agentId, {
              sessionId: task.agentSessionId,
              cwd,
            });
          } catch {
            // Resume failed — drop back to idle shell so user can try starting manually
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
  }, [task?.id]);

  // Close on Escape
  useEffect(() => {
    if (!task) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [task, onClose]);

  const terminal: Terminal | undefined = terminalId ? terminals.find((t) => t.id === terminalId) : undefined;

  const handleInvokeAgent = useCallback(async (skipPermissions?: boolean) => {
    if (!terminal) return;
    const agentId = terminal.agentProvider;
    const project = projects.find((p) => p.id === terminal.projectId);
    const model = project?.agentModel || settings.agentModels?.[agentId] || undefined;
    const result = await window.electronAPI.invokeAgent(terminal.id, agentId, {
      cwd: project?.path || terminal.cwd,
      skipPermissions,
      model,
    });
    if (result.success) {
      useTerminalStore.getState().setClaudeMode(terminal.id, true);
      if (skipPermissions) {
        useTerminalStore.getState().updateTerminal(terminal.id, { skipPermissions: true });
      }
      // Send the task context as the first prompt
      if (terminal.task) {
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
  }, [terminal, projects, settings.agentModels]);

  const handleProviderChange = useCallback((provider: AgentProviderId) => {
    if (!terminal) return;
    useTerminalStore.getState().setAgentProvider(terminal.id, provider);
  }, [terminal]);

  const handleCloseTerminal = useCallback(async () => {
    if (!terminal) return;
    await window.electronAPI.destroyTerminal(terminal.id);
    removeTerminal(terminal.id);
    setTerminalId(null);
    onClose();
  }, [terminal, removeTerminal, onClose]);

  if (!task) return null;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/50 flex items-stretch justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[1400px] flex flex-col bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
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
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide"
                style={{
                  backgroundColor: `${task.clickupStatusColor || '#94a3b8'}20`,
                  color: task.clickupStatusColor || '#94a3b8',
                }}
              >
                {task.clickupStatus}
              </span>
              {task.clickupPriority && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                  style={{ backgroundColor: `${task.clickupPriority.color}20`, color: task.clickupPriority.color }}
                >
                  {task.clickupPriority.name}
                </span>
              )}
              <button
                onClick={() => window.electronAPI.openExternal(task.clickupUrl)}
                className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                title="Open in ClickUp"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                ClickUp
              </button>
            </div>
            <h2 className="text-base font-semibold text-[var(--text-primary)] truncate">
              {task.clickupName}
            </h2>

            {/* Meta row: session id, PR, branch, project */}
            <div className="flex items-center gap-4 flex-wrap mt-1.5 text-[11px] text-[var(--text-muted)]">
              {task.agentSessionId ? (
                <div className="flex items-center gap-1" title="Agent session id — used to resume the agent on reopen">
                  <Hash className="w-3 h-3" />
                  <span className="font-mono">
                    {task.agentSessionId.slice(0, 8)}…{task.agentSessionId.slice(-4)}
                  </span>
                  <CopyButton text={task.agentSessionId} label="session id" />
                </div>
              ) : (
                <span className="italic opacity-70">No agent session yet — start the agent to create one</span>
              )}
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
              {task.worktreeBranch && (
                <div className="flex items-center gap-1" title="Git branch for this task's worktree">
                  <GitBranch className="w-3 h-3" />
                  <span className="font-mono">{task.worktreeBranch}</span>
                  <CopyButton text={task.worktreeBranch} label="branch name" />
                </div>
              )}
              {task.projectPath && (
                <div className="flex items-center gap-1 truncate max-w-[260px]" title={task.projectPath}>
                  <FolderOpen className="w-3 h-3" />
                  <span className="truncate">{task.projectPath}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => refreshClickup()}
              title="Refresh ClickUp snapshot"
              className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <Hash className="w-4 h-4" />
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

          {settingUp && !terminal && (
            <div className="flex-1 flex items-center justify-center gap-2 text-[var(--text-muted)]">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">
                {task.agentSessionId ? 'Resuming agent session…' : 'Setting up terminal…'}
              </span>
            </div>
          )}

          {terminal && (
            <div className={cn('flex-1 min-h-0 flex flex-col')}>
              <TerminalPanel
                key={terminal.id}
                terminal={terminal}
                isActive={true}
                agentProviders={agentProviders}
                skills={projects.find((p) => p.id === terminal.projectId)?.skills}
                onInvokeAgent={handleInvokeAgent}
                onProviderChange={handleProviderChange}
                onClose={handleCloseTerminal}
                onFocus={() => useTerminalStore.getState().setActiveTerminal(terminal.id)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
