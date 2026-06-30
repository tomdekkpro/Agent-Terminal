import { useEffect } from 'react';
import { useTerminalStore, flushTerminalStateSync } from '../stores/terminal-store';
import { postTimeEntriesByDateSync } from '../utils/time-tracking';

/** Sync all running timers to task manager, split by date (fire-and-forget) */
function syncAllTimers() {
  const terminals = useTerminalStore.getState().terminals;
  const now = Date.now();
  for (const t of terminals) {
    if (!t.timeTracking || !t.task) continue;
    const { startedAt } = t.timeTracking;
    // Only post the current running session (paused time was already posted on stop)
    if (!startedAt) continue;
    const sessionMs = now - startedAt;
    if (sessionMs <= 0) continue;
    postTimeEntriesByDateSync(t.task.id, startedAt, now);
  }
}

export function useGlobalTerminalListeners() {
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);
  const setTerminalStatus = useTerminalStore((s) => s.setTerminalStatus);

  useEffect(() => {
    const cleanups: (() => void)[] = [];

    // Listen for terminal output
    cleanups.push(
      window.electronAPI.onTerminalOutput((id, data) => {
        const { writeToTerminal } = useTerminalStore.getState();
        writeToTerminal(id, data);
      })
    );

    // Listen for terminal exit — clear agent busy state, flush the final
    // usage to the KanbanTask, and run worktree cleanup if it was queued
    // by a CompleteTask action.
    cleanups.push(
      window.electronAPI.onTerminalExit((id, _exitCode) => {
        setTerminalStatus(id, 'exited');
        updateTerminal(id, { isClaudeBusy: false, isClaudeMode: false });
        const terminal = useTerminalStore.getState().terminals.find((t) => t.id === id);
        // Persist final usage (skip the throttle so we always capture the
        // last value before the watcher stops).
        if (terminal?.usage && terminal.task?.id) {
          const clickupTaskId = terminal.task.id;
          const usage = terminal.usage;
          window.electronAPI.kanbanList?.().then((result: any) => {
            if (!result?.success || !Array.isArray(result.data)) return;
            const match = result.data.find((k: any) => k.clickupTaskId === clickupTaskId);
            if (!match) return;
            window.electronAPI.kanbanUpdate?.(match.id, {
              usage: { ...usage, updatedAt: new Date().toISOString() },
            });
          }).catch(() => { /* non-critical */ });
        }
        if (terminal?.pendingWorktreeCleanup && terminal.worktreePath) {
          void useTerminalStore.getState().cleanupWorktree(id);
        }
      })
    );

    // Listen for title changes (e.g. agent invocation sends provider name)
    cleanups.push(
      window.electronAPI.onTerminalTitleChange((id, title) => {
        const terminal = useTerminalStore.getState().terminals.find(t => t.id === id);
        // Skip if terminal has a linked task — task title takes priority, agent shown via icon
        if (!terminal?.task) {
          updateTerminal(id, { title });
        }
      })
    );

    // Listen for agent busy state (generic)
    if (window.electronAPI.onTerminalAgentBusy) {
      cleanups.push(
        window.electronAPI.onTerminalAgentBusy((id, isBusy) => {
          updateTerminal(id, { isClaudeBusy: isBusy });
        })
      );
    }

    // Per-terminal usage updates from the session-JSONL watcher (cumulative).
    // Track the last KanbanTask write per terminal so we don't hammer the
    // store with redundant kanbanUpdate IPC calls every poll.
    const lastKanbanUsageWrite = new Map<string, number>();
    const KANBAN_USAGE_PERSIST_INTERVAL_MS = 15_000;

    if (window.electronAPI.onTerminalUsage) {
      cleanups.push(
        window.electronAPI.onTerminalUsage((data: {
          terminalId: string;
          model?: string;
          inputTokens: number;
          outputTokens: number;
          cacheCreationTokens: number;
          cacheReadTokens: number;
          cost: number;
        }) => {
          const usage = {
            model: data.model,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            cacheCreationTokens: data.cacheCreationTokens,
            cacheReadTokens: data.cacheReadTokens,
            cost: data.cost,
          };
          updateTerminal(data.terminalId, { usage });

          // Persist to the matching KanbanTask so the cost shows on the
          // board even after the terminal closes. Throttled — every 15s
          // is plenty for a UI badge and avoids a write per 3s poll.
          const terminal = useTerminalStore.getState().terminals.find((t) => t.id === data.terminalId);
          const clickupTaskId = terminal?.task?.id;
          if (!clickupTaskId) return;
          const last = lastKanbanUsageWrite.get(data.terminalId) || 0;
          const now = Date.now();
          if (now - last < KANBAN_USAGE_PERSIST_INTERVAL_MS) return;
          lastKanbanUsageWrite.set(data.terminalId, now);
          window.electronAPI.kanbanList?.().then((result: any) => {
            if (!result?.success || !Array.isArray(result.data)) return;
            const match = result.data.find((k: any) => k.clickupTaskId === clickupTaskId);
            if (!match) return;
            window.electronAPI.kanbanUpdate?.(match.id, {
              usage: { ...usage, updatedAt: new Date().toISOString() },
            });
          }).catch(() => { /* non-critical */ });
        })
      );
    }

    // When an agent session id is captured, also write it back to the matching
    // KanbanTask (if any) so sessions survive terminal removal, AND bump the
    // kanbanStatus from "todo" to "in-progress" on first agent run.
    const syncKanbanSession = (terminalId: string, sessionId: string) => {
      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === terminalId);
      const clickupTaskId = terminal?.task?.id;
      if (!clickupTaskId) return;
      window.electronAPI.kanbanList?.().then((result: any) => {
        if (!result?.success || !Array.isArray(result.data)) return;
        const match = result.data.find((k: any) => k.clickupTaskId === clickupTaskId);
        if (!match) return;
        const patch: Record<string, unknown> = { agentSessionId: sessionId };
        if (terminal?.agentProvider) patch.agentProvider = terminal.agentProvider;
        // Capture the cwd the session was actually started in. Claude scopes
        // `--resume <id>` lookups by encoded cwd, so on restore we must come
        // back to this exact directory or the session won't be found.
        if (terminal?.cwd) patch.agentCwd = terminal.cwd;
        if (terminal?.worktreePath) patch.worktreePath = terminal.worktreePath;
        if (terminal?.worktreeBranch) patch.worktreeBranch = terminal.worktreeBranch;
        // Agent is running → the task is in active work. Only advance from
        // "todo" so we don't drag cards back from review/failed/done.
        if (match.kanbanStatus === 'todo') patch.kanbanStatus = 'in-progress';
        window.electronAPI.kanbanUpdate?.(match.id, patch);
      }).catch(() => { /* non-critical */ });
    };

    // Listen for agent session ID detection (generic)
    if (window.electronAPI.onTerminalAgentSession) {
      cleanups.push(
        window.electronAPI.onTerminalAgentSession((id, sessionId) => {
          updateTerminal(id, { agentSessionId: sessionId });
          syncKanbanSession(id, sessionId);
        })
      );
    }

    // Resume aborted because its working directory was gone (e.g. a deleted
    // worktree). Reset the terminal to idle so the Start button shows, and drop
    // the stale session/worktree pointers on the matching KanbanTask so its
    // card flips from "Resume session" back to "Click to start".
    if (window.electronAPI.onTerminalResumeFailed) {
      cleanups.push(
        window.electronAPI.onTerminalResumeFailed((id, info) => {
          updateTerminal(id, {
            isClaudeMode: false,
            isClaudeBusy: false,
            agentSessionId: undefined,
          });
          setTerminalStatus(id, 'idle');
          if (info?.reason !== 'cwd-missing') return;
          const terminal = useTerminalStore.getState().terminals.find((t) => t.id === id);
          const clickupTaskId = terminal?.task?.id;
          if (!clickupTaskId) return;
          window.electronAPI.kanbanList?.().then((result: any) => {
            if (!result?.success || !Array.isArray(result.data)) return;
            const match = result.data.find((k: any) => k.clickupTaskId === clickupTaskId);
            if (!match) return;
            window.electronAPI.kanbanUpdate?.(match.id, {
              agentSessionId: undefined,
              agentProvider: undefined,
              agentCwd: undefined,
              worktreePath: undefined,
              worktreeBranch: undefined,
            });
          }).catch(() => { /* non-critical */ });
        })
      );
    }

    // Legacy listeners (still fired for backward compat)
    cleanups.push(
      window.electronAPI.onTerminalClaudeBusy((id, isBusy) => {
        updateTerminal(id, { isClaudeBusy: isBusy });
      })
    );

    cleanups.push(
      window.electronAPI.onTerminalClaudeSession((id, sessionId) => {
        updateTerminal(id, { agentSessionId: sessionId });
        syncKanbanSession(id, sessionId);
      })
    );

    // Flush terminal state and sync timers before app closes
    const handleBeforeUnload = () => {
      flushTerminalStateSync();
      syncAllTimers();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    cleanups.push(() => window.removeEventListener('beforeunload', handleBeforeUnload));

    return () => cleanups.forEach((c) => c());
  }, [updateTerminal, setTerminalStatus]);
}
