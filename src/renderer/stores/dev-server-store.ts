import { create } from 'zustand';
import type { DevServerType, DevServerStatus, DevServerEvent } from '../../shared/types';

export interface DevServerLogEntry {
  text: string;
  timestamp: number;
}

interface DevServerState {
  /** Status per project: { [projectId]: { frontend, backend } } */
  status: Record<string, { frontend: DevServerStatus; backend: DevServerStatus }>;
  /** Log lines per project+type key: `${projectId}:${type}` */
  logs: Record<string, DevServerLogEntry[]>;
  /** Which log panel is open: null = closed */
  activeLog: { projectId: string; type: DevServerType } | null;

  /** Process a dev server event (status + optional output) */
  handleEvent: (event: DevServerEvent) => void;
  /** Toggle the log panel for a given project/type */
  toggleLog: (projectId: string, type: DevServerType) => void;
  /** Close the log panel */
  closeLog: () => void;
  /** Clear logs for a given project/type */
  clearLog: (projectId: string, type: DevServerType) => void;
}

const MAX_LOG_LINES = 5000;

function logKey(projectId: string, type: DevServerType): string {
  return `${projectId}:${type}`;
}

export const useDevServerStore = create<DevServerState>((set) => ({
  status: {},
  logs: {},
  activeLog: null,

  handleEvent: (event) =>
    set((state) => {
      const k = logKey(event.projectId, event.type);

      // Update status
      const current = state.status[event.projectId] || { frontend: 'stopped', backend: 'stopped' };
      const newStatus = {
        ...state.status,
        [event.projectId]: { ...current, [event.type]: event.status },
      };

      // Append log output if present
      let newLogs = state.logs;
      if (event.output || event.error) {
        const text = event.output || `[ERROR] ${event.error}`;
        const existing = state.logs[k] || [];
        const entry: DevServerLogEntry = { text, timestamp: Date.now() };
        const updated = [...existing, entry];
        // Trim to max lines
        newLogs = {
          ...state.logs,
          [k]: updated.length > MAX_LOG_LINES ? updated.slice(-MAX_LOG_LINES) : updated,
        };
      }

      return { status: newStatus, logs: newLogs };
    }),

  toggleLog: (projectId, type) =>
    set((state) => {
      const isOpen =
        state.activeLog?.projectId === projectId && state.activeLog?.type === type;
      return { activeLog: isOpen ? null : { projectId, type } };
    }),

  closeLog: () => set({ activeLog: null }),

  clearLog: (projectId, type) =>
    set((state) => ({
      logs: { ...state.logs, [logKey(projectId, type)]: [] },
    })),
}));
