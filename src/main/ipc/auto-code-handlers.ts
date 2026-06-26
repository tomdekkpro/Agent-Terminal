import type { BrowserWindow, IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog } from '../../shared/utils';
import { autoCodeOrchestrator } from '../orchestrator/auto-code-orchestrator';
import { getSettings } from './settings-handlers';

export function registerAutoCodeHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  autoCodeOrchestrator.init(getWindow);

  // Auto-start if enabled — small delay so the app finishes initializing first
  setTimeout(() => {
    const settings = getSettings();
    if (settings.autoCodeEnabled) {
      debugLog('[AutoCode] Auto-starting orchestrator from settings');
      autoCodeOrchestrator.start();
    }
  }, 5000);

  ipcMain.handle(IPC_CHANNELS.AUTO_CODE_STATUS, async () => {
    return { success: true, data: autoCodeOrchestrator.getStatus() };
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_CODE_START, async () => {
    try {
      autoCodeOrchestrator.start();
      return { success: true, data: autoCodeOrchestrator.getStatus() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_CODE_STOP, async () => {
    autoCodeOrchestrator.stop();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_CODE_RUN_NOW, async () => {
    try {
      await autoCodeOrchestrator.runNow();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to run cycle' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_CODE_RUN_TASK, async (_event, kanbanTaskId: string) => {
    try {
      const result = await autoCodeOrchestrator.runTaskNow(kanbanTaskId);
      return { success: result.ran, data: result, error: result.ran ? undefined : result.message };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to run task' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTO_CODE_REQUEUE, async (_event, kanbanTaskId: string) => {
    const record = autoCodeOrchestrator.requeueTask(kanbanTaskId);
    if (!record) return { success: false, error: 'Task not found' };
    return { success: true, data: record };
  });

  // Per-task auto-merge override now goes through KANBAN_UPDATE directly —
  // kept as an alias for backward-compat with the old preload method.
  ipcMain.handle(
    IPC_CHANNELS.AUTO_CODE_SET_TASK_AUTOMERGE,
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

export function stopAutoCodeOrchestrator(): void {
  autoCodeOrchestrator.stop();
}
