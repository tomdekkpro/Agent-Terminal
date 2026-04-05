import { useEffect } from 'react';
import { useTerminalStore, flushTerminalStateSync } from '../stores/terminal-store';

/** Sync all running/paused timers to task manager (fire-and-forget) */
function syncAllTimers() {
  const terminals = useTerminalStore.getState().terminals;
  for (const t of terminals) {
    if (!t.timeTracking || !t.task) continue;
    const { startedAt, elapsed } = t.timeTracking;
    const total = elapsed + (startedAt ? Date.now() - startedAt : 0);
    if (total <= 0) continue;
    const start = startedAt || Date.now() - total;
    try {
      window.electronAPI.postTaskTimeEntry(t.task.id, start, total);
    } catch { /* best effort */ }
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

    // Listen for agent session ID detection (generic)
    if (window.electronAPI.onTerminalAgentSession) {
      cleanups.push(
        window.electronAPI.onTerminalAgentSession((id, sessionId) => {
          updateTerminal(id, { agentSessionId: sessionId });
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
