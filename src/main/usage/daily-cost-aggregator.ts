/**
 * Aggregates per-day Claude API spend across every imported KanbanTask by
 * reading their session JSONL files and bucketing each assistant entry's
 * cost into the local-TZ date of its `timestamp`.
 *
 * Layout on disk (same as session-usage-tracker):
 *   ~/.claude/projects/<encoded>/<sessionId>.jsonl              ← parent session
 *   ~/.claude/projects/<encoded>/<sessionId>/subagents/*.jsonl  ← sub-agent spawns
 *
 * Per-file results are cached by file size — JSONL files only grow during
 * normal operation, so a size match means the bucketed totals are still
 * valid. A size change triggers a full re-parse of just that file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import type { KanbanTask, KanbanDailyCostBreakdown } from '../../shared/types';
import { computeCost, type RawUsage } from './session-cost';
import { debugError } from '../../shared/utils';

/** Mirrors `terminal-manager.ts` — Claude encodes project paths by replacing
 *  `:`, `/`, `\`, `.` with `-`. Worktrees nest under `.claude/worktrees/<id>`
 *  so the session is stored under the worktree's encoded path, not the
 *  project root. The KanbanTask records its `agentCwd` exactly so we can
 *  reproduce the encoding here. */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[:/\\.]/g, '-');
}

function getClaudeProjectDir(cwd: string): string {
  return join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd));
}

/** YYYY-MM-DD in local TZ. `en-CA` locale gives ISO-like ordering. */
function localDateKey(d: Date): string {
  // Avoid toLocaleDateString locale quirks — build it manually.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface FileBuckets {
  size: number;
  byDay: Map<string, number>;
}

const fileCache = new Map<string, FileBuckets>();

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

function bucketFile(path: string): Map<string, number> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return new Map();
  }
  const cached = fileCache.get(path);
  if (cached && cached.size === stat.size) {
    return cached.byDay;
  }

  const byDay = new Map<string, number>();
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    debugError('[DailyCost] Failed to read', path, err);
    return byDay;
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') continue;
    const usage: RawUsage | undefined = entry.message?.usage;
    if (!usage) continue;
    const ts = entry.timestamp;
    if (!ts) continue;
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) continue;

    const key = localDateKey(date);
    const cost = computeCost(usage, entry.message?.model);
    byDay.set(key, (byDay.get(key) || 0) + cost);
  }

  fileCache.set(path, { size: stat.size, byDay });
  return byDay;
}

/** Walk every imported task's parent + sub-agent JSONLs, summing cost into
 *  per-date buckets. Tasks without a session id (e.g. local tasks that
 *  haven't been started yet) contribute nothing. */
export function computeDailyCostBreakdown(tasks: KanbanTask[]): KanbanDailyCostBreakdown {
  const seenFiles = new Set<string>();
  const totals = new Map<string, number>();

  for (const task of tasks) {
    if (!task.agentSessionId) continue;

    // The session JSONL lives under Claude's encoded directory for the cwd
    // Claude was actually invoked from. For `claude --worktree <id>`, Claude
    // cd's into the worktree itself before writing — so the encoded dir is
    // the worktree path, not the PTY cwd (which we record as `agentCwd` and
    // is usually the project root). Try every plausible candidate and union
    // the results; deduped via seenFiles, so the same JSONL only counts once.
    const candidateCwds: string[] = [];
    const pushUnique = (c: string | undefined | null) => {
      if (c && !candidateCwds.includes(c)) candidateCwds.push(c);
    };
    pushUnique(task.worktreePath);
    pushUnique(task.agentCwd);
    pushUnique(task.projectPath);

    for (const cwd of candidateCwds) {
      const projectDir = getClaudeProjectDir(cwd);
      const parentJsonl = join(projectDir, `${task.agentSessionId}.jsonl`);
      const subagentRoot = join(projectDir, task.agentSessionId);

      const fileList = [parentJsonl, ...listJsonlRecursive(subagentRoot)];
      for (const file of fileList) {
        if (seenFiles.has(file)) continue;
        if (!existsSync(file)) continue; // skip the wrong candidate dirs cheaply
        seenFiles.add(file);
        const bucket = bucketFile(file);
        for (const [date, cost] of bucket) {
          totals.set(date, (totals.get(date) || 0) + cost);
        }
      }
    }
  }

  // Build the rolling 7-day window (oldest → newest), inserting zero-cost
  // entries so the UI can render a stable shape even on quiet days.
  const today = new Date();
  const byDay: { date: string; cost: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = localDateKey(d);
    byDay.push({ date: key, cost: totals.get(key) || 0 });
  }

  const todayKey = localDateKey(today);
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  const yesterdayKey = localDateKey(yest);

  let total = 0;
  for (const c of totals.values()) total += c;

  return {
    byDay,
    today: totals.get(todayKey) || 0,
    yesterday: totals.get(yesterdayKey) || 0,
    week: byDay.reduce((s, e) => s + e.cost, 0),
    total,
  };
}
