import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { KanbanTask, KanbanTaskStatus } from '../../shared/types';
import { debugLog, debugError } from '../../shared/utils';

const STORE_DIR = join(app.getPath('userData'), 'store');
const STORE_FILE = join(STORE_DIR, 'kanban-tasks.json');

interface StoreData {
  tasks: KanbanTask[];
}

let cached: StoreData | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true });
  }
}

function load(): StoreData {
  if (cached) return cached;
  try {
    if (existsSync(STORE_FILE)) {
      const raw = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
      cached = { tasks: Array.isArray(raw.tasks) ? raw.tasks : [] };
      debugLog('[KanbanStore] Loaded', cached.tasks.length, 'kanban task(s)');
      return cached;
    }
  } catch (err) {
    debugError('[KanbanStore] Failed to load:', err);
  }
  cached = { tasks: [] };
  return cached;
}

function write(data: StoreData): void {
  try {
    ensureDir();
    writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    debugError('[KanbanStore] Failed to save:', err);
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (cached) write(cached);
  }, 300);
}

export function listKanbanTasks(): KanbanTask[] {
  return load().tasks.slice();
}

export function getKanbanTask(id: string): KanbanTask | null {
  return load().tasks.find((t) => t.id === id) || null;
}

export function getKanbanTaskByClickup(clickupTaskId: string): KanbanTask | null {
  return load().tasks.find((t) => t.clickupTaskId === clickupTaskId) || null;
}

export interface ImportTaskInput {
  clickupTaskId: string;
  clickupCustomId?: string;
  clickupName: string;
  clickupStatus: string;
  clickupStatusColor?: string;
  clickupUrl: string;
  clickupAssignees?: KanbanTask['clickupAssignees'];
  clickupPriority?: KanbanTask['clickupPriority'];
  clickupTags?: KanbanTask['clickupTags'];
  clickupUpdatedAt?: string;
  projectPath: string;
  projectId?: string;
  kanbanStatus?: KanbanTaskStatus;
}

export function importKanbanTask(input: ImportTaskInput): KanbanTask {
  const existing = getKanbanTaskByClickup(input.clickupTaskId);
  if (existing) {
    // Refresh ClickUp snapshot fields but preserve local state
    return updateKanbanTask(existing.id, {
      clickupCustomId: input.clickupCustomId,
      clickupName: input.clickupName,
      clickupStatus: input.clickupStatus,
      clickupStatusColor: input.clickupStatusColor,
      clickupUrl: input.clickupUrl,
      clickupAssignees: input.clickupAssignees,
      clickupPriority: input.clickupPriority,
      clickupTags: input.clickupTags,
      clickupUpdatedAt: input.clickupUpdatedAt,
      projectPath: input.projectPath || existing.projectPath,
      projectId: input.projectId ?? existing.projectId,
    })!;
  }

  const now = new Date().toISOString();
  const task: KanbanTask = {
    id: randomUUID(),
    clickupTaskId: input.clickupTaskId,
    clickupCustomId: input.clickupCustomId,
    clickupName: input.clickupName,
    clickupStatus: input.clickupStatus,
    clickupStatusColor: input.clickupStatusColor,
    clickupUrl: input.clickupUrl,
    clickupAssignees: input.clickupAssignees,
    clickupPriority: input.clickupPriority,
    clickupTags: input.clickupTags,
    clickupUpdatedAt: input.clickupUpdatedAt,
    projectPath: input.projectPath,
    projectId: input.projectId,
    kanbanStatus: input.kanbanStatus || 'todo',
    autoFixState: 'idle',
    iterationCount: 0,
    lastSeenFailureCommentId: null,
    createdAt: now,
    updatedAt: now,
  };

  const data = load();
  data.tasks.push(task);
  scheduleSave();
  return task;
}

export function updateKanbanTask(id: string, patch: Partial<KanbanTask>): KanbanTask | null {
  const data = load();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const updated: KanbanTask = {
    ...data.tasks[idx],
    ...patch,
    id: data.tasks[idx].id,
    clickupTaskId: data.tasks[idx].clickupTaskId,
    createdAt: data.tasks[idx].createdAt,
    updatedAt: new Date().toISOString(),
  };
  data.tasks[idx] = updated;
  scheduleSave();
  return updated;
}

export function deleteKanbanTask(id: string): boolean {
  const data = load();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  data.tasks.splice(idx, 1);
  scheduleSave();
  return true;
}

/** Flush any pending writes synchronously — use in app quit handlers */
export function flushKanbanTasks(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (cached) write(cached);
}
