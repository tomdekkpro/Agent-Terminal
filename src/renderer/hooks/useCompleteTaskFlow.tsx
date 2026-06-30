import { useCallback, useState } from 'react';
import { X } from 'lucide-react';
import type { TerminalTask } from '../../shared/types';
import { cn } from '../../shared/utils';
import { useTerminalStore } from '../stores/terminal-store';
import { useKanbanStore } from '../stores/kanban-store';
import { CompleteTaskModal, type TaskCompleteOptions } from '../components/terminal/CompleteTaskModal';

interface MergeTarget {
  id: string;
  worktreePath?: string;
  worktreeBranch?: string;
  currentBranch?: string;
  cwd?: string;
  isWorktree: boolean;
  task?: TerminalTask;
  baseBranch?: string;
}

interface OpenCompleteTaskInput {
  id: string;
  cwd?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  task?: TerminalTask;
  baseBranch?: string;
}

interface UseCompleteTaskFlowResult {
  /** Open the Complete Task modal for a given terminal. */
  openCompleteTask: (terminal: OpenCompleteTaskInput) => Promise<void>;
  /** The modal overlay (fixed position). Render in any consumer. */
  modal: React.ReactNode;
  /** The success/error toast. Inline element — render where it should appear. */
  statusBanner: React.ReactNode;
}

/**
 * Owns the Complete Task modal flow: state, executors (merge / create PR /
 * branch & PR / commit-only), worktree cleanup, and the success/error banner.
 * Used by both TerminalView (main page) and TaskTerminalModal (Kanban detail).
 */
