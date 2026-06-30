import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { DashboardNotice, NoticeSource } from '../../shared/types';
import { debugLog, debugError } from '../../shared/utils';

const STORE_DIR = join(app.getPath('userData'), 'store');
const STORE_FILE = join(STORE_DIR, 'dashboard-notices.json');

interface StoreData {
  notices: DashboardNotice[];
}

let cached: StoreData | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

function load(): StoreData {
  if (cached) return cached;
  try {
    if (existsSync(STORE_FILE)) {
      const raw = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
      const notices: DashboardNotice[] = Array.isArray(raw.notices) ? raw.notices : [];
      cached = { notices };
      debugLog('[NoticeStore] Loaded', notices.length, 'notice(s)');
      return cached;
    }
  } catch (err) {
    debugError('[NoticeStore] Failed to load:', err);
  }
  cached = { notices: [] };
  return cached;
}

function write(data: StoreData): void {
  try {
    ensureDir();
    writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    debugError('[NoticeStore] Failed to save:', err);
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (cached) write(cached);
  }, 300);
}

export function listNotices(): DashboardNotice[] {
  return load().notices.slice();
}

export function getNotice(id: string): DashboardNotice | null {
  return load().notices.find((n) => n.id === id) || null;
}

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

/** Create a new notice or update an existing one (when `id` is provided). */
export function saveNotice(input: SaveNoticeInput): DashboardNotice {
  const data = load();
  const now = new Date().toISOString();

  if (input.id) {
    const idx = data.notices.findIndex((n) => n.id === input.id);
    if (idx >= 0) {
      const existing = data.notices[idx];
      const updated: DashboardNotice = {
        ...existing,
        title: input.title ?? existing.title,
        prompt: input.prompt ?? existing.prompt,
        scheduleTime: input.scheduleTime ?? existing.scheduleTime,
        enabled: input.enabled ?? existing.enabled,
        projectPath: input.projectPath ?? existing.projectPath,
        listId: input.listId ?? existing.listId,
        sources: input.sources ?? existing.sources,
        urls: input.urls ?? existing.urls,
        updatedAt: now,
      };
      data.notices[idx] = updated;
      scheduleSave();
      return updated;
    }
  }

  const notice: DashboardNotice = {
    id: randomUUID(),
    title: input.title,
    prompt: input.prompt,
    scheduleTime: input.scheduleTime || '',
    enabled: input.enabled ?? true,
    projectPath: input.projectPath,
    listId: input.listId,
    sources: input.sources ?? ['clickup'],
    urls: input.urls,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
  };
  data.notices.push(notice);
  scheduleSave();
  return notice;
}

/** Patch run-state fields (used by the runner/scheduler). */
export function patchNotice(id: string, patch: Partial<DashboardNotice>): DashboardNotice | null {
  const data = load();
  const idx = data.notices.findIndex((n) => n.id === id);
  if (idx < 0) return null;
  const updated: DashboardNotice = {
    ...data.notices[idx],
    ...patch,
    id: data.notices[idx].id,
    createdAt: data.notices[idx].createdAt,
    updatedAt: new Date().toISOString(),
  };
  data.notices[idx] = updated;
  scheduleSave();
  return updated;
}

export function deleteNotice(id: string): boolean {
  const data = load();
  const idx = data.notices.findIndex((n) => n.id === id);
  if (idx < 0) return false;
  data.notices.splice(idx, 1);
  scheduleSave();
  return true;
}

/** Flush pending writes synchronously — use in app quit handlers. */
export function flushNotices(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (cached) write(cached);
}
