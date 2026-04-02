import { create } from 'zustand';
import type { SystemMonitorData } from '../../shared/types';

interface SystemMonitorState {
  data: SystemMonitorData | null;
  isLoading: boolean;
  setData: (data: SystemMonitorData) => void;
  setLoading: (loading: boolean) => void;
}

export const useSystemMonitorStore = create<SystemMonitorState>((set) => ({
  data: null,
  isLoading: true,
  setData: (data) => set({ data, isLoading: false }),
  setLoading: (isLoading) => set({ isLoading }),
}));
