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

    // Listen for terminal exit — also clear agent busy state
    cleanups.push(
      window.electronAPI.onTerminalExit((id, _exitCode) => {
        setTerminalStatus(id, 'exited');
        updateTerminal(id, { isClaudeBusy: false, isClaudeMode: false });
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
