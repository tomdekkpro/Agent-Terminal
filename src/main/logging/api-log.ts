/**
 * Append-only log of outbound task-manager API calls.
 *
 * Exists because a failing request used to surface as bare
 * `ClickUp API error: 404 Not Found` — no endpoint, no query, no response body,
 * so there was no way to tell WHICH call failed. Every request now records what
 * was sent, what came back, how long it took and what the rate-limit headers
 * said, so a bad query can be identified after the fact rather than reproduced.
 *
 * Deliberately imports nothing from electron: the file destination is injected
 * by the main process at startup (`setApiLogFile`). That keeps the providers
 * that call this free of an electron dependency, so they stay unit-testable in
 * plain node.
 *
 * Writes are buffered and flushed on a timer — an API call must not pay for a
 * synchronous disk write, and a burst of 20 requests must not become 20 writes.
 */
import { appendFile, mkdir, rename, stat } from 'fs/promises';
import { dirname } from 'path';

export type ApiLogEntry = {
  /** Which integration issued the call, e.g. 'ClickUp'. */
  provider: string;
  method: string;
  /** Path plus query string, exactly as sent. */
  endpoint: string;
  /** HTTP status; absent when the request never got a response. */
  status?: number;
  durationMs: number;
  /** 0 for the first try; >0 means this was a retry after a 429. */
  attempt?: number;
  /** Whether the request went out on the background or interactive lane. */
  background?: boolean;
  /** X-RateLimit-Remaining as reported by the response. */
  rateRemaining?: string | null;
  /** Set when the call failed — includes the provider's own error body. */
  error?: string;
};

/** Rotate at this size, keeping one previous file. Roughly a day of traffic. */
const MAX_BYTES = 2 * 1024 * 1024;
const FLUSH_MS = 2000;
/** Hard cap so a runaway loop cannot grow the buffer without bound. */
const MAX_BUFFERED_LINES = 2000;

let logPath: string | null = null;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let rotating = false;

/** Point the log at a file and start flushing. Called once, from main. */
export function setApiLogFile(filePath: string): void {
  logPath = filePath;
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flush();
    }, FLUSH_MS);
    // Never hold the process open just to flush a log.
    flushTimer.unref?.();
  }
}

/** Where the log is being written, for surfacing in the UI. */
export function getApiLogFile(): string | null {
  return logPath;
}

function formatLine(e: ApiLogEntry): string {
  const parts = [
    new Date().toISOString(),
    e.provider,
    e.method,
    e.status !== undefined ? String(e.status) : 'ERR',
    `${e.durationMs}ms`,
  ];
  if (e.background !== undefined) parts.push(e.background ? 'bg' : 'ui');
  if (e.attempt) parts.push(`retry#${e.attempt}`);
  if (e.rateRemaining !== undefined && e.rateRemaining !== null) {
    parts.push(`left=${e.rateRemaining}`);
  }
  parts.push(e.endpoint);
  if (e.error) parts.push(`:: ${e.error}`);
  return parts.join(' ');
}

/**
 * Record one API call. Failures also go to stderr so they are visible without
 * opening the file; successes stay file-only to keep the console usable.
 */
export function logApiRequest(entry: ApiLogEntry): void {
  const line = formatLine(entry);
  if (entry.error || (entry.status !== undefined && entry.status >= 400)) {
    // eslint-disable-next-line no-console
    console.error(`[api] ${line}`);
  }
  if (buffer.length < MAX_BUFFERED_LINES) buffer.push(line);
}

/** Write out whatever is buffered. Failures are swallowed — logging must never
 *  break the thing it is observing. */
export async function flush(): Promise<void> {
  if (!logPath || buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${lines.join('\n')}\n`, 'utf-8');
    await rotateIfNeeded();
  } catch {
    /* dropped: a log write failing must not surface anywhere */
  }
}

async function rotateIfNeeded(): Promise<void> {
  if (!logPath || rotating) return;
  rotating = true;
  try {
    const info = await stat(logPath);
    if (info.size > MAX_BYTES) await rename(logPath, `${logPath}.1`);
  } catch {
    /* nothing to rotate, or the rename lost a race — either is fine */
  } finally {
    rotating = false;
  }
}