export function useCompleteTaskFlow(
  project: { path: string } | null,
  hasTaskManager: boolean,
): UseCompleteTaskFlowResult {
  const [mergeStatus, setMergeStatus] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [mergeTarget, setMergeTarget] = useState<MergeTarget | null>(null);

  const openCompleteTask = useCallback(async (terminal: OpenCompleteTaskInput) => {
    if (!project?.path) return;

    if (terminal.worktreePath && terminal.worktreeBranch) {
      setMergeTarget({
        id: terminal.id,
        worktreePath: terminal.worktreePath,
        worktreeBranch: terminal.worktreeBranch,
        isWorktree: true,
        task: terminal.task,
        baseBranch: terminal.baseBranch,
      });
    } else if (terminal.task) {
      const cwd = terminal.cwd || project.path;
      try {
        const result = await window.electronAPI.listBranches(cwd);
        if (result.success && result.current) {
          setMergeTarget({
            id: terminal.id,
            currentBranch: result.current,
            cwd,
            isWorktree: false,
            task: terminal.task,
            baseBranch: terminal.baseBranch,
          });
        }
      } catch { /* ignore */ }
    }
  }, [project]);

  const stopAndSyncTimer = useCallback(async (terminalId: string, taskId?: string) => {
    const result = useTerminalStore.getState().stopTimer(terminalId);
    if (result && result.startedAt && taskId && result.elapsed > 0) {
      try {
        await window.electronAPI.postTaskTimeEntry(taskId, result.startedAt, result.elapsed);
      } catch { /* non-critical */ }
    }
  }, []);

  const cleanupWorktree = useCallback(async (saved: MergeTarget) => {
    if (!saved.isWorktree || !saved.worktreePath || !project?.path) return;
    try {
      await window.electronAPI.removeTaskWorktree(project.path, saved.worktreePath);
    } catch { /* non-critical */ }
    useTerminalStore.getState().updateTerminal(saved.id, {
      worktreePath: undefined,
      worktreeBranch: undefined,
      cwd: project.path,
    });
    if (saved.task?.id) {
      void useKanbanStore.getState().clearWorktreeForClickupId(saved.task.id);
    }
  }, [project]);

  const executeMerge = useCallback(async (targetBranch: string) => {
    if (!mergeTarget || !mergeTarget.isWorktree || !project?.path) return;
    setMergeTarget(null);

    const result = await window.electronAPI.mergeTaskBranch(
      project.path,
      mergeTarget.worktreePath!,
      mergeTarget.worktreeBranch!,
      targetBranch,
    );

    if (result.success) {
      useTerminalStore.getState().updateTerminal(mergeTarget.id, {
        worktreePath: undefined,
        worktreeBranch: undefined,
        agentSessionId: undefined,
        cwd: project.path,
      });
      // Mark the KanbanTask as merged-locally: clears worktree pointers,
      // flips useWorktree=false, and drops the agent session hooks. Next
      // reopen lands on the project's current branch with no resume — work
      // is in local now.
      if (mergeTarget.task?.id) {
        void useKanbanStore.getState().markTaskMergedLocally(mergeTarget.task.id);
      }
      await stopAndSyncTimer(mergeTarget.id, mergeTarget.task?.id);
      const prefix = result.autoCommitted ? 'Auto-committed pending changes, then merged' : 'Merged';
      setMergeStatus({ message: `${prefix} into ${result.targetBranch} successfully`, type: 'success' });
    } else {
      setMergeStatus({ message: result.error || 'Merge failed', type: 'error' });
    }
    setTimeout(() => setMergeStatus(null), 5000);
  }, [mergeTarget, project, stopAndSyncTimer]);

  const executeCreatePR = useCallback(async (targetBranch: string, title: string, body: string, autoMerge = false, cleanupWorktreeOpt = true, taskOptions?: TaskCompleteOptions) => {
    if (!mergeTarget || !project?.path) return;
    const saved = mergeTarget;
    setMergeTarget(null);

    const taskBranch = saved.worktreeBranch || saved.currentBranch || '';
    const pushCwd = saved.worktreePath || saved.cwd || project.path;
    const shouldCleanup = saved.isWorktree && cleanupWorktreeOpt;

    const terminal = useTerminalStore.getState().getTerminal(saved.id);
    if (terminal?.isClaudeMode) {
      let step = 1;
      const parts = [
        `Please create a pull request:`,
        `${step++}. Stage and commit any uncommitted changes`,
        `${step++}. Push branch "${taskBranch}" to origin`,
        `${step++}. Create a PR targeting "${targetBranch}"`,
        `   - Use this exact PR title: ${title}`,
      ];
      if (body.trim()) parts.push(`   - PR description:\n${body}`);
      if (autoMerge) parts.push(`${step++}. Enable auto-merge on the PR after creating it`);
      if (taskOptions?.setReadyForReview && taskOptions.taskId) {
        parts.push(`${step++}. After the PR is created successfully, update the ClickUp task ${taskOptions.taskId} status to "ready for review"`);
      }
      if (taskOptions?.postComment && taskOptions.taskId) {
        if (taskOptions.comment) {
          parts.push(`${step++}. Post this comment to ClickUp task ${taskOptions.taskId}:\n${taskOptions.comment}`);
        } else {
          parts.push(`${step++}. Post a comment to ClickUp task ${taskOptions.taskId} summarizing the root cause of the issue and the solution. Include relevant file changes.`);
        }
      }
      parts.push(`\nImportant: Use the PR title exactly as specified, do not modify it.`);

      window.electronAPI.sendTerminalInput(saved.id, parts.join('\n') + '\n');
      await stopAndSyncTimer(saved.id, saved.task?.id);
      if (shouldCleanup) {
        useTerminalStore.getState().markPendingWorktreeCleanup(saved.id);
      }
      setMergeStatus({
        message: shouldCleanup
          ? 'PR creation prompt sent to agent — worktree will clean up when terminal closes'
          : 'PR creation prompt sent to agent — worktree kept',
        type: 'success',
      });
      setTimeout(() => setMergeStatus(null), 5000);
      return;
    }

    const result = await window.electronAPI.createPR(
      project.path, pushCwd, taskBranch, targetBranch, title, body,
    );
    if (result.success) {
      if (autoMerge && result.prUrl && !result.existing) {
        try { await window.electronAPI.enablePRAutoMerge(project.path, taskBranch); } catch { /* non-critical */ }
      }
      const msg = result.existing
        ? `PR already exists: ${result.prUrl}`
        : autoMerge
          ? `PR created with auto-merge: ${result.prUrl}`
          : `PR created: ${result.prUrl}`;
      setMergeStatus({ message: msg, type: 'success' });
      if (result.prUrl) window.electronAPI?.openExternal?.(result.prUrl);
      await stopAndSyncTimer(saved.id, saved.task?.id);
      if (shouldCleanup) await cleanupWorktree(saved);
    } else {
      setMergeStatus({ message: result.error || 'Failed to create PR', type: 'error' });
    }
    setTimeout(() => setMergeStatus(null), 8000);
  }, [mergeTarget, project, cleanupWorktree, stopAndSyncTimer]);

  const executeCommit = useCallback(async (message: string) => {
    if (!mergeTarget) return;
    const saved = mergeTarget;
    setMergeTarget(null);

    const cwd = saved.cwd || saved.worktreePath || project?.path || '';
    const result = await window.electronAPI.gitCommit(cwd, message);
    if (result.success) {
      setMergeStatus({ message: `Committed: ${message}`, type: 'success' });
      await stopAndSyncTimer(saved.id, saved.task?.id);
    } else {
      setMergeStatus({ message: result.error || 'Failed to commit', type: 'error' });
    }
    setTimeout(() => setMergeStatus(null), 5000);
  }, [mergeTarget, project, stopAndSyncTimer]);

  const executeCreateBranchPR = useCallback(async (newBranch: string, targetBranch: string, title: string, body: string, cleanupWorktreeOpt = true, taskOptions?: TaskCompleteOptions) => {
    if (!mergeTarget || !project?.path) return;
    const saved = mergeTarget;
    setMergeTarget(null);

    const cwd = saved.cwd || saved.worktreePath || project.path;
    const shouldCleanup = saved.isWorktree && cleanupWorktreeOpt;

    const terminal = useTerminalStore.getState().getTerminal(saved.id);
    if (terminal?.isClaudeMode) {
      let step = 1;
      const parts = [
        `Please create a new branch and pull request:`,
        `${step++}. Stage and commit any uncommitted changes`,
        `${step++}. Create a new branch "${newBranch}" from current HEAD`,
        `${step++}. Push branch "${newBranch}" to origin`,
        `${step++}. Create a PR targeting "${targetBranch}"`,
        `   - Use this exact PR title: ${title}`,
      ];
      if (body.trim()) parts.push(`   - PR description:\n${body}`);
      if (taskOptions?.setReadyForReview && taskOptions.taskId) {
        parts.push(`${step++}. After the PR is created successfully, update the ClickUp task ${taskOptions.taskId} status to "ready for review"`);
      }
      if (taskOptions?.postComment && taskOptions.taskId) {
        if (taskOptions.comment) {
          parts.push(`${step++}. Post this comment to ClickUp task ${taskOptions.taskId}:\n${taskOptions.comment}`);
        } else {
          parts.push(`${step++}. Post a comment to ClickUp task ${taskOptions.taskId} summarizing the root cause of the issue and the solution. Include relevant file changes.`);
        }
      }
      parts.push(`\nImportant: Use the PR title exactly as specified, do not modify it.`);

      window.electronAPI.sendTerminalInput(saved.id, parts.join('\n') + '\n');
      await stopAndSyncTimer(saved.id, saved.task?.id);
      if (shouldCleanup) useTerminalStore.getState().markPendingWorktreeCleanup(saved.id);
      setMergeStatus({
        message: shouldCleanup
          ? 'Branch & PR prompt sent to agent — worktree will clean up when terminal closes'
          : 'Branch & PR prompt sent to agent — worktree kept',
        type: 'success',
      });
      setTimeout(() => setMergeStatus(null), 5000);
      return;
    }

    const result = await window.electronAPI.createBranchPR(cwd, newBranch, targetBranch, title, body);
    if (result.success) {
      const msg = result.existing
        ? `PR already exists: ${result.prUrl}`
        : `Branch "${result.branch}" created, PR: ${result.prUrl}`;
      setMergeStatus({ message: msg, type: 'success' });
      if (result.prUrl) window.electronAPI?.openExternal?.(result.prUrl);
      await stopAndSyncTimer(saved.id, saved.task?.id);
      if (shouldCleanup) await cleanupWorktree(saved);
    } else {
      setMergeStatus({ message: result.error || 'Failed to create branch & PR', type: 'error' });
    }
    setTimeout(() => setMergeStatus(null), 8000);
  }, [mergeTarget, project, cleanupWorktree, stopAndSyncTimer]);

  const modal = mergeTarget && project ? (
    <CompleteTaskModal
      taskBranch={mergeTarget.worktreeBranch || mergeTarget.currentBranch || ''}
      taskName={mergeTarget.task?.name}
      task={mergeTarget.task}
      terminalId={mergeTarget.id}
      isAgentRunning={!!useTerminalStore.getState().terminals.find((t) => t.id === mergeTarget.id)?.isClaudeMode}
      projectPath={mergeTarget.cwd || project.path}
      isWorktree={mergeTarget.isWorktree}
      defaultBaseBranch={mergeTarget.baseBranch}
      hasTaskManager={hasTaskManager}
      onMerge={executeMerge}
      onCreatePR={executeCreatePR}
      onCreateBranchPR={executeCreateBranchPR}
      onCommit={executeCommit}
      onCancel={() => setMergeTarget(null)}
    />
  ) : null;

  const statusBanner = mergeStatus ? (
    <div className={cn(
      'px-4 py-2 text-xs flex items-center justify-between shrink-0',
      mergeStatus.type === 'success'
        ? 'bg-emerald-500/20 text-emerald-400 border-b border-emerald-500/30'
        : 'bg-red-500/20 text-red-400 border-b border-red-500/30',
    )}>
      <span>{mergeStatus.message}</span>
      <button onClick={() => setMergeStatus(null)} className="hover:opacity-70">
        <X className="w-3 h-3" />
      </button>
    </div>
  ) : null;

  return { openCompleteTask, modal, statusBanner };
}
