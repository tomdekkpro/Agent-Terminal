import type { IpcMain } from 'electron';
import type { TerminalManager } from '../terminal/terminal-manager';
import type { WindowGetter } from '../terminal/types';
import type { AgentProviderId, AgentInvokeOptions } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/constants';
import { agentRegistry } from './providers/agent-registry';
import { loadTerminalState, saveTerminalState, loadOutputBuffers, type SavedTerminalState } from '../terminal/terminal-state-store';

export function registerTerminalHandlers(
  ipcMain: IpcMain,
  terminalManager: TerminalManager,
  _getWindow: WindowGetter
): void {
  ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, async (_event, options) => {
    return terminalManager.create(options);
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_DESTROY, async (_event, id: string) => {
    return terminalManager.destroy(id);
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_WRITE, (_event, id: string, data: string) => {
    terminalManager.write(id, data);
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (_event, id: string, cols: number, rows: number) => {
    terminalManager.resize(id, cols, rows);
  });

  // ─── Unified Agent Handlers ──────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.TERMINAL_INVOKE_AGENT, async (_event, id: string, agentId: AgentProviderId, options?: AgentInvokeOptions) => {
    return terminalManager.invokeAgent(id, agentId, options || {});
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESUME_AGENT, async (_event, id: string, agentId: AgentProviderId, options?: AgentInvokeOptions) => {
    terminalManager.resumeAgent(id, agentId, options || {});
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_AGENT_LIST, async () => {
    return { success: true, data: agentRegistry.getAllMeta() };
  });

  // ─── Legacy Per-Agent Handlers (delegate to unified) ─────────

  ipcMain.handle(IPC_CHANNELS.TERMINAL_INVOKE_CLAUDE, async (_event, id: string, cwd?: string, skipPermissions?: boolean, model?: string) => {
    return terminalManager.invokeAgent(id, 'claude', { cwd, skipPermissions, model });
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_INVOKE_COPILOT, async (_event, id: string, cwd?: string, model?: string) => {
    return terminalManager.invokeAgent(id, 'copilot', { cwd, model });
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESUME_COPILOT, async (_event, id: string, cwd?: string) => {
    terminalManager.resumeAgent(id, 'copilot', { cwd });
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESUME_CLAUDE, async (_event, id: string, sessionId?: string, cwd?: string) => {
    terminalManager.resumeAgent(id, 'claude', { sessionId, cwd });
    return { success: true };
  });

  // ─── Terminal State Persistence ──────────────────────────────

  ipcMain.handle(IPC_CHANNELS.TERMINAL_STATE_LOAD, async () => {
    return { success: true, data: loadTerminalState() };
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_BUFFERS_LOAD, async () => {
    return { success: true, data: loadOutputBuffers() };
  });

  // Enrich saved state with agentSessionId from main process terminals
  // (the renderer may not have received the IPC event yet)
  function enrichWithSessionIds(state: SavedTerminalState): SavedTerminalState {
    return {
      ...state,
      terminals: state.terminals.map((t) => {
        const mainTerminal = terminalManager.getTerminal(t.id);
        if (mainTerminal?.agentSessionId && !t.agentSessionId) {
          return { ...t, agentSessionId: mainTerminal.agentSessionId };
        }
        return t;
      }),
    };
  }

  ipcMain.handle(IPC_CHANNELS.TERMINAL_STATE_SAVE, async (_event, state: SavedTerminalState) => {
    saveTerminalState(enrichWithSessionIds(state));
    return { success: true };
  });

  // Synchronous save for beforeunload
  ipcMain.on(IPC_CHANNELS.TERMINAL_STATE_SAVE_SYNC, (event, state: SavedTerminalState) => {
    saveTerminalState(enrichWithSessionIds(state));
    event.returnValue = true;
  });
}
