import { create } from 'zustand';
import type { ActivityEvent } from '../../shared/types';

interface ActivityState {
  items: ActivityEvent[];
  loading: boolean;
  loaded: boolean;
  error: string | null;

  unreadCount: () => number;

  load: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  clear: () => Promise<void>;

  // Internal — applied by the global event listener.
  _add: (item: ActivityEvent) => void;
  _markReadLocal: (id: string) => void;
  _markAllReadLocal: () => void;
  _clearLocal: () => void;
}

const MAX = 500;

export const useActivityStore = create<ActivityState>((set, get) => ({
  items: [],
  loading: false,
  loaded: false,
  error: null,

  unreadCount: () => get().items.reduce((n, i) => n + (i.read ? 0 : 1), 0),

  load: async () => {
    set({ loading: true });
    try {
      const res = await window.electronAPI.activityList?.();
      if (res?.success && Array.isArray(res.data)) {
        set({ items: res.data, loaded: true, error: null });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load activity' });
    } finally {
      set({ loading: false });
    }
  },

  markRead: async (id) => {
    get()._markReadLocal(id);
    try { await window.electronAPI.markActivityRead?.(id); } catch { /* non-critical */ }
  },

  markAllRead: async () => {
    get()._markAllReadLocal();
    try { await window.electronAPI.markAllActivityRead?.(); } catch { /* non-critical */ }
  },

  clear: async () => {
    get()._clearLocal();
    try { await window.electronAPI.clearActivity?.(); } catch { /* non-critical */ }
  },

  _add: (item) =>
    set((state) => ({ items: [item, ...state.items].slice(0, MAX) })),
  _markReadLocal: (id) =>
    set((state) => ({ items: state.items.map((i) => (i.id === id ? { ...i, read: true } : i)) })),
  _markAllReadLocal: () =>
    set((state) => ({ items: state.items.map((i) => ({ ...i, read: true })) })),
  _clearLocal: () => set({ items: [] }),
}));

/** Install the global activity event listener — call once at app root so the
 *  unread badge stays live even when the Activity view isn't open. Returns an
 *  unsubscribe fn. */
export function subscribeActivityEvents(): () => void {
  const unsub = window.electronAPI.onActivityEvent?.((event: any) => {
    if (!event) return;
    const store = useActivityStore.getState();
    switch (event.type) {
      case 'item-added':
        if (event.item) store._add(event.item);
        break;
      case 'item-read':
        if (event.id) store._markReadLocal(event.id);
        break;
      case 'all-read':
        store._markAllReadLocal();
        break;
      case 'cleared':
        store._clearLocal();
        break;
    }
  });
  return () => unsub?.();
}
