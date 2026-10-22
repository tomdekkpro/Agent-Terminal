import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Prefix that marks a board task with no counterpart in the task manager.
 *  Set by createLocalTask; see kanban-task-store. */
export const LOCAL_TASK_ID_PREFIX = 'local:';

/** True for a task that exists only on the local board. Sending one of these
 *  to ClickUp is always a wasted request that comes back 401/404, so every
 *  boundary that forwards a task id needs to check. */
export function isLocalTaskId(taskId: string | undefined | null): boolean {
  return !!taskId && taskId.startsWith(LOCAL_TASK_ID_PREFIX);
}

/** Parse a comma-separated list into a lowercased, trimmed Set (drops empties). */
export function csvToLowerSet(csv: string | undefined): Set<string> {
  return new Set((csv || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** Toggle a name in a comma-separated list (case-insensitive); returns the new CSV. */
export function toggleInCsv(csv: string | undefined, name: string): string {
  const set = csvToLowerSet(csv);
  const key = name.trim().toLowerCase();
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return Array.from(set).join(', ');
}

export function debugLog(...args: unknown[]): void {
  if (process.env.NODE_ENV === 'development') {
    console.log(...args);
  }
}

export function debugError(...args: unknown[]): void {
  console.error(...args);
}

/**
 * Split a time range into per-calendar-day segments at local midnight boundaries.
 * Returns one entry per day the range spans.
 */
export function splitTimeByDate(startMs: number, endMs: number): Array<{ startMs: number; durationMs: number }> {
  if (endMs <= startMs) return [];
  const entries: Array<{ startMs: number; durationMs: number }> = [];
  let current = startMs;

  while (current < endMs) {
    const d = new Date(current);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const segmentEnd = Math.min(nextMidnight, endMs);
    const durationMs = segmentEnd - current;
    if (durationMs > 0) {
      entries.push({ startMs: current, durationMs });
    }
    current = segmentEnd;
  }

  return entries;
}

/** Get the start of today (local midnight) as a unix timestamp */
export function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Get today's date string in YYYY-MM-DD format */
export function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Parse a timestamp that may be a unix-ms string (ClickUp's `date_created`),
 * a numeric ms value, or an ISO date string. Returns NaN when unparseable.
 */
export function parseTimestamp(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value;
  return Number(value) || Date.parse(value);
}

/** Compact "x ago" relative time. Empty string when the input can't be parsed. */
export function formatRelativeTime(value: string | number | undefined | null): string {
  const ts = parseTimestamp(value);
  if (!ts || Number.isNaN(ts)) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
