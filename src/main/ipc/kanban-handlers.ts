import type { BrowserWindow, IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog, debugError } from '../../shared/utils';
import type { KanbanTask, KanbanTaskStatus } from '../../shared/types';
import {
  listKanbanTasks,
  getKanbanTask,
  importKanbanTask,
  createLocalKanbanTask,
  updateKanbanTask,
  deleteKanbanTask,
  type ImportTaskInput,
  type CreateLocalTaskInput,
} from '../kanban/kanban-task-store';
import { ClickUpProvider } from './providers/clickup';
import { getSettings } from './settings-handlers';
import { mapClickupStatusToKanban } from '../../shared/kanban-status-mapper';
import { computeDailyCostBreakdown } from '../usage/daily-cost-aggregator';

const clickUpProvider = new ClickUpProvider();

export type KanbanEvent =
  | { type: 'task-created'; task: KanbanTask }
  | { type: 'task-updated'; task: KanbanTask }
  | { type: 'task-deleted'; id: string }
  | { type: 'refreshed'; tasks: KanbanTask[] };

let emitKanbanEvent: (event: KanbanEvent) => void = () => {};

/** Exposed so other modules (orchestrator) can push task-updated events */
export function broadcastKanbanEvent(event: KanbanEvent): void {
  emitKanbanEvent(event);
}

/** Fetch fresh ClickUp snapshot for every tracked task and update local records. */
async function refreshClickupSnapshots(): Promise<KanbanTask[]> {
  const settings = getSettings();
  if (settings.taskManagerProvider !== 'clickup') {
    return listKanbanTasks();
  }

  const tasks = listKanbanTasks();
  if (tasks.length === 0) return tasks;

  const updated: KanbanTask[] = [];
  await Promise.all(
    tasks.map(async (task) => {
      // Local tasks aren't backed by ClickUp — leave them untouched.
      if (task.provider === 'local') {
        updated.push(task);
        return;
      }
      try {
        const result = await clickUpProvider.getTask(settings, task.clickupTaskId);
        if (!result.success) {
          updated.push(task);
          return;
        }
        const fresh = result.data;
        const patch: Partial<KanbanTask> = {
          clickupName: fresh.name,
          clickupStatus: fresh.status.name,
          clickupStatusColor: fresh.status.color,
          clickupCustomId: fresh.customId,
          clickupAssignees: fresh.assignees.map((a) => ({
            id: a.id,
            username: a.username,
            initials: a.initials,
          })),
          clickupPriority: fresh.priority,
          clickupTags: fresh.tags,
          clickupUpdatedAt: fresh.updatedAt,
        };

        // Auto-transition kanbanStatus when ClickUp status actually changes —
        // respect manual drag by only mapping on a real diff, not every poll.
        if (fresh.status.name && fresh.status.name !== task.clickupStatus) {
          const mapped = mapClickupStatusToKanban(fresh.status.name, settings);
          if (mapped && mapped !== task.kanbanStatus) {
            patch.kanbanStatus = mapped;
          }
        }

        const next = updateKanbanTask(task.id, patch);
        updated.push(next || task);
      } catch (err) {
        debugError('[Kanban] Failed to refresh', task.clickupTaskId, err);
        updated.push(task);
      }
    }),
  );

  emitKanbanEvent({ type: 'refreshed', tasks: updated });
  return updated;
}

export function registerKanbanHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  emitKanbanEvent = (event: KanbanEvent) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.KANBAN_EVENT, event);
    }
  };

  ipcMain.handle(IPC_CHANNELS.KANBAN_LIST, async () => {
    return { success: true, data: listKanbanTasks() };
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_GET, async (_event, id: string) => {
    const task = getKanbanTask(id);
    if (!task) return { success: false, error: 'Task not found' };
    return { success: true, data: task };
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_IMPORT, async (_event, input: ImportTaskInput) => {
    try {
      const task = importKanbanTask(input);
      emitKanbanEvent({ type: 'task-created', task });
      debugLog('[Kanban] Imported task', task.clickupCustomId || task.clickupTaskId);
      return { success: true, data: task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import task',
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_CREATE_LOCAL, async (_event, input: CreateLocalTaskInput) => {
    try {
      if (!input?.name?.trim()) {
        return { success: false, error: 'Task name is required' };
      }
      if (!input?.projectPath) {
        return { success: false, error: 'Project path is required' };
      }
      const task = createLocalKanbanTask(input);
      emitKanbanEvent({ type: 'task-created', task });
      debugLog('[Kanban] Created local task', task.id);
      return { success: true, data: task };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create local task',
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.KANBAN_UPDATE,
    async (_event, id: string, patch: Partial<KanbanTask>) => {
      const next = updateKanbanTask(id, patch);
      if (!next) return { success: false, error: 'Task not found' };
      emitKanbanEvent({ type: 'task-updated', task: next });
      return { success: true, data: next };
    },
  );

  ipcMain.handle(IPC_CHANNELS.KANBAN_DELETE, async (_event, id: string) => {
    const ok = deleteKanbanTask(id);
    if (!ok) return { success: false, error: 'Task not found' };
    emitKanbanEvent({ type: 'task-deleted', id });
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_DAILY_COST, async () => {
    try {
      const breakdown = computeDailyCostBreakdown(listKanbanTasks());
      return { success: true, data: breakdown };
    } catch (error) {
      debugError('[Kanban] Daily cost aggregation failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to compute daily cost',
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.KANBAN_REFRESH_CLICKUP, async () => {
    try {
      const tasks = await refreshClickupSnapshots();
      return { success: true, data: tasks };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to refresh',
      };
    }
  });
}

/** Also expose direct update (for orchestrator) that emits events */
export function broadcastKanbanTaskUpdate(patchId: string, patch: Partial<KanbanTask>): KanbanTask | null {
  const next = updateKanbanTask(patchId, patch);
  if (next) emitKanbanEvent({ type: 'task-updated', task: next });
  return next;
}

// Re-export status helper
export type { KanbanTaskStatus };
