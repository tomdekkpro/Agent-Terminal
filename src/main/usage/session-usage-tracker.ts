/**
 * Watches a Claude Code session and its sub-agent JSONLs, emitting per-terminal
 * cumulative usage (tokens + cost) to the renderer.
 *
 * Layout on disk:
 *   ~/.claude/projects/<encoded>/<sessionId>.jsonl              ← parent session
 *   ~/.claude/projects/<encoded>/<sessionId>/subagents/*.jsonl  ← Task / Agent
 *                                                                   tool spawns
 * Sub-agents (Explore, Task tool, etc.) have their own conversation files —
 * if we only read the parent JSONL, sub-agent token usage is invisible. So
 * we discover all `.jsonl` files under `<sessionId>/` recursively and track
 * each one's byte offset independently. New sub-agent files appearing
 * mid-session are picked up on the next poll.
 *
 * Polling instead of fs.watch: Claude appends while we read and Windows
 * fs.watch is unreliable for append-only logs. 3s poll is cheap — we only
 * read bytes appended since last poll — and good enough for a cost UI.
 */

import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { computeCost, type RawUsage } from './session-cost';
import { debugLog } from '../../shared/utils';

const POLL_INTERVAL_MS = 3000;

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
  model?: string;
}

interface FileWatch {
  path: string;
  byteOffset: number;
  partialLine: string;
}

interface Watcher {
  terminalId: string;
  /** Parent session JSONL — used both as a file to read and to derive the
   *  sibling directory (`<dirname>/<sessionId>/`) where sub-agent files live. */
  sessionFilePath: string;
  /** `<projectDir>/<sessionId>` — root of recursive sub-agent discovery. */
  subagentRoot: string;
  /** Tracked file paths → per-file watch state. New files (e.g. spawned
   *  sub-agents) get added on each poll. */
  files: Map<string, FileWatch>;
  accumulated: UsageAccumulator;
  timer: NodeJS.Timeout;
}

function emptyAccumulator(): UsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
  };
}

/** Recursively list all .jsonl files under a directory. Returns [] if the
 *  directory doesn't exist (no sub-agents have spawned yet). */
function listJsonlRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listJsonlRecursive(full));
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

class SessionUsageTracker {
  private watchers = new Map<string, Watcher>();
  private getWindow: () => BrowserWindow | null = () => null;

  setWindowGetter(getter: () => BrowserWindow | null) {
    this.getWindow = getter;
  }

  start(terminalId: string, sessionFilePath: string): void {
    const existing = this.watchers.get(terminalId);
    if (existing && existing.sessionFilePath === sessionFilePath) return;
    if (existing) this.stop(terminalId);

    // Sub-agent JSONLs live in `<projectDir>/<sessionId>/`, sibling to the
    // parent file. Strip `.jsonl` from the filename to get the dir name.
    const projectDir = dirname(sessionFilePath);
    const sessionId = basename(sessionFilePath).replace(/\.jsonl$/, '');
    const subagentRoot = join(projectDir, sessionId);

    const files = new Map<string, FileWatch>();
    files.set(sessionFilePath, { path: sessionFilePath, byteOffset: 0, partialLine: '' });

    const watcher: Watcher = {
      terminalId,
      sessionFilePath,
      subagentRoot,
      files,
      accumulated: emptyAccumulator(),
      timer: setInterval(() => this.poll(terminalId), POLL_INTERVAL_MS),
    };
    this.watchers.set(terminalId, watcher);
    debugLog('[SessionUsage] Watching:', terminalId, sessionFilePath);
    this.poll(terminalId);
  }

  stop(terminalId: string): void {
    const w = this.watchers.get(terminalId);
    if (!w) return;
    clearInterval(w.timer);
    this.watchers.delete(terminalId);
    debugLog('[SessionUsage] Stopped:', terminalId);
  }

  stopAll(): void {
    for (const id of Array.from(this.watchers.keys())) this.stop(id);
  }

  private poll(terminalId: string): void {
    const w = this.watchers.get(terminalId);
    if (!w) return;

    // Discover new sub-agent JSONLs that appeared since the last poll. They
    // get added at offset 0 so the next read consumes them from the start.
    for (const path of listJsonlRecursive(w.subagentRoot)) {
      if (!w.files.has(path)) {
        w.files.set(path, { path, byteOffset: 0, partialLine: '' });
      }
    }

    let truncated = false;
    for (const fw of w.files.values()) {
      if (this.processFile(w, fw)) truncated = true;
    }

    if (truncated) {
      // Some file shrank — accumulator is now wrong (it was summed over
      // bytes that no longer exist). Reset everything and re-scan from 0
      // on the next tick. Re-process synchronously here.
      w.accumulated = emptyAccumulator();
      for (const fw of w.files.values()) {
        fw.byteOffset = 0;
        fw.partialLine = '';
      }
      for (const fw of w.files.values()) {
        this.processFile(w, fw);
      }
    }

    this.emit(w);
  }

  /** Read the tail of one file, append usage to the accumulator. Returns
   *  true if the file was truncated (caller does a full reset). */
  private processFile(w: Watcher, fw: FileWatch): boolean {
    if (!existsSync(fw.path)) return false;
    let stat;
    try {
      stat = statSync(fw.path);
    } catch {
      return false;
    }

    if (stat.size === fw.byteOffset) return false;
    if (stat.size < fw.byteOffset) return true; // truncation flag

    let buf: Buffer;
    try {
      const fd = openSync(fw.path, 'r');
      const length = stat.size - fw.byteOffset;
      buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, fw.byteOffset);
      closeSync(fd);
    } catch {
      return false;
    }

    fw.byteOffset = stat.size;
    const text = fw.partialLine + buf.toString('utf-8');
    const lines = text.split('\n');
    fw.partialLine = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        this.processEntry(w, entry);
      } catch {
        /* malformed JSON line — likely a torn write, skip */
      }
    }
    return false;
  }

  private processEntry(w: Watcher, entry: any): void {
    if (entry?.type !== 'assistant') return;
    const msg = entry.message;
    const usage: RawUsage | undefined = msg?.usage;
    if (!usage) return;

    const model: string | undefined = msg.model;
    if (model) w.accumulated.model = model;

    w.accumulated.inputTokens += usage.input_tokens || 0;
    w.accumulated.outputTokens += usage.output_tokens || 0;
    w.accumulated.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
    w.accumulated.cacheReadTokens += usage.cache_read_input_tokens || 0;
    w.accumulated.cost += computeCost(usage, model);
  }

  private emit(w: Watcher): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC_CHANNELS.TERMINAL_USAGE, {
      terminalId: w.terminalId,
      model: w.accumulated.model,
      inputTokens: w.accumulated.inputTokens,
      outputTokens: w.accumulated.outputTokens,
      cacheCreationTokens: w.accumulated.cacheCreationTokens,
      cacheReadTokens: w.accumulated.cacheReadTokens,
      cost: w.accumulated.cost,
    });
  }
}

export const sessionUsageTracker = new SessionUsageTracker();
