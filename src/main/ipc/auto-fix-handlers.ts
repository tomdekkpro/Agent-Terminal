import type { BrowserWindow, IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog } from '../../shared/utils';
import { autoFixOrchestrator } from '../orchestrator/auto-fix-orchestrator';
import { getSettings } from './settings-handlers';

export function registerAutoFixHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  autoFixOrchestrator.init(getWindow);

  // Auto-start if enabled — small delay so the app finishes initializing first
  setTimeout(() => {
    const settings = getSettings();
    if (settings.autoFixEnabled) {
      debugLog('[AutoFix] Auto-starting orchestrator from settings');
      autoFixOrchestrator.start();
    }
  }, 5000);

  ipcMain.handle(IPC_CHANNELS.AUTO_FIX_STATUS, async () => {
    return { success: true, data: autoFixOrchestrator.getStatus() };
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_FIX_START, async () => {
    try {
      autoFixOrchestrator.start();
      return { success: true, data: autoFixOrchestrator.getStatus() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_FIX_STOP, async () => {
    autoFixOrchestrator.stop();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_FIX_RUN_NOW, async () => {
    try {
      await autoFixOrchestrator.runNow();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to run cycle' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_FIX_REQUEUE, async (_event, kanbanTaskId: string) => {
    const record = autoFixOrchestrator.requeueTask(kanbanTaskId);
    if (!record) return { success: false, error: 'Task not found' };
    return { success: true, data: record };
  });

  // Per-task auto-merge override now goes through KANBAN_UPDATE directly —
  // kept as an alias for backward-compat with the old preload method.
  ipcMain.handle(
    IPC_CHANNELS.AUTO_FIX_SET_TASK_AUTOMERGE,
    async (_event, kanbanTaskId: string, override: boolean | null) => {
      const { updateKanbanTask } = await import('../kanban/kanban-task-store');
      const { broadcastKanbanEvent } = await import('./kanban-handlers');
      const record = updateKanbanTask(kanbanTaskId, { autoMergeOverride: override });
      if (!record) return { success: false, error: 'Task not found' };
      broadcastKanbanEvent({ type: 'task-updated', task: record });
      return { success: true, data: record };
    },
  );
}

export function stopAutoFixOrchestrator(): void {
  autoFixOrchestrator.stop();
}
