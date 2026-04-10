import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
