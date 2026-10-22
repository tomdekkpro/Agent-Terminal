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
      // Backfill useWorktree (added v1.23.5) — every existing record was
      // created in worktree-only mode, so default to true.
      for (const t of tasks) {
        if (typeof t.useWorktree !== 'boolean') t.useWorktree = true;
      }
      // v1.25: auto-fix became strict per-task opt-in (default off). Drop the
      // old tri-state autoFixOverride — all tasks reset to off.
      for (const t of tasks) {
        delete (t as unknown as Record<string, unknown>).autoFixOverride;
      }
      // Auto Code refactor: rename the per-task auto-fix fields/values to their
      // auto-code counterparts on records persisted before the rename.
      for (const t of tasks) {
        const rec = t as unknown as Record<string, unknown>;
        if (rec.autoCodeState === undefined && rec.autoFixState !== undefined) {
          const v = rec.autoFixState;
          rec.autoCodeState = v === 'fixing' ? 'coding'
            : v === 'awaiting-qc' ? 'awaiting-review'
            : v;
          delete rec.autoFixState;
        }
        if (rec.autoCodeEnabled === undefined && rec.autoFixEnabled !== undefined) {
          rec.autoCodeEnabled = rec.autoFixEnabled;
          delete rec.autoFixEnabled;
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
  clickupReleaseVersion?: string;
  clickupUpdatedAt?: string;
  projectPath: string;
  projectId?: string;
  kanbanStatus?: KanbanTaskStatus;
  /** Branch to fork the task's worktree from. Persisted on the KanbanTask
   *  and used as the merge/PR target. Empty/undefined falls back to origin/HEAD. */
  baseBranch?: string;
  /** When false, no worktree is created; the agent runs on the project's
   *  current branch. Undefined/true preserves the worktree default. */
  useWorktree?: boolean;
}

export function importKanbanTask(input: ImportTaskInput): KanbanTask {
  const existing = getKanbanTaskByClickup(input.clickupTaskId);
  if (existing) {
    // Refresh ClickUp snapshot fields but preserve local state
    const patch: Partial<KanbanTask> = {
      clickupCustomId: input.clickupCustomId,
      clickupName: input.clickupName,
      clickupStatus: input.clickupStatus,
      clickupStatusColor: input.clickupStatusColor,
      clickupUrl: input.clickupUrl,
      clickupAssignees: input.clickupAssignees,
      clickupPriority: input.clickupPriority,
      clickupTags: input.clickupTags,
      clickupReleaseVersion: input.clickupReleaseVersion,
      clickupUpdatedAt: input.clickupUpdatedAt,
      projectPath: input.projectPath || existing.projectPath,
      projectId: input.projectId ?? existing.projectId,
    };
    // Re-import via the Import modal explicitly passes useWorktree; honor it so
    // toggling Worktree ↔ Current branch on an already-tracked task actually
    // updates the record. Background auto-imports (terminal restore, etc.)
    // leave it undefined and preserve the existing choice.
    if (input.useWorktree !== undefined) patch.useWorktree = input.useWorktree;
    if (input.baseBranch !== undefined) patch.baseBranch = input.baseBranch;
    return updateKanbanTask(existing.id, patch)!;
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
    clickupReleaseVersion: input.clickupReleaseVersion,
    clickupUpdatedAt: input.clickupUpdatedAt,
    projectPath: input.projectPath,
    projectId: input.projectId,
    kanbanStatus: input.kanbanStatus || 'todo',
    baseBranch: input.baseBranch || undefined,
    // Default to current branch ("normal"); a worktree is opt-in per launch
    // via the Start button (which persists useWorktree=true when chosen).
    useWorktree: input.useWorktree === true ? true : false,
    orderIndex: nextOrderIndex(data.tasks),
    autoCodeState: 'idle',
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
  /** Branch to fork the task's worktree from. Persisted on the KanbanTask
   *  and used as the merge/PR target. Empty/undefined falls back to origin/HEAD. */
  baseBranch?: string;
  /** When false, no worktree is created; the agent runs on the project's
   *  current branch. Undefined/true preserves the worktree default. */
  useWorktree?: boolean;
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
    baseBranch: input.baseBranch || undefined,
    // Default to current branch ("normal"); a worktree is opt-in per launch
    // via the Start button (which persists useWorktree=true when chosen).
    useWorktree: input.useWorktree === true ? true : false,
    orderIndex: nextOrderIndex(data.tasks),
    autoCodeState: 'idle',
    iterationCount: 0,
    lastSeenFailureCommentId: null,
    createdAt: now,
    updatedAt: now,
  };

  data.tasks.push(task);
  scheduleSave();
  return task;
}

export interface LinkLocalToClickupInput {
  /** Local KanbanTask id to convert. Must currently have provider==='local'. */
  localId: string;
  /** Snapshot fields from the ClickUp task the user picked. */
  clickupTaskId: string;
  clickupCustomId?: string;
  clickupName: string;
  clickupStatus: string;
  clickupStatusColor?: string;
  clickupUrl: string;
  clickupAssignees?: KanbanTask['clickupAssignees'];
  clickupPriority?: KanbanTask['clickupPriority'];
  clickupTags?: KanbanTask['clickupTags'];
  clickupReleaseVersion?: string;
  clickupUpdatedAt?: string;
}

/** Convert a local-only kanban task into a ClickUp-linked one. Preserves
 *  the local workflow state (kanbanStatus, worktree info, session id, auto-code
 *  iteration count, etc.) so the existing terminal/worktree keeps working. */
export function linkKanbanTaskToClickup(input: LinkLocalToClickupInput): KanbanTask | null {
  const data = load();
  const idx = data.tasks.findIndex((t) => t.id === input.localId);
  if (idx < 0) return null;
  const existing = data.tasks[idx];
  if (existing.provider === 'clickup') {
    // Already linked — no-op rather than clobbering snapshot fields.
    return existing;
  }
  // Refuse the link if the chosen ClickUp task is already on the board
  // — silently merging two records would lose history.
  const conflict = data.tasks.find(
    (t) => t.id !== input.localId && t.clickupTaskId === input.clickupTaskId,
  );
  if (conflict) {
    throw new Error(
      `ClickUp task ${input.clickupCustomId || input.clickupTaskId} is already imported as "${conflict.clickupName}". Delete the existing record first if you want to link this local task instead.`,
    );
  }
  const updated: KanbanTask = {
    ...existing,
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
    clickupReleaseVersion: input.clickupReleaseVersion,
    clickupUpdatedAt: input.clickupUpdatedAt,
    // Description was the local task's prompt body — drop it now that the
    // ClickUp description is the source of truth (fetched live via the API).
    description: undefined,
    updatedAt: new Date().toISOString(),
  };
  data.tasks[idx] = updated;
  scheduleSave();
  return updated;
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
