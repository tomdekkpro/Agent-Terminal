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
  Pencil,
  Save,
} from 'lucide-react';
import type { KanbanTask, AgentProviderMeta, AgentProviderId, TaskManagerTask, TerminalTask } from '../../../shared/types';
import { useTerminalStore, type Terminal } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useProjectStore } from '../../stores/project-store';
import { useKanbanStore } from '../../stores/kanban-store';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { ChangesSplitLayout } from '../terminal/TerminalView';
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

        const title = `${task.clickupCustomId || task.clickupTaskId} · ${task.clickupName.slice(0, 40)}`;
        const worktreeName = (task.clickupCustomId || task.clickupTaskId).replace(/[^a-zA-Z0-9_-]/g, '-');
        const sep = project.path.includes('\\') ? '\\' : '/';

        // useWorktree=false → run directly on the project's checked-out branch.
        // No worktree creation, no --worktree flag, baseBranch comes from
        // whatever the project is currently on.
        const wantsWorktree = task.useWorktree !== false;

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

          if (task.agentSessionId) {
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
        const isLegacyWorktree = !!task.worktreePath && task.worktreePath.includes('.task-worktrees');

        // Legacy path only: probe candidate cwds to find the conversation file.
        const resolved = isLegacyWorktree
          ? await resolveSessionCwd(
              task.agentSessionId,
              buildSessionCandidates({
                agentCwd: task.agentCwd,
                worktreePath: task.worktreePath,
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
          worktreeBranch: isLegacyWorktree && resolved?.isWorktree && task.worktreeBranch
            ? task.worktreeBranch
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
        const shouldResume = task.agentSessionId && (!isLegacyWorktree || resolved);
        if (shouldResume) {
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
              {task.baseBranch && (
                <div
                  className="flex items-center gap-1 text-[var(--text-muted)]"
                  title={`Worktree was forked from ${task.baseBranch} — merge/PR target`}
                >
                  <span>←</span>
                  <span className="font-mono">{task.baseBranch}</span>
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

          {completeTaskBanner}

          {terminal && (
            <div className={cn('flex-1 min-h-0 flex flex-col')}>
              {terminal.previewOpen ? (
                <ChangesSplitLayout terminal={terminal}>
                  <TerminalPanel
                    key={terminal.id}
                    terminal={terminal}
                    isActive={true}
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
        </div>
        {/* CompleteTask modal — must live inside the stopPropagation wrapper so
            clicks (e.g. opening the PR split-button dropdown) don't bubble up
            to the backdrop and dismiss the Kanban modal. */}
        {completeTaskModal}
      </div>
    </div>
  );
}
