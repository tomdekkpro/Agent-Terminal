import type { BrowserWindow } from 'electron';
import { app } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugError } from '../../shared/utils';
import type { ActivityEvent } from '../../shared/types';
import { maybeNotify } from './notifier';

const STORE_DIR = join(app.getPath('userData'), 'store');
const STORE_FILE = join(STORE_DIR, 'activity-feed.json');

/** Ring-buffer cap. The feed is a recent timeline, not an audit log. */
const MAX_EVENTS = 500;

let cache: ActivityEvent[] | null = null;
let seq = 0;
let getWindow: (() => BrowserWindow | null) | null = null;

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

function load(): ActivityEvent[] {
  if (cache) return cache;
  try {
    if (existsSync(STORE_FILE)) {
      const raw = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
      if (Array.isArray(raw)) {
        cache = raw as ActivityEvent[];
        return cache;
      }
    }
  } catch (err) {
    debugError('[Activity] Failed to load feed:', err);
  }
  cache = [];
  return cache;
}

function save(): void {
  try {
    ensureDir();
    writeFileSync(STORE_FILE, JSON.stringify(cache ?? [], null, 2));
  } catch (err) {
    debugError('[Activity] Failed to persist feed:', err);
  }
}

function push(channelPayload: unknown): void {
  const win = getWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, channelPayload);
  }
}

export function initActivity(getWin: () => BrowserWindow | null): void {
  getWindow = getWin;
}

/** Record an activity event: persist it, push it to the renderer feed, and
 *  fire an OS notification if the kind/settings warrant. Returns the stored
 *  event (with generated id/timestamp). Never throws — activity logging must
 *  not break the subsystem that emitted it. */
export function recordActivity(
  input: Omit<ActivityEvent, 'id' | 'at' | 'read'> & { at?: string },
): ActivityEvent | null {
  try {
    const events = load();
    const ev: ActivityEvent = {
      id: `act-${Date.now()}-${seq++}`,
      at: input.at || new Date().toISOString(),
      read: false,
      ...input,
    };
    events.unshift(ev);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    cache = events;
    save();
    push({ type: 'item-added', item: ev });
    maybeNotify(ev);
    return ev;
  } catch (err) {
    debugError('[Activity] recordActivity failed:', err);
    return null;
  }
}

export function listActivity(): ActivityEvent[] {
  return load();
}

export function markActivityRead(id: string): void {
  const events = load();
  const item = events.find((e) => e.id === id);
  if (item && !item.read) {
    item.read = true;
    save();
    push({ type: 'item-read', id });
  }
}

export function markAllActivityRead(): void {
  const events = load();
  let changed = false;
  for (const e of events) {
    if (!e.read) { e.read = true; changed = true; }
  }
  if (changed) {
    save();
    push({ type: 'all-read' });
  }
}

export function clearActivity(): void {
  cache = [];
  save();
  push({ type: 'cleared' });
}
