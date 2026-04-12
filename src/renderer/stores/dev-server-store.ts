import { create } from 'zustand';
import type { DevServerType, DevServerStatus } from '../../shared/types';

interface DevServerState {
  /** Status per project: { [projectId]: { frontend, backend } } */
  status: Record<string, { frontend: DevServerStatus; backend: DevServerStatus }>;
  /** Terminal ID per project+type key: `${projectId}:${type}` */
  terminalIds: Record<string, string>;
  /** Which log panel is open: null = closed */
  activeLog: { projectId: string; type: DevServerType } | null;

  /** Update status for a given project/type */
  setStatus: (projectId: string, type: DevServerType, status: DevServerStatus) => void;
  /** Get status for a given project/type */
  getStatus: (projectId: string, type: DevServerType) => DevServerStatus;
  /** Store terminal ID for a given project/type */
  setTerminalId: (projectId: string, type: DevServerType, terminalId: string) => void;
  /** Get terminal ID for a given project/type */
  getTerminalId: (projectId: string, type: DevServerType) => string | undefined;
  /** Clear terminal ID for a given project/type */
  clearTerminalId: (projectId: string, type: DevServerType) => void;
  /** Toggle the log panel for a given project/type */
  toggleLog: (projectId: string, type: DevServerType) => void;
  /** Close the log panel */
  closeLog: () => void;
}

function logKey(projectId: string, type: DevServerType): string {
  return `${projectId}:${type}`;
}

export const useDevServerStore = create<DevServerState>((set, get) => ({
  status: {},
  terminalIds: {},
  activeLog: null,

  setStatus: (projectId, type, status) =>
    set((state) => {
      const current = state.status[projectId] || { frontend: 'stopped', backend: 'stopped' };
      return {
        status: {
          ...state.status,
          [projectId]: { ...current, [type]: status },
        },
      };
    }),

  getStatus: (projectId, type) => {
    const s = get().status[projectId];
    return s ? s[type] : 'stopped';
  },

  setTerminalId: (projectId, type, terminalId) =>
    set((state) => ({
      terminalIds: { ...state.terminalIds, [logKey(projectId, type)]: terminalId },
    })),

  getTerminalId: (projectId, type) => {
    return get().terminalIds[logKey(projectId, type)];
  },

  clearTerminalId: (projectId, type) =>
    set((state) => {
      const updated = { ...state.terminalIds };
      delete updated[logKey(projectId, type)];
      return { terminalIds: updated };
    }),

  toggleLog: (projectId, type) =>
    set((state) => {
      const isOpen =
        state.activeLog?.projectId === projectId && state.activeLog?.type === type;
      return { activeLog: isOpen ? null : { projectId, type } };
    }),

  closeLog: () => set({ activeLog: null }),
}));
