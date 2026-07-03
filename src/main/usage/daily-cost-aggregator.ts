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
import type { KanbanTask, KanbanDailyCostBreakdown, ModelUsageSummary } from '../../shared/types';
import { computeCost, normalizeModelId, modelDisplayLabel, type RawUsage } from './session-cost';
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

/** Running totals for one (day, model) bucket. */
interface UsageTotals {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
}

/** day key → normalized model id → totals */
type DayModelBuckets = Map<string, Map<string, UsageTotals>>;

interface FileBuckets {
  size: number;
  byDay: DayModelBuckets;
}

const fileCache = new Map<string, FileBuckets>();

function addUsage(buckets: DayModelBuckets, day: string, model: string, usage: RawUsage, cost: number): void {
  let models = buckets.get(day);
  if (!models) { models = new Map(); buckets.set(day, models); }
  let t = models.get(model);
  if (!t) { t = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }; models.set(model, t); }
  t.cost += cost;
  t.input += usage.input_tokens || 0;
  t.output += usage.output_tokens || 0;
  t.cacheRead += usage.cache_read_input_tokens || 0;
  t.cacheWrite += usage.cache_creation
    ? (usage.cache_creation.ephemeral_5m_input_tokens || 0) + (usage.cache_creation.ephemeral_1h_input_tokens || 0)
    : usage.cache_creation_input_tokens || 0;
  t.messages += 1;
}

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

function bucketFile(path: string): DayModelBuckets {
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

  const byDay: DayModelBuckets = new Map();
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

    // "<synthetic>" marks error/placeholder messages Claude writes with no
    // real API call behind them — they carry no billable usage.
    const rawModel: string | undefined = entry.message?.model;
    if (rawModel === '<synthetic>') continue;

    const key = localDateKey(date);
    const cost = computeCost(usage, rawModel);
    addUsage(byDay, key, normalizeModelId(rawModel || 'unknown'), usage, cost);
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
  /** day key → model → totals, merged across all files (7-day rollup source). */
  const dayModel: DayModelBuckets = new Map();

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
        for (const [date, models] of bucket) {
          let dayCost = 0;
          for (const [model, t] of models) {
            dayCost += t.cost;
            let merged = dayModel.get(date);
            if (!merged) { merged = new Map(); dayModel.set(date, merged); }
            let mt = merged.get(model);
            if (!mt) { mt = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }; merged.set(model, mt); }
            mt.cost += t.cost;
            mt.input += t.input;
            mt.output += t.output;
            mt.cacheRead += t.cacheRead;
            mt.cacheWrite += t.cacheWrite;
            mt.messages += t.messages;
          }
          totals.set(date, (totals.get(date) || 0) + dayCost);
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

  // Per-model rollup over the same 7-day window as byDay.
  const weekKeys = new Set(byDay.map((e) => e.date));
  const perModel = new Map<string, ModelUsageSummary>();
  for (const [date, models] of dayModel) {
    if (!weekKeys.has(date)) continue;
    for (const [model, t] of models) {
      let s = perModel.get(model);
      if (!s) {
        s = {
          model,
          label: modelDisplayLabel(model),
          costToday: 0, costWeek: 0,
          inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          messages: 0,
        };
        perModel.set(model, s);
      }
      s.costWeek += t.cost;
      if (date === todayKey) s.costToday += t.cost;
      s.inputTokens += t.input;
      s.outputTokens += t.output;
      s.cacheReadTokens += t.cacheRead;
      s.cacheWriteTokens += t.cacheWrite;
      s.messages += t.messages;
    }
  }
  const byModel = [...perModel.values()].sort((a, b) => b.costWeek - a.costWeek);

  return {
    byDay,
    today: totals.get(todayKey) || 0,
    yesterday: totals.get(yesterdayKey) || 0,
    week: byDay.reduce((s, e) => s + e.cost, 0),
    total,
    byModel,
  };
}
