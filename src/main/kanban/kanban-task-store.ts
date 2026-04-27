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
      const tasks: KanbanTask[] = Array.isArray(raw.tasks) ? raw.tasks : [];
      // Backfill provider on records saved before v1.17.0 — every persisted
      // task pre-dates local creation, so they're all clickup-sourced.
      for (const t of tasks) {
        if (!t.provider) t.provider = 'clickup';
      }
      // Backfill orderIndex (added v1.21.x) — derive from createdAt so the
      // existing array order is preserved on first run. Subsequent renders
      // sort by orderIndex.
      for (const t of tasks) {
        if (typeof t.orderIndex !== 'number') {
          t.orderIndex = Date.parse(t.createdAt || '') || Date.now();
        }
      }
      cached = { tasks };
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
  const data = load();
  const task: KanbanTask = {
    id: randomUUID(),
    provider: 'clickup',
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
    orderIndex: nextOrderIndex(data.tasks),
    autoFixState: 'idle',
    iterationCount: 0,
    lastSeenFailureCommentId: null,
    createdAt: now,
    updatedAt: now,
  };

  data.tasks.push(task);
  scheduleSave();
  return task;
}

/** Allocate the next ordering key — strictly larger than any existing,
 *  so the new task lands at the bottom regardless of which column it's
 *  dropped into. Date.now() is monotonic-enough across normal usage. */
function nextOrderIndex(tasks: KanbanTask[]): number {
  let max = 0;
  for (const t of tasks) {
    if (typeof t.orderIndex === 'number' && t.orderIndex > max) max = t.orderIndex;
  }
  return Math.max(max + 1, Date.now());
}

export interface CreateLocalTaskInput {
  name: string;
  description?: string;
  projectPath: string;
  projectId?: string;
  kanbanStatus?: KanbanTaskStatus;
}

/** Create a local-only Kanban task (no ClickUp link). The orchestrator
 *  ignores `provider==='local'` records, and ClickUp-sync flows skip them. */
export function createLocalKanbanTask(input: CreateLocalTaskInput): KanbanTask {
  const now = new Date().toISOString();
  const id = randomUUID();
  const data = load();
  const task: KanbanTask = {
    id,
    provider: 'local',
    // Synthesize a stable id so kanbanList -> task lookups still work. The
    // `local:` prefix prevents collision with real ClickUp ids.
    clickupTaskId: `local:${id}`,
    clickupCustomId: undefined,
    clickupName: input.name,
    clickupStatus: 'Local',
    clickupStatusColor: '#94a3b8',
    clickupUrl: '',
    clickupAssignees: [],
    description: input.description,
    projectPath: input.projectPath,
    projectId: input.projectId,
    kanbanStatus: input.kanbanStatus || 'todo',
    orderIndex: nextOrderIndex(data.tasks),
    autoFixState: 'idle',
    iterationCount: 0,
    lastSeenFailureCommentId: null,
    createdAt: now,
    updatedAt: now,
  };

  data.tasks.push(task);
  scheduleSave();
  return task;
}

export function updateKanbanTask(id: string, patch: Partial<KanbanTask>): KanbanTask | null {
  const data = load();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  const existing = data.tasks[idx];

  // When the user moves a task to a different column (drag/drop), bump
  // orderIndex so it lands at the bottom of the destination — unless the
  // caller explicitly set orderIndex itself (e.g., a future drag-to-reorder
  // feature). Status changes that don't move column (same value) don't bump.
  const movedColumn = patch.kanbanStatus && patch.kanbanStatus !== existing.kanbanStatus;
  const explicitOrder = Object.prototype.hasOwnProperty.call(patch, 'orderIndex');
  const finalOrderIndex = explicitOrder
    ? patch.orderIndex
    : movedColumn
      ? nextOrderIndex(data.tasks)
      : existing.orderIndex;

  const updated: KanbanTask = {
    ...existing,
    ...patch,
    orderIndex: finalOrderIndex,
    id: existing.id,
    clickupTaskId: existing.clickupTaskId,
    createdAt: existing.createdAt,
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
