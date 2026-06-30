import { create } from 'zustand';
import type { DashboardNotice, NoticeSource } from '../../shared/types';

export interface SaveNoticeInput {
  id?: string;
  title: string;
  prompt: string;
  scheduleTime?: string;
  enabled?: boolean;
  projectPath?: string;
  listId?: string;
  sources?: NoticeSource[];
  urls?: string[];
}

interface DashboardState {
  notices: DashboardNotice[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (input: SaveNoticeInput) => Promise<DashboardNotice | null>;
  remove: (id: string) => Promise<void>;
  run: (id: string) => Promise<void>;
  handleEvent: (event: any) => void;
}

function upsert(notices: DashboardNotice[], notice: DashboardNotice): DashboardNotice[] {
  const idx = notices.findIndex((n) => n.id === notice.id);
  if (idx < 0) return [...notices, notice];
  const copy = notices.slice();
  copy[idx] = notice;
  return copy;
}

export const useDashboardStore = create<DashboardState>((set) => ({
  notices: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.dashboardList();
      if (result.success) set({ notices: result.data || [], loading: false });
      else set({ loading: false, error: result.error || 'Failed to load notices' });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load notices' });
    }
  },

  save: async (input) => {
    try {
      const result = await window.electronAPI.dashboardSave(input);
      if (result.success && result.data) {
        set((s) => ({ notices: upsert(s.notices, result.data) }));
        return result.data;
      }
      set({ error: result.error || 'Failed to save notice' });
      return null;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to save notice' });
      return null;
    }
  },

  remove: async (id) => {
    try {
      const result = await window.electronAPI.dashboardDelete(id);
      if (result.success) set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
      else set({ error: result.error || 'Failed to delete notice' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to delete notice' });
    }
  },

  run: async (id) => {
    // Optimistic: mark running so the card spins immediately.
    set((s) => ({ notices: s.notices.map((n) => (n.id === id ? { ...n, status: 'running' as const, lastError: undefined } : n)) }));
    try {
      const result = await window.electronAPI.dashboardRun(id);
      if (!result.success) set({ error: result.error || 'Failed to run notice' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to run notice' });
    }
  },

  handleEvent: (event) => {
    if (!event) return;
    if (event.type === 'notice-updated' && event.notice) {
      set((s) => ({ notices: upsert(s.notices, event.notice) }));
    } else if (event.type === 'notice-deleted' && event.id) {
      set((s) => ({ notices: s.notices.filter((n) => n.id !== event.id) }));
    }
  },
}));

/** Install the global dashboard event listener — call once from the view. */
export function subscribeDashboardEvents(): () => void {
  const unsub = window.electronAPI.onDashboardEvent?.((event: any) => {
    useDashboardStore.getState().handleEvent(event);
  });
  return () => unsub?.();
}
