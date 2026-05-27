import { useCallback, useEffect } from 'react';
import { v4 as uuid } from 'uuid';
import { Play, Square, ScrollText } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useDevServerStore } from '../../stores/dev-server-store';
import { cn } from '../../../shared/utils';
import type { DevServerType } from '../../../shared/types';

/** FE / BE dev-server start-stop buttons + log toggles for the active project.
 *  Self-contained: owns the start/stop logic, the dev-server status store
 *  wiring, and the terminal-exit listener that flips status back to "stopped"
 *  when a server process dies. Used in the Terminal page tab bar and the
 *  Kanban board toolbar. Renders nothing when the active project has no
 *  dev-server commands configured. */
export function ProjectDevServerActions() {
  const activeProject = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const serverStatus = useDevServerStore((s) => s.status);
  const setServerStatus = useDevServerStore((s) => s.setStatus);
  const toggleLog = useDevServerStore((s) => s.toggleLog);
  const activeLog = useDevServerStore((s) => s.activeLog);

  // Listen for dev server terminal exits — flip status to stopped so the
  // button reflects a crashed/quit process regardless of which view is mounted.
  useEffect(() => {
    const cleanup = window.electronAPI.onTerminalExit((id: string) => {
      const store = useDevServerStore.getState();
      for (const [key, terminalId] of Object.entries(store.terminalIds)) {
        if (terminalId === id) {
          const [pid, tp] = key.split(':');
          store.setStatus(pid, tp as DevServerType, 'stopped');
          store.clearTerminalId(pid, tp as DevServerType);
        }
      }
    });
    return () => { cleanup(); };
  }, []);

  const handleToggleServer = useCallback(async (projectId: string, type: DevServerType) => {
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    if (!project?.devServer) return;

    const current = useDevServerStore.getState().status[projectId]?.[type] || 'stopped';

    if (current === 'running' || current === 'starting') {
      // Stop: send Ctrl+C to the terminal
      const terminalId = useDevServerStore.getState().getTerminalId(projectId, type);
      if (terminalId) {
        window.electronAPI.sendTerminalInput(terminalId, '\x03');
      }
      setServerStatus(projectId, type, 'stopped');
    } else {
      // Start: create a background PTY (no terminal tab) and run the command
      const config = project.devServer;
      let cmd = type === 'frontend' ? config.frontendCmd : config.backendCmd;
      const subCwd = type === 'frontend' ? config.frontendCwd : config.backendCwd;

      if (!cmd) return;
      if (type === 'backend' && config.backendProfile) {
        cmd += ` --launch-profile "${config.backendProfile}"`;
      }

      const resolvedCwd = subCwd ? `${project.path}/${subCwd}` : project.path;

      // Destroy old PTY if it still exists
      const oldId = useDevServerStore.getState().getTerminalId(projectId, type);
      if (oldId) {
        window.electronAPI.destroyTerminal(oldId).catch(() => {});
        useDevServerStore.getState().clearTerminalId(projectId, type);
      }

      // Create a new background PTY
      const terminalId = `devserver-${type}-${uuid()}`;
      setServerStatus(projectId, type, 'starting');
      useDevServerStore.getState().setTerminalId(projectId, type, terminalId);

      try {
        await window.electronAPI.createTerminal({
          id: terminalId,
          cwd: resolvedCwd,
          cols: 120,
          rows: 30,
        });

        // Wait for shell to be ready, then write the command
        const cmdToSend = cmd;
        setTimeout(() => {
          window.electronAPI.sendTerminalInput(terminalId, cmdToSend + '\r');
          setServerStatus(projectId, type, 'running');
        }, 500);

        // Auto-open the log panel
        useDevServerStore.getState().toggleLog(projectId, type);
      } catch {
        setServerStatus(projectId, type, 'error');
        setTimeout(() => setServerStatus(projectId, type, 'stopped'), 2000);
      }
    }
  }, [setServerStatus]);

  if (!activeProject?.devServer) return null;
  const status = serverStatus[activeProject.id] || { frontend: 'stopped', backend: 'stopped' };
  const hasFe = !!activeProject.devServer.frontendCmd;
  const hasBe = !!activeProject.devServer.backendCmd;
  if (!hasFe && !hasBe) return null;

  return (
    <div className="flex items-center gap-1 shrink-0">
      {hasFe && (
        <div className="flex items-center gap-0">
          <button
            onClick={() => handleToggleServer(activeProject.id, 'frontend')}
            title={`Frontend: ${status.frontend}${status.frontend === 'stopped' ? ' — Click to start' : ' — Click to stop'}`}
            className={cn(
              'flex items-center gap-1 h-6 px-2 rounded-l text-[10px] font-medium transition-all',
              status.frontend === 'running'
                ? 'bg-[#22c55e]/15 text-[#22c55e] hover:bg-[#ef4444]/15 hover:text-[#ef4444]'
                : status.frontend === 'starting'
                ? 'bg-[#f59e0b]/15 text-[#f59e0b] animate-pulse'
                : status.frontend === 'error'
                ? 'bg-[#ef4444]/15 text-[#ef4444]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[#22c55e] hover:bg-[#22c55e]/10',
            )}
          >
            {status.frontend === 'running' || status.frontend === 'starting' ? (
              <Square className="w-2.5 h-2.5" />
            ) : (
              <Play className="w-2.5 h-2.5" />
            )}
            <span>FE</span>
          </button>
          <button
            onClick={() => toggleLog(activeProject.id, 'frontend')}
            title="Toggle frontend logs"
            className={cn(
              'flex items-center h-6 px-1 rounded-r text-[10px] transition-all border-l border-black/10',
              activeLog?.projectId === activeProject.id && activeLog?.type === 'frontend'
                ? 'bg-[#22c55e]/25 text-[#22c55e]'
                : status.frontend === 'running'
                ? 'bg-[#22c55e]/15 text-[#22c55e]/60 hover:text-[#22c55e]'
                : status.frontend === 'starting'
                ? 'bg-[#f59e0b]/15 text-[#f59e0b]/60'
                : status.frontend === 'error'
                ? 'bg-[#ef4444]/15 text-[#ef4444]/60'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            <ScrollText className="w-2.5 h-2.5" />
          </button>
        </div>
      )}
      {hasBe && (
        <div className="flex items-center gap-0">
          <button
            onClick={() => handleToggleServer(activeProject.id, 'backend')}
            title={`Backend: ${status.backend}${status.backend === 'stopped' ? ' — Click to start' : ' — Click to stop'}`}
            className={cn(
              'flex items-center gap-1 h-6 px-2 rounded-l text-[10px] font-medium transition-all',
              status.backend === 'running'
                ? 'bg-[#6366f1]/15 text-[#6366f1] hover:bg-[#ef4444]/15 hover:text-[#ef4444]'
                : status.backend === 'starting'
                ? 'bg-[#f59e0b]/15 text-[#f59e0b] animate-pulse'
                : status.backend === 'error'
                ? 'bg-[#ef4444]/15 text-[#ef4444]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[#6366f1] hover:bg-[#6366f1]/10',
            )}
          >
            {status.backend === 'running' || status.backend === 'starting' ? (
              <Square className="w-2.5 h-2.5" />
            ) : (
              <Play className="w-2.5 h-2.5" />
            )}
            <span>BE</span>
          </button>
          <button
            onClick={() => toggleLog(activeProject.id, 'backend')}
            title="Toggle backend logs"
            className={cn(
              'flex items-center h-6 px-1 rounded-r text-[10px] transition-all border-l border-black/10',
              activeLog?.projectId === activeProject.id && activeLog?.type === 'backend'
                ? 'bg-[#6366f1]/25 text-[#6366f1]'
                : status.backend === 'running'
                ? 'bg-[#6366f1]/15 text-[#6366f1]/60 hover:text-[#6366f1]'
                : status.backend === 'starting'
                ? 'bg-[#f59e0b]/15 text-[#f59e0b]/60'
                : status.backend === 'error'
                ? 'bg-[#ef4444]/15 text-[#ef4444]/60'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
            )}
          >
            <ScrollText className="w-2.5 h-2.5" />
          </button>
        </div>
      )}
    </div>
  );
}
