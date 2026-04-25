/**
 * Watches a Claude Code session JSONL file and emits per-terminal cumulative
 * usage (tokens + cost) to the renderer.
 *
 * Why polling instead of fs.watch: Claude appends lines while we're reading
 * and Windows fs.watch is unreliable for append-only logs. A 3-second poll is
 * cheap (only reads bytes appended since last poll) and good enough for a
 * cost-tracking UI.
 *
 * Usage source: every assistant message in the session JSONL has a `usage`
 * block with input/output tokens plus cache-creation/read counts (and the
 * 5m/1h ephemeral split). We sum across the file and price each turn at the
 * model's published rate.
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'fs';
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

interface Watcher {
  terminalId: string;
  sessionFilePath: string;
  /** Bytes already consumed from the file. We re-read only the tail. */
  byteOffset: number;
  /** Carry-over for a partial last line between polls. */
  partialLine: string;
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

class SessionUsageTracker {
  private watchers = new Map<string, Watcher>();
  private getWindow: () => BrowserWindow | null = () => null;

  setWindowGetter(getter: () => BrowserWindow | null) {
    this.getWindow = getter;
  }

  /**
   * Start watching a session JSONL for a terminal. If already watching the
   * same file, no-op. If the file path changed (e.g. session forked), the
   * previous watcher is reset.
   */
  start(terminalId: string, sessionFilePath: string): void {
    const existing = this.watchers.get(terminalId);
    if (existing && existing.sessionFilePath === sessionFilePath) return;
    if (existing) this.stop(terminalId);

    const watcher: Watcher = {
      terminalId,
      sessionFilePath,
      byteOffset: 0,
      partialLine: '',
      accumulated: emptyAccumulator(),
      timer: setInterval(() => this.poll(terminalId), POLL_INTERVAL_MS),
    };
    this.watchers.set(terminalId, watcher);
    debugLog('[SessionUsage] Watching:', terminalId, sessionFilePath);
    // Immediate first poll so the UI populates without a 3s delay
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
    if (!existsSync(w.sessionFilePath)) return;

    let stat;
    try {
      stat = statSync(w.sessionFilePath);
    } catch {
      return;
    }

    if (stat.size === w.byteOffset) return; // unchanged

    if (stat.size < w.byteOffset) {
      // File was truncated or replaced — restart from zero.
      w.byteOffset = 0;
      w.partialLine = '';
      w.accumulated = emptyAccumulator();
    }

    let buf: Buffer;
    try {
      const fd = openSync(w.sessionFilePath, 'r');
      const length = stat.size - w.byteOffset;
      buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, w.byteOffset);
      closeSync(fd);
    } catch {
      return;
    }

    w.byteOffset = stat.size;
    const text = w.partialLine + buf.toString('utf-8');

    // Split on newline; the last element may be a partial line that the
    // file is still being written to. Hold it for the next poll.
    const lines = text.split('\n');
    w.partialLine = lines.pop() ?? '';

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

    this.emit(w);
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
