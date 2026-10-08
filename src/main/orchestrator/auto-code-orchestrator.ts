import type { BrowserWindow } from 'electron';
import { exec, execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, cpSync, writeFileSync, unlinkSync, createWriteStream } from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { request as httpsRequest } from 'https';
import { lookup as dnsLookup } from 'dns';
import { URL } from 'url';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog, debugError } from '../../shared/utils';
import { getSettings } from '../ipc/settings-handlers';
import { ClickUpProvider } from '../ipc/providers/clickup';
import { agentRegistry } from '../ipc/providers/agent-registry';
import type { KanbanTask, AutoCodeTaskState, AgentProviderId, AppSettings } from '../../shared/types';
import {
  listKanbanTasks,
  getKanbanTask,
  updateKanbanTask,
} from '../kanban/kanban-task-store';
import { broadcastKanbanEvent } from '../ipc/kanban-handlers';
import { mapClickupStatusToKanban, statusMatchesAny, primaryStatus } from '../../shared/kanban-status-mapper';
import { recordActivity } from '../activity/activity-store';
import type { ActivityLevel, CodeReviewFinding } from '../../shared/types';

const GIT_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 60_000;
const FIX_TIMEOUT_MS = 20 * 60_000;
const REVIEW_TIMEOUT_MS = 10 * 60_000;
const STALE_FIXING_MS = 30 * 60_000;
const PREVIOUS_COMMENT_LIMIT = 20;
const BOT_FIX_MARKER = '_automated fix attempt by agent terminal_';
const BOT_ESCALATION_MARKER = '_automated by agent terminal_';
const BOT_COMMENT_MARKERS = [
  BOT_FIX_MARKER,
  BOT_ESCALATION_MARKER,
  '_approved via agent terminal_',
  '_automated review by agent terminal_',
];

function runCmd(command: string, cwd: string, timeout = GIT_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const err = error as any;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Run a binary with an explicit argv array and NO shell. Use this for any
 *  command that interpolates task-/branch-derived strings (commit messages, PR
 *  titles, base-branch names) — each arg is passed as a separate argv element,
 *  so shell metacharacters in a ClickUp task name can never be interpreted.
 *  The orchestrator runs unattended, so this is the safe default for those. */
function execFileCmd(file: string, args: string[], cwd: string, timeout = GIT_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const err = error as any;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** True for loopback / private / link-local IP literals (v4 and v6), which an
 *  SSRF payload would target. Used to vet image-download hosts. */
function isPrivateAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 (ULA)
  if (lower.startsWith('fe80')) return true;                         // link-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);       // IPv4-mapped
  if (mapped) return isPrivateAddress(mapped[1]);
  return false;
}

/** Validate a download URL before fetching it: https only, and every resolved
 *  address must be public. Rejects SSRF attempts where a ClickUp comment embeds
 *  a URL pointing at internal infrastructure. Re-run on every redirect hop. */
async function assertSafeDownloadUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { throw new Error(`Invalid download URL: ${rawUrl}`); }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-https download URL (${parsed.protocol})`);
  }
  const addrs = await new Promise<Array<{ address: string }>>((resolve, reject) => {
    dnsLookup(parsed.hostname, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses as Array<{ address: string }>));
  });
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new Error(`Refusing download from private address ${address} (${parsed.hostname})`);
    }
  }
  return parsed;
}

function sanitizeTaskId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

interface CommentImage {
  url: string;
  name: string;
  extension: string;
}

interface CommentContent {
  /** Reconstructed prose. Image blocks are replaced with [screenshot: name]
   *  markers so position context isn't lost when QC interleaves text + images. */
  text: string;
  /** Embedded images discovered in the rich `comment` blocks. */
  images: CommentImage[];
  /** Bookmark/unfurled link URLs from rich blocks. */
  links: { url: string; title?: string }[];
}

/** Pull text + media out of a ClickUp comment. ClickUp's `comment_text` field
 *  collapses image blocks to the literal string "image.png" and drops the URL,
 *  so we walk the rich `comment` block array ourselves whenever it's present. */
function extractCommentContent(comment: any): CommentContent {
  const images: CommentImage[] = [];
  const links: { url: string; title?: string }[] = [];

  if (Array.isArray(comment.comment)) {
    const parts: string[] = [];
    for (const block of comment.comment) {
      if (block && block.type === 'image' && block.image?.url) {
        const name = block.image.name || `image-${images.length + 1}.png`;
        // ClickUp returns "image/png" in extension; normalize to a file ext.
        const rawExt = (block.image.extension || '').replace(/^image\//, '');
        const ext = (rawExt || name.split('.').pop() || 'png').toLowerCase();
        images.push({ url: block.image.url, name, extension: ext });
        parts.push(`\n[screenshot: ${name}]\n`);
        continue;
      }
      if (block && block.type === 'bookmark' && block.bookmark?.url) {
        const url = block.bookmark.url;
        const title = block.bookmark.title;
        links.push({ url, title });
        parts.push(title ? `\n[link: ${title} — ${url}]\n` : `\n[link: ${url}]\n`);
        continue;
      }
      if (typeof block?.text === 'string') {
        parts.push(block.text);
      }
    }
    const text = parts.join('').replace(/\n{3,}/g, '\n\n').trim();
    return { text, images, links };
  }

  return { text: (comment.comment_text || '').trim(), images, links };
}

/** Legacy helper kept for the bot-comment scan (which only needs plain text). */
function extractCommentText(comment: any): string {
  return extractCommentContent(comment).text;
}

function isBotComment(text: string): boolean {
  const lower = text.toLowerCase();
  return BOT_COMMENT_MARKERS.some((marker) => lower.includes(marker));
}

/** Stream a remote file to disk. https only; the host is validated against
 *  private/loopback ranges before each request (and re-validated on every
 *  redirect) to block SSRF via a crafted ClickUp comment URL. Follows up to 3
 *  redirects (ClickUp's CDN can 308-redirect to a signed location). */
async function downloadToFile(url: string, destPath: string, hops = 3): Promise<void> {
  const parsed = await assertSafeDownloadUrl(url);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(parsed, { method: 'GET' }, (res) => {
      const status = res.statusCode || 0;
      if ((status === 301 || status === 302 || status === 307 || status === 308) && res.headers.location && hops > 0) {
        res.resume();
        const next = new URL(res.headers.location, parsed).toString();
        // Re-validate the redirect target (assertSafeDownloadUrl runs again).
        downloadToFile(next, destPath, hops - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} when fetching ${url}`));
        return;
      }
      const out = createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(NETWORK_TIMEOUT, () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.end();
  });
}

/** What kind of work a dispatch performs.
 *  - 'implement'  → build the task from its description (first-pass feature work)
 *  - 'fix'        → address QC failure feedback on an existing attempt
 *  - 'review-fix' → address AI Code Review findings, then hand the task back to
 *    the Code Review loop (flip to the re-review status) so it re-verifies. */
type AutoCodeMode = 'implement' | 'fix' | 'review-fix';

/** Footer marker the Code Review subsystem stamps on its ClickUp comments
 *  (see code-review-handlers.formatReviewComment). We normally filter bot
 *  comments out, but in REVIEW-FIX mode the findings ARE the work item, so we
 *  look this comment up on purpose. */
const CODE_REVIEW_MARKER = '_automated review by agent terminal_';

export interface AutoCodeStatusPayload {
  active: boolean;
  running: boolean;
  lastRun: string | null;
  nextRun: string | null;
  intervalMinutes: number;
  maxIterations: number;
}

export type AutoCodeEvent =
  | { type: 'status'; payload: AutoCodeStatusPayload }
  | { type: 'cycle-start'; at: string }
  | { type: 'cycle-end'; at: string; processed: number; errors: number }
  | { type: 'log'; taskId?: string; message: string; level: 'info' | 'warn' | 'error' };

const clickUpProvider = new ClickUpProvider();

class AutoCodeOrchestrator {
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;
  private lastRun: string | null = null;
  private nextRun: string | null = null;
  private intervalMs = 30 * 60_000;
  private getWindow: (() => BrowserWindow | null) | null = null;

  init(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow;
  }

  getStatus(): AutoCodeStatusPayload {
    const settings = getSettings();
    return {
      active: this.intervalHandle !== null,
      running: this.running,
      lastRun: this.lastRun,
      nextRun: this.nextRun,
      intervalMinutes: settings.autoCodePollIntervalMinutes || 30,
      maxIterations: settings.autoCodeMaxIterations || 3,
    };
  }

  start(): void {
    const settings = getSettings();
    if (!settings.autoCodeEnabled) {
      debugLog('[AutoCode] Not starting — master switch is off');
      return;
    }

    const minutes = Math.max(1, settings.autoCodePollIntervalMinutes || 30);
    this.intervalMs = minutes * 60_000;

    this.stop();

    this.nextRun = new Date(Date.now() + this.intervalMs).toISOString();
    debugLog(`[AutoCode] Starting orchestrator, interval = ${minutes}m, next run at ${this.nextRun}`);

    void this.runCycle();

    this.intervalHandle = setInterval(() => {
      this.nextRun = new Date(Date.now() + this.intervalMs).toISOString();
      void this.runCycle();
    }, this.intervalMs);

    this.emitStatus();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.nextRun = null;
    debugLog('[AutoCode] Orchestrator stopped');
    this.emitStatus();
  }

  async runNow(): Promise<void> {
    await this.runCycle();
  }

  /** Decide what kind of work Auto Code should do for a task given its live
   *  ClickUp status, or null if there's nothing to do.
   *   • Review-Failed status     → REVIEW-FIX (address Code Review findings)
   *   • Failed status            → FIX (address QC feedback)
   *   • Configured start status  → IMPLEMENT (build from description)
   *   • No start status set      → IMPLEMENT once, for a task that hasn't started
   *     yet (no prior attempts / branch / PR).
   *  Review-Failed wins over Failed if a workflow somehow reports both, since it
   *  carries the more specific signal (code review feedback to act on). */
  private resolveMode(task: KanbanTask, settings = getSettings()): AutoCodeMode | null {
    const status = task.clickupStatus || '';
    if (statusMatchesAny(status, settings.autoCodeReviewFailedStatus, 'review failed')) return 'review-fix';
    if (statusMatchesAny(status, settings.autoCodeFailedStatus, 'failed')) return 'fix';

    const hasStartGate = (settings.autoCodeStartStatus || '').trim().length > 0;
    if (hasStartGate) {
      return statusMatchesAny(status, settings.autoCodeStartStatus) ? 'implement' : null;
    }
    // No start-status gate: implement once, but only for fresh work — never
    // re-implement a task already pushed (review), merged (done), or attempted.
    const alreadyMovedOn =
      statusMatchesAny(status, settings.autoCodeReviewStatus, 'ready for review') ||
      statusMatchesAny(status, settings.autoCodeDoneStatus, 'done');
    const notStarted =
      !alreadyMovedOn &&
      task.autoCodeState === 'idle' &&
      (task.iterationCount || 0) === 0 &&
      !task.prUrl &&
      !task.worktreeBranch;
    return notStarted ? 'implement' : null;
  }

  /** Mode resolution for a MANUAL trigger (the ⚡ button). More permissive than
   *  the automatic poll: the user explicitly asked to run this task now, so we
   *  don't require it to be fresh. Status-driven modes (fix / review-fix /
   *  fresh-implement) still win; otherwise any task that hasn't already moved
   *  past the build stage — including one sitting in an "In Progress" / "To Do"
   *  status with a worktree already on the go — is treated as IMPLEMENT, i.e.
   *  "continue building this from its description". Tasks awaiting review or done
   *  return null with a reason explaining how to re-engage them. */
  private resolveManualMode(task: KanbanTask, settings: AppSettings): { mode: AutoCodeMode | null; reason?: string } {
    const auto = this.resolveMode(task, settings);
    if (auto) return { mode: auto };

    const status = task.clickupStatus || '';
    if (statusMatchesAny(status, settings.autoCodeReviewStatus, 'ready for review')) {
      return {
        mode: null,
        reason: `"${status}" is awaiting review — Auto Code already pushed this. Move it to your Failed status to fix QC feedback, or the start status to rebuild.`,
      };
    }
    if (statusMatchesAny(status, settings.autoCodeDoneStatus, 'done')) {
      return { mode: null, reason: `"${status}" is done — nothing for Auto Code to do.` };
    }
    // To Do / In Progress / blank / any custom status → continue the work.
    return { mode: 'implement' };
  }

  /** Manually kick off Auto Code for a SINGLE task, bypassing the poll interval
   *  and the per-task opt-in toggle (a manual click is explicit intent). Still
   *  respects what the task's status allows — returns `ran: false` with a reason
   *  when there's nothing Auto Code can do. The actual dispatch runs in the
   *  background (it can take many minutes); the card reflects progress via the
   *  state patches it emits, so this resolves as soon as the work is launched. */
  async runTaskNow(kanbanTaskId: string): Promise<{ ran: boolean; mode?: AutoCodeMode; message: string }> {
    const settings = getSettings();
    if (settings.taskManagerProvider !== 'clickup') {
      return { ran: false, message: 'Auto Code requires the ClickUp task manager.' };
    }
    const task = getKanbanTask(kanbanTaskId);
    if (!task) return { ran: false, message: 'Task not found.' };
    if (task.provider === 'local') {
      return { ran: false, message: 'Local tasks have no ClickUp signal for Auto Code to act on.' };
    }
    if (task.autoCodeState === 'coding') {
      return { ran: false, message: 'Auto Code is already running for this task.' };
    }

    // Refresh the snapshot so the mode is resolved against the live ClickUp
    // status, not a stale one from the last poll.
    try { await this.refreshSnapshots([task]); } catch { /* fall back to stale snapshot */ }
    const fresh = getKanbanTask(kanbanTaskId) || task;

    const { mode, reason } = this.resolveManualMode(fresh, settings);
    if (!mode) {
      return {
        ran: false,
        message: reason || `Nothing for Auto Code to do for "${fresh.clickupStatus || 'no status'}".`,
      };
    }

    const maxIterations = Math.max(1, settings.autoCodeMaxIterations || 3);
    if ((fresh.iterationCount || 0) >= maxIterations) {
      return {
        ran: false,
        message: `Iteration cap (${maxIterations}) reached — re-queue the task first to reset its count.`,
      };
    }

    this.emitLog({ taskId: kanbanTaskId, message: `Manual Auto Code trigger — mode: ${mode}`, level: 'info' });
    // Fire-and-forget: dispatch is long-running. Mirror handleActiveTasks's
    // error handling so a manual run that throws is surfaced + reset.
    void this.dispatch(kanbanTaskId, mode).catch((err) => {
      const message = err instanceof Error ? err.message : 'Dispatch failed';
      this.emitLog({ taskId: kanbanTaskId, message, level: 'error' });
      this.patch(kanbanTaskId, { lastError: message, autoCodeState: 'idle' });
    });

    const verb = mode === 'implement' ? 'Implementing from description'
      : mode === 'review-fix' ? 'Fixing Code Review findings'
        : 'Fixing QC feedback';
    return { ran: true, mode, message: `${verb} — Auto Code started.` };
  }

  /** Reset a Kanban task's iteration count and return it to the failed queue */
  requeueTask(kanbanTaskId: string): KanbanTask | null {
    const updated = this.patch(kanbanTaskId, {
      iterationCount: 0,
      autoCodeState: 'idle',
      lastError: null,
    });
    if (updated) {
      this.emitLog({ taskId: kanbanTaskId, message: 'Task re-queued — iteration count reset', level: 'info' });
    }
    return updated;
  }

  private async runCycle(): Promise<void> {
    if (this.running) {
      debugLog('[AutoCode] Skipping cycle — previous cycle still running');
      return;
    }

    const settings = getSettings();
    if (!settings.autoCodeEnabled) return;
    if (settings.taskManagerProvider !== 'clickup') return;

    const all = listKanbanTasks();
    if (all.length === 0) {
      debugLog('[AutoCode] No Kanban tasks imported — nothing to do');
      return;
    }

    this.running = true;
    const startedAt = new Date().toISOString();
    this.lastRun = startedAt;
    this.emitEvent({ type: 'cycle-start', at: startedAt });
    this.emitStatus();

    let processed = 0;
    let errors = 0;

    try {
      // Refresh the ClickUp snapshot for every imported task so we react to
      // QC's status changes (Failed, Done) even between renderer refreshes.
      await this.refreshSnapshots(all);

      processed = await this.handleActiveTasks();
      await this.handleAwaitingReviewTasks();
    } catch (err) {
      errors++;
      debugError('[AutoCode] Cycle error:', err);
      this.emitLog({
        message: err instanceof Error ? err.message : 'Cycle failed',
        level: 'error',
      });
    } finally {
      this.running = false;
      const endedAt = new Date().toISOString();
      this.emitEvent({ type: 'cycle-end', at: endedAt, processed, errors });
      this.emitStatus();
    }
  }

  // ─── Cycle steps ─────────────────────────────────────────────

  private async refreshSnapshots(tasks: KanbanTask[]): Promise<void> {
    const settings = getSettings();

    // One batched read for the whole cycle — per-task reads overrun ClickUp's
    // 100 requests/minute token budget once the board holds ~100 tasks.
    const batch = await clickUpProvider.getTaskSnapshots(
      settings,
      tasks
        .filter((t) => t.provider !== 'local')
        .map((t) => ({ taskId: t.clickupTaskId, listId: t.clickupListId })),
    );
    const snapshots = batch.success ? batch.data : {};

    await Promise.all(
      tasks.map(async (task) => {
        // Local tasks aren't backed by ClickUp.
        if (task.provider === 'local') return;
        try {
          let fresh = snapshots[task.clickupTaskId];
          if (!fresh) {
            const result = await clickUpProvider.getTask(settings, task.clickupTaskId);
            if (!result.success) return;
            fresh = result.data;
          }

          const snapshotPatch: Partial<KanbanTask> = {
            clickupName: fresh.name,
            clickupStatus: fresh.status.name,
            clickupStatusColor: fresh.status.color,
            clickupCustomId: fresh.customId,
            clickupAssignees: fresh.assignees.map((a) => ({
              id: a.id,
              username: a.username,
              initials: a.initials,
            })),
            clickupPriority: fresh.priority,
            clickupTags: fresh.tags,
            clickupReleaseVersion: fresh.releaseVersion,
            clickupUpdatedAt: fresh.updatedAt,
            // Remember the list so the next cycle can batch this task.
            ...(fresh.listId ? { clickupListId: fresh.listId } : {}),
          };

          // Auto-map the column when ClickUp status actually changed — only on diff,
          // so we don't overwrite a manual drag that happened between cycles.
          if (fresh.status.name && fresh.status.name !== task.clickupStatus) {
            const mapped = mapClickupStatusToKanban(fresh.status.name, settings);
            if (mapped && mapped !== task.kanbanStatus) {
              snapshotPatch.kanbanStatus = mapped;
            }
          }

          // Code Review re-run passed → it stamps the "reviewpass" tag (the task
          // stays in the review status, no status change). For a task we handed
          // back via review-fix, that tag freshly appearing is the terminal
          // "review passed" signal: clear the badge and record the success.
          const tagName = (settings.codeReviewTagName || 'reviewpass').toLowerCase();
          const hadPass = (task.clickupTags || []).some((t) => t.name?.toLowerCase() === tagName);
          const hasPass = (fresh.tags || []).some((t: { name?: string }) => t.name?.toLowerCase() === tagName);
          if (hasPass && !hadPass && task.autoCodeState === 'awaiting-review') {
            snapshotPatch.autoCodeState = 'idle';
            this.activity(
              task,
              'review-passed',
              'success',
              `Code Review passed: ${task.clickupCustomId || task.clickupName}`,
              `The automated Code Review passed after Auto Code's fix — "${tagName}" tag applied.`,
              task.prUrl || undefined,
            );
            this.emitLog({ taskId: task.id, message: 'Code Review passed — review-fix loop complete', level: 'info' });
          }

          // Reconcile autoCodeState with the live ClickUp status. The orchestrator
          // only sets 'awaiting-review'/'coding' while a task is inside the
          // failed → retest → done loop (now also: review-failed → re-review).
          // Once the task moves anywhere outside that loop (To Do, In Progress,
          // Blocked, etc.) those states are stale and shouldn't keep the yellow
          // "Awaiting" badge lit.
          if (
            (task.autoCodeState === 'awaiting-review' || task.autoCodeState === 'coding') &&
            !snapshotPatch.autoCodeState
          ) {
            const name = fresh.status.name || '';
            const inLoop =
              statusMatchesAny(name, settings.autoCodeReviewStatus, 'ready for review') ||
              statusMatchesAny(name, settings.autoCodeInProgressStatus, 'in progress') ||
              statusMatchesAny(name, settings.autoCodeFailedStatus, 'failed') ||
              statusMatchesAny(name, settings.autoCodeReviewFailedStatus, 'review failed') ||
              statusMatchesAny(name, settings.codeReviewStatuses, 'ready for review') ||
              statusMatchesAny(name, settings.autoCodeDoneStatus, 'done');
            if (!inLoop) {
              snapshotPatch.autoCodeState = 'idle';
            }
          }

          this.patch(task.id, snapshotPatch);
        } catch {
          /* non-critical — we'll try again next cycle */
        }
      }),
    );
  }

  private async handleActiveTasks(): Promise<number> {
    const settings = getSettings();
    // Each of these settings accepts a single status OR a comma-separated list,
    // so a workflow with several matching statuses (e.g. "Failed, Review Failed")
    // all trigger the same behaviour. Matching is case-insensitive.
    const maxIterations = Math.max(1, settings.autoCodeMaxIterations || 3);

    // After snapshot refresh, re-read tasks and pick ones to act on.
    const all = listKanbanTasks();
    const eligible: Array<{ task: KanbanTask; mode: AutoCodeMode }> = [];

    for (const task of all) {
      // Local tasks have no ClickUp signal — skip the auto-code loop.
      if (task.provider === 'local') continue;

      const status = task.clickupStatus || '';
      const isFailed = statusMatchesAny(status, settings.autoCodeFailedStatus, 'failed');
      const isReviewFailed = statusMatchesAny(status, settings.autoCodeReviewFailedStatus, 'review failed');

      // Mirror Kanban status to Failed column whenever ClickUp reports a QC or
      // Code Review failure.
      if ((isFailed || isReviewFailed) && task.kanbanStatus !== 'failed') {
        this.patch(task.id, { kanbanStatus: 'failed' });
      }

      // Strict opt-in: only tasks the user explicitly enabled are followed.
      // Default is OFF — skip silently so unenrolled tasks don't spam the log
      // every cycle. (Work always runs in an isolated worktree, so
      // current-branch tasks may opt in too.)
      if (task.autoCodeEnabled !== true) continue;
      if (task.autoCodeState === 'escalated') continue;

      // Decide what kind of work this cycle is (see resolveMode for the rules).
      const mode = this.resolveMode(task, settings);
      if (!mode) continue;

      const lastActionAge = task.lastFixActionAt ? Date.now() - Date.parse(task.lastFixActionAt) : Infinity;
      if (task.autoCodeState === 'coding' && lastActionAge < STALE_FIXING_MS) {
        this.emitLog({ taskId: task.id, message: 'Already running — skipping this cycle', level: 'info' });
        continue;
      }

      const current = getKanbanTask(task.id);
      if (!current) continue;

      if (current.iterationCount >= maxIterations) {
        await this.escalate(current, maxIterations);
        continue;
      }

      eligible.push({ task: current, mode });
    }

    if (eligible.length === 0) return 0;

    this.emitLog({ message: `Dispatching auto-code for ${eligible.length} task(s)`, level: 'info' });

    await Promise.all(
      eligible.map(async ({ task, mode }) => {
        try {
          await this.dispatch(task.id, mode);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Dispatch failed';
          this.emitLog({ taskId: task.id, message, level: 'error' });
          this.patch(task.id, { lastError: message, autoCodeState: 'idle' });
          this.activity(
            task,
            'code-failed',
            'error',
            `Auto Code error: ${task.clickupCustomId || task.clickupName}`,
            message.slice(0, 200),
          );
          try {
            await clickUpProvider.postComment(
              getSettings(),
              task.clickupTaskId,
              `⚠️ **Auto Code Error** — "${task.clickupName}": ${message}\n\n${BOT_FIX_MARKER}`,
            );
          } catch { /* non-critical */ }
        }
      }),
    );

    return eligible.length;
  }

  private async handleAwaitingReviewTasks(): Promise<void> {
    const settings = getSettings();

    // In-flight tasks complete their loop even if the user flipped the
    // per-task toggle off after the fix was pushed — otherwise they'd hang
    // at 'awaiting-review' forever.
    const tracked = listKanbanTasks().filter(
      (t) =>
        t.provider !== 'local' &&
        (t.autoCodeState === 'awaiting-review' || t.autoCodeState === 'merging'),
    );

    for (const task of tracked) {
      if (!statusMatchesAny(task.clickupStatus, settings.autoCodeDoneStatus, 'done')) continue;

      const shouldMerge = this.resolveAutoMerge(task, settings.autoCodeAutoMerge);

      if (task.autoCodeState === 'merging') continue; // already queued

      if (!shouldMerge || !task.worktreeBranch) {
        this.patch(task.id, { autoCodeState: 'done', kanbanStatus: 'done' });
        this.emitLog({
          taskId: task.id,
          message: shouldMerge
            ? 'QC passed but no branch recorded — skipping merge'
            : 'QC passed — auto-merge disabled for this task',
          level: 'info',
        });
        continue;
      }

      this.patch(task.id, {
        autoCodeState: 'merging',
        autoMergeQueuedAt: new Date().toISOString(),
      });
      await this.queueAutoMerge(task);
    }
  }

  private resolveAutoMerge(task: KanbanTask, globalEnabled: boolean): boolean {
    if (task.autoMergeOverride === true) return true;
    if (task.autoMergeOverride === false) return false;
    return globalEnabled;
  }

  private async queueAutoMerge(task: KanbanTask): Promise<void> {
    const { projectPath, worktreeBranch, clickupTaskId } = task;
    if (!projectPath || !worktreeBranch) return;
    try {
      await execFileCmd('gh', ['pr', 'merge', worktreeBranch, '--auto', '--squash'], projectPath, NETWORK_TIMEOUT);
      this.emitLog({
        taskId: task.id,
        message: `Auto-merge queued on branch "${worktreeBranch}" — will merge when CI passes`,
        level: 'info',
      });
      // gh accepted the auto-merge — from the orchestrator's POV the task is
      // complete. Don't leave it sitting at 'merging' forever waiting for a
      // signal that never comes (gh handles the actual merge on CI green).
      this.patch(task.id, { autoCodeState: 'done', kanbanStatus: 'done' });
      this.activity(
        task,
        'pr-auto-merged',
        'success',
        `Auto-merge queued: ${task.clickupCustomId || task.clickupName}`,
        `Branch "${worktreeBranch}" will merge once CI passes.`,
      );
      try {
        await clickUpProvider.postComment(
          getSettings(),
          clickupTaskId,
          `🚀 **Auto-Merge Queued** — branch \`${worktreeBranch}\` will merge automatically once CI passes.\n\n${BOT_FIX_MARKER}`,
        );
      } catch { /* non-critical */ }
    } catch (err: any) {
      const message = err.stderr?.toString() || err.message || 'Failed to queue auto-merge';
      this.emitLog({ taskId: task.id, message: `Auto-merge failed: ${message.slice(0, 200)}`, level: 'error' });
      this.patch(task.id, { autoCodeState: 'done', kanbanStatus: 'done', lastError: message.slice(0, 200) });
    }
  }

  private async escalate(task: KanbanTask, cap: number): Promise<void> {
    this.patch(task.id, { autoCodeState: 'escalated', kanbanStatus: 'failed' });
    try {
      await clickUpProvider.postComment(
        getSettings(),
        task.clickupTaskId,
        `⚠️ **Auto Code Escalated** — ${cap} fix attempts did not resolve QC failures for "${task.clickupName}". This task needs manual review. Once the blocker is cleared, re-queue it from the Kanban Board.\n\n${BOT_ESCALATION_MARKER}`,
      );
    } catch (err) {
      this.emitLog({
        taskId: task.id,
        message: `Failed to post escalation comment: ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
    }
    this.emitLog({ taskId: task.id, message: `Escalated after ${cap} iterations`, level: 'warn' });
    this.activity(
      task,
      'fix-escalated',
      'error',
      `Auto-fix escalated: ${task.clickupCustomId || task.clickupName}`,
      `${cap} fix attempts did not clear QC — needs manual review.`,
    );
  }

  /** Put the ClickUp status back to where it was before we flipped it to
   *  "in progress", used when a dispatch escalates mid-run so the ticket
   *  doesn't get stranded showing active work that has actually stopped. */
  private async restoreClickupStatus(task: KanbanTask, status: string, didFlip: boolean): Promise<void> {
    if (!didFlip || !status) return;
    try {
      await clickUpProvider.updateStatus(getSettings(), task.clickupTaskId, status);
      this.emitLog({ taskId: task.id, message: `ClickUp status restored to "${status}" after escalation`, level: 'info' });
    } catch { /* non-critical */ }
  }

  // ─── Dispatch (implement / fix) ──────────────────────────────

  private async dispatch(kanbanTaskId: string, mode: AutoCodeMode): Promise<void> {
    const settings = getSettings();
    const task = getKanbanTask(kanbanTaskId);
    if (!task) return;

    const projectPath = task.projectPath;
    if (!projectPath) throw new Error('KanbanTask has no projectPath');

    // 1. Fetch comments — QC feedback drives FIX mode; in IMPLEMENT mode they're
    //    extra context layered on top of the task description. Bot-authored and
    //    empty comments are filtered out.
    const commentsResult = await clickUpProvider.getComments(settings, task.clickupTaskId);
    if (!commentsResult.success) {
      throw new Error(`Failed to fetch comments: ${commentsResult.error}`);
    }
    const comments = commentsResult.data || [];
    const devComments = comments
      .map((c: any) => {
        const content = extractCommentContent(c);
        return {
          id: c.id,
          text: content.text,
          images: content.images,
          links: content.links,
          user: c.user?.username || 'QC',
          date: c.date,
        };
      })
      // Skip bot-authored comments AND skip empty ones (no text + no images).
      .filter((c) => (c.text || c.images.length > 0) && !isBotComment(c.text));

    const latest = devComments.length > 0 ? devComments[devComments.length - 1] : null;

    // In REVIEW-FIX mode the work item is the AI Code Review's findings comment,
    // which is a *bot* comment (so it's excluded from devComments above). Pull
    // the most recent failing review comment back out on purpose.
    const reviewFindings = mode === 'review-fix' ? this.findLatestReviewFindings(comments) : null;

    // The comment whose id drives the "already acted on this?" guard: the
    // review findings in review-fix mode, the latest QC comment otherwise.
    const trigger = mode === 'review-fix' ? reviewFindings : latest;

    if (mode === 'fix') {
      if (!latest) {
        throw new Error('Task is Failed but has no QC comments to act on');
      }
    } else if (mode === 'review-fix') {
      if (!reviewFindings) {
        throw new Error('Task is Review Failed but has no Code Review findings comment to act on');
      }
    }

    // No new failure/findings comment since the last attempt — don't re-do the
    // same work; wait for QC re-test (fix) or the Code Review re-run (review-fix).
    if ((mode === 'fix' || mode === 'review-fix') && trigger && task.lastSeenFailureCommentId === trigger.id) {
      this.emitLog({
        taskId: task.id,
        message: mode === 'review-fix'
          ? 'No new Code Review findings since last fix — waiting for re-review'
          : 'No new failure comment since last fix — waiting for QC re-test',
        level: 'info',
      });
      this.patch(task.id, { autoCodeState: 'awaiting-review', kanbanStatus: 'review' });
      return;
    }

    // In IMPLEMENT mode the task description is the spec. Prefer the live
    // ClickUp description; fall back to the locally-stored one.
    let description = '';
    if (mode === 'implement') {
      try {
        const fresh = await clickUpProvider.getTask(settings, task.clickupTaskId);
        if (fresh.success) description = (fresh.data.description || '').trim();
      } catch { /* fall back below */ }
      if (!description) description = (task.description || '').trim();
    }

    // 2. Begin work
    // Remember the status the task came in at so we can restore it if this run
    // escalates after we've already flipped ClickUp to the "in progress" status.
    const originalClickupStatus = task.clickupStatus || '';
    const iteration = (task.iterationCount || 0) + 1;
    const safeId = sanitizeTaskId(task.clickupCustomId || task.clickupTaskId);
    // Use Claude's native worktree convention so a `claude --worktree <id>`
    // run anywhere reuses this same dir + branch. ensureWorktree may swap these
    // for a fresh unique name if the existing worktree has a base mismatch, so
    // they're mutable and re-read from its return value below.
    let worktreeDir = join(projectPath, '.claude', 'worktrees', safeId);
    let branch = `worktree-${safeId}`;

    this.patch(task.id, {
      autoCodeState: 'coding',
      kanbanStatus: 'in-progress',
      iterationCount: iteration,
      // fix / review-fix track the comment they're responding to so we don't
      // re-do the same work before the re-test / re-review runs.
      lastSeenFailureCommentId: trigger ? trigger.id : (task.lastSeenFailureCommentId ?? null),
      lastError: null,
      lastFixActionAt: new Date().toISOString(),
      worktreeBranch: branch,
      worktreePath: worktreeDir,
    });
    this.emitLog({
      taskId: task.id,
      message: mode === 'implement'
        ? `Implementing task — attempt ${iteration}`
        : mode === 'review-fix'
          ? `Code Review fix attempt ${iteration} — starting`
          : `Fix attempt ${iteration} — starting`,
      level: 'info',
    });

    // Flip the ClickUp ticket to the "in progress" status so the remote board
    // shows the agent is actively coding. Without this it sits in its
    // failed/start status for the whole run, which reads as "nothing happened".
    // Skipped when the status is blank or the task is already there.
    const inProgressStatus = primaryStatus(settings.autoCodeInProgressStatus, '');
    let flippedToInProgress = false;
    if (inProgressStatus && !statusMatchesAny(originalClickupStatus, settings.autoCodeInProgressStatus)) {
      try {
        await clickUpProvider.updateStatus(settings, task.clickupTaskId, inProgressStatus);
        flippedToInProgress = true;
        this.emitLog({ taskId: task.id, message: `ClickUp status → "${inProgressStatus}" (coding started)`, level: 'info' });
      } catch (err) {
        this.emitLog({
          taskId: task.id,
          message: `Failed to flip status to "${inProgressStatus}": ${err instanceof Error ? err.message : String(err)}`,
          level: 'warn',
        });
      }
    }

    // 3. Resolve worktree — fork from the task's chosen base branch, not the repo
    //    default. May hand back a fresh unique dir/branch (base-mismatch case);
    //    adopt those for the rest of the run and persist them.
    const resolved = await this.ensureWorktree(projectPath, worktreeDir, branch, task.baseBranch);
    if (resolved.branch !== branch || resolved.worktreeDir !== worktreeDir) {
      branch = resolved.branch;
      worktreeDir = resolved.worktreeDir;
      this.patch(task.id, { worktreeBranch: branch, worktreePath: worktreeDir });
      this.emitLog({ taskId: task.id, message: `Using fresh worktree branch "${branch}" for a new PR`, level: 'info' });
    }

    // 4. Build prompt with prior attempts. Download any screenshots so Claude
    //    can actually SEE them via vision (via @path attachments) instead of
    //    just being told "[image: foo.png]" without context.
    const priorBotAttempts = comments
      .map((c: any) => extractCommentText(c).trim())
      .filter((t: string) => t && t.toLowerCase().includes(BOT_FIX_MARKER.toLowerCase()))
      .slice(-PREVIOUS_COMMENT_LIMIT);

    const priorDevComments = devComments.slice(-PREVIOUS_COMMENT_LIMIT);
    const renderedDevComments = await Promise.all(
      priorDevComments.map(async (c) => {
        const imagePaths = await this.downloadCommentImages(c.id, c.images, worktreeDir);
        const lines = [`[${c.user}]: ${c.text || '(no text — screenshots only)'}`];
        if (imagePaths.length > 0) {
          lines.push('Screenshots from QC (attached for review):');
          for (const rel of imagePaths) lines.push(`  @${rel}`);
        }
        if (c.links.length > 0) {
          lines.push('Linked resources:');
          for (const l of c.links) lines.push(`  - ${l.title ? `${l.title} — ` : ''}${l.url}`);
        }
        return lines.join('\n');
      }),
    );
    const prompt = mode === 'implement'
      ? this.buildImplementPrompt({
          taskName: task.clickupName,
          customId: task.clickupCustomId,
          description,
          comments: renderedDevComments,
        })
      : mode === 'review-fix'
        ? this.buildReviewFixPrompt({
            taskName: task.clickupName,
            customId: task.clickupCustomId,
            iteration,
            maxIterations: settings.autoCodeMaxIterations,
            reviewFindings: reviewFindings?.text || '',
            devComments: renderedDevComments,
            priorBotAttempts,
          })
        : this.buildFixPrompt({
            taskName: task.clickupName,
            customId: task.clickupCustomId,
            iteration,
            maxIterations: settings.autoCodeMaxIterations,
            devComments: renderedDevComments,
            priorBotAttempts,
            qcDiagnostics: task.qcDiagnostics,
          });

    const headBefore = await this.safeGitCmd('git rev-parse HEAD', worktreeDir);

    // 5. Run the fix agent — uses the task's chosen agent (the one picked in
    //    the task detail), falling back to the global default, then Claude.
    //    Model is left to the provider's headless default. Only headless-capable
    //    agents can run; others escalate with a clear message.
    const providerId = task.agentProvider || settings.defaultAgentProvider || 'claude';
    const verb = mode === 'implement' ? 'implementation' : mode === 'review-fix' ? 'review fix' : 'fix';
    this.emitLog({ taskId: task.id, message: `Running ${verb} with agent "${providerId}"`, level: 'info' });
    const agentStdout = await this.runAgentFix(prompt, worktreeDir, providerId);

    // Recover the resumable session id + the agent's final summary from the
    // headless run. Storing the session lets the user reopen the task and click
    // Resume to inspect the full transcript of what the agent actually did.
    const headless = agentRegistry.get(providerId)?.parseHeadlessResult?.(agentStdout) || null;
    if (headless?.sessionId) {
      this.patch(task.id, {
        agentSessionId: headless.sessionId,
        agentProvider: providerId,
        agentCwd: worktreeDir,
      });
      this.emitLog({
        taskId: task.id,
        message: `Saved agent session ${headless.sessionId} — open the task and Resume to inspect the run`,
        level: 'info',
      });
    }

    const commitLabel = mode === 'implement'
      ? `Auto Code: implement ${task.clickupCustomId || task.clickupTaskId}`
      : mode === 'review-fix'
        ? `Auto Code: address review findings (attempt ${iteration}) for ${task.clickupCustomId || task.clickupTaskId}`
        : `Auto-fix attempt ${iteration} for ${task.clickupCustomId || task.clickupTaskId}`;
    await this.commitStragglers(worktreeDir, commitLabel);

    const headAfter = await this.safeGitCmd('git rev-parse HEAD', worktreeDir);
    const producedChanges = headBefore !== null && headAfter !== null && headBefore !== headAfter;

    if (!producedChanges) {
      this.emitLog({ taskId: task.id, message: `Agent produced no commits — escalating`, level: 'warn' });
      this.patch(task.id, { autoCodeState: 'escalated', kanbanStatus: 'failed' });
      this.activity(
        task,
        'code-escalated',
        'error',
        `Auto Code escalated: ${task.clickupCustomId || task.clickupName}`,
        `Attempt ${iteration} finished without committing any changes.`,
      );
      try {
        await clickUpProvider.postComment(
          settings,
          task.clickupTaskId,
          `⚠️ **Auto Code Produced No Changes** — Attempt ${iteration} finished without committing anything. Please clarify the ${mode === 'implement' ? 'requirements' : 'failure'} and re-queue.\n\n${BOT_ESCALATION_MARKER}`,
        );
      } catch { /* non-critical */ }
      await this.restoreClickupStatus(task, originalClickupStatus, flippedToInProgress);
      return;
    }

    // 5b. Second-agent review gate — a different agent reviews the diff before
    //     it reaches QC. A failed verdict / critical finding holds the task
    //     back (escalates) instead of pushing it forward to re-test.
    //     Skipped in review-fix mode: the full AI Code Review re-runs on the PR
    //     once we hand it back, so it's the authoritative judge — running the
    //     lighter gate here too would just risk escalating before re-review.
    if (mode !== 'review-fix' && settings.autoCodeReviewGate && headBefore && headAfter) {
      this.emitLog({ taskId: task.id, message: 'Running second-agent review gate…', level: 'info' });
      const review = await this.reviewFixDiff(worktreeDir, headBefore, headAfter, task.clickupName, providerId);
      const critical = review?.findings.filter((f) => f.severity === 'critical') || [];
      if (review && (!review.pass || critical.length > 0)) {
        this.emitLog({
          taskId: task.id,
          message: `Review gate rejected the fix (${critical.length} critical finding(s)) — escalating`,
          level: 'warn',
        });
        this.patch(task.id, { autoCodeState: 'escalated', kanbanStatus: 'failed' });
        this.activity(
          task,
          'review-rejected',
          'error',
          `Fix review rejected: ${task.clickupCustomId || task.clickupName}`,
          critical[0]?.description || 'A reviewing agent flagged the fix as unsafe for QC.',
        );
        try {
          await clickUpProvider.postComment(
            settings,
            task.clickupTaskId,
            this.formatReviewRejection(iteration, review.findings),
          );
        } catch { /* non-critical */ }
        await this.restoreClickupStatus(task, originalClickupStatus, flippedToInProgress);
        return;
      }
      if (review) this.emitLog({ taskId: task.id, message: 'Review gate passed', level: 'info' });
    }

    // 6. Push
    try {
      await execFileCmd('git', ['push', '-u', 'origin', branch], worktreeDir, NETWORK_TIMEOUT);
    } catch (err: any) {
      const msg = err.stderr?.toString() || err.message || '';
      if (!msg.includes('up-to-date') && !msg.includes('up to date')) {
        throw new Error(`Failed to push branch: ${msg.slice(0, 200)}`);
      }
    }

    // 7. PR
    const pr = await this.resolvePR(
      projectPath,
      branch,
      task.clickupName,
      task.clickupCustomId || task.clickupTaskId,
      task.baseBranch,
    );
    if (pr?.url) this.patch(task.id, { prUrl: pr.url });

    // 8. ClickUp status flip + comment.
    //    fix/implement → flip to the QC re-test status.
    //    review-fix    → flip back to the Code Review status so the Code Review
    //                    loop re-reviews the updated PR (pass → "reviewpass" tag,
    //                    fail → "review failed" again → another review-fix).
    const shortSha = headAfter ? headAfter.substring(0, 7) : 'HEAD';
    const retestStatus = mode === 'review-fix'
      ? primaryStatus(settings.codeReviewStatuses, primaryStatus(settings.autoCodeReviewStatus, 'ready for review'))
      : primaryStatus(settings.autoCodeReviewStatus, 'ready for review');
    const changes = await this.summarizeChanges(worktreeDir, headBefore, headAfter);
    const comment = this.formatCompletionComment({
      mode,
      iteration,
      maxIterations: settings.autoCodeMaxIterations,
      qcFeedback: mode === 'fix' ? latest?.text : (mode === 'review-fix' ? reviewFindings?.text : undefined),
      agentSummary: headless?.summary,
      changedFiles: changes.files,
      commits: changes.commits,
      shortSha,
      prUrl: pr?.url,
      branch,
      retestStatus,
    });
    try {
      await clickUpProvider.postComment(settings, task.clickupTaskId, comment);
    } catch (err) {
      this.emitLog({
        taskId: task.id,
        message: `Failed to post fix comment: ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
    }

    try {
      await clickUpProvider.updateStatus(settings, task.clickupTaskId, retestStatus);
    } catch (err) {
      this.emitLog({
        taskId: task.id,
        message: `Failed to flip status to "${retestStatus}": ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
    }

    this.patch(task.id, {
      autoCodeState: 'awaiting-review',
      kanbanStatus: 'review',
    });
    this.emitLog({ taskId: task.id, message: `Pushed (commit ${shortSha}) — awaiting review`, level: 'info' });
    const pushedWhat = mode === 'implement' ? 'Implementation' : mode === 'review-fix' ? 'Review fix' : 'Fix';
    this.activity(
      task,
      'code-pushed',
      'success',
      `${pushedWhat} pushed: ${task.clickupCustomId || task.clickupName}`,
      `${mode === 'implement' ? 'Implemented' : `Attempt ${iteration}`} pushed (commit ${shortSha}) — flipped to "${retestStatus}" for ${mode === 'review-fix' ? 're-review' : 'review'}.`,
      pr?.url,
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /** Prompt for IMPLEMENT mode — build the task from its description (plus any
   *  non-bot comments as extra context). Mirrors the fix prompt's structure but
   *  frames the work as feature implementation, not a regression fix. */
  private buildImplementPrompt(ctx: {
    taskName: string;
    customId?: string;
    description: string;
    comments: string[];
  }): string {
    const descSection = ctx.description
      ? `\n## Description / Acceptance Criteria\n${ctx.description}\n`
      : `\n## Description / Acceptance Criteria\n(No description was provided on the task — infer the smallest reasonable scope from the title and any comments below, and state your assumptions in the commit message.)\n`;

    const commentsSection = ctx.comments.length > 0
      ? `\n## Additional Context from Task Comments\nSome comments include screenshots saved under \`.qc-images/<commentId>/\` and referenced as \`@.qc-images/...\`. Open them with the Read tool.\n\n${ctx.comments.join('\n\n')}\n`
      : '';

    return `You are an autonomous coding agent working in an isolated git worktree. Implement the task below from its description and produce a commit.

## Task
${ctx.customId ? `ID: ${ctx.customId}\n` : ''}Title: ${ctx.taskName}
${descSection}${commentsSection}
## Instructions
1. Read the description and any comments carefully to understand what to build.
2. Explore the repository to learn its conventions before writing code (existing patterns, structure, libraries).
3. Implement the task. Match the surrounding code's style and idioms.
4. Add or update tests where the project has a test suite, and run them if practical.
5. Commit your changes with a clear, descriptive message.
6. DO NOT push — the orchestrator will push and open the PR.
7. As your FINAL message, output a concise summary (3-6 bullet points) of WHAT you built and HOW you approached it. This summary is posted verbatim to the task tracker for human reviewers, so make it self-contained and skip any preamble.

## Constraints
- Stay within the scope of the task. Don't refactor unrelated code.
- If the task is too ambiguous to implement safely, exit WITHOUT committing — the orchestrator will escalate to a human.
- You have full shell access — run builds/tests/checks to validate your work.`;
  }

  private buildFixPrompt(ctx: {
    taskName: string;
    customId?: string;
    iteration: number;
    maxIterations: number;
    devComments: string[];
    priorBotAttempts: string[];
    qcDiagnostics?: { consoleErrors: string[]; networkErrors: string[]; capturedAt: string };
  }): string {
    const priorSection = ctx.priorBotAttempts.length > 0
      ? `\n## Previous Fix Attempts\nYou have already tried the following approaches. Do NOT repeat a fix that did not work — look deeper or reconsider the root cause.\n\n${ctx.priorBotAttempts.map((p, i) => `### Attempt ${i + 1}\n${p}`).join('\n\n')}\n`
      : '';

    const diag = ctx.qcDiagnostics;
    const diagSection = diag && (diag.consoleErrors.length || diag.networkErrors.length)
      ? `\n## Runtime Diagnostics from the Last QC Run\nQC captured these from the live browser — they often point straight at the root cause.\n${diag.consoleErrors.length ? `\nConsole errors:\n${diag.consoleErrors.map((e) => `- ${e}`).join('\n')}\n` : ''}${diag.networkErrors.length ? `\nFailed network requests:\n${diag.networkErrors.map((e) => `- ${e}`).join('\n')}\n` : ''}`
      : '';

    return `You are an autonomous fix agent working in an isolated git worktree. Address QC feedback and produce a commit that resolves it.

## Task
${ctx.customId ? `ID: ${ctx.customId}\n` : ''}Title: ${ctx.taskName}
Fix attempt: ${ctx.iteration} of ${ctx.maxIterations}

## QC Failure Comments (chronological)
Each comment may include screenshots saved under \`.qc-images/<commentId>/\`. Their paths are listed in the comment block (e.g. \`@.qc-images/123/1.png\`). Open every screenshot with the Read tool — QC often points at a specific UI state that the text alone doesn't fully describe.

${ctx.devComments.join('\n\n')}
${diagSection}${priorSection}
## Instructions
1. Read every failure comment carefully. The LATEST comment is the current blocker.
2. Use the Read tool to open every screenshot referenced as \`@.qc-images/...\` so you can see what QC actually saw. Don't skip them.
3. Inspect the repository as needed (\`gh pr diff\`, \`git log\`, read source files).
4. Implement a fix that addresses the root cause.
5. Commit your changes with a clear message.
6. DO NOT push — the orchestrator will push and update the PR.
7. As your FINAL message, output a concise summary (3-6 bullet points) covering WHAT was failing, the ROOT CAUSE you found, and HOW you fixed it. This summary is posted verbatim to the task tracker for human reviewers, so make it self-contained and skip any preamble.

## Constraints
- Make minimal, surgical changes. Do not refactor unrelated code.
- If you cannot determine a fix from the information given, exit without committing — the orchestrator will escalate to a human.
- You have full shell access — run tests or checks if that helps you validate the fix.`;
  }

  /** Find the most recent AI Code Review *failure* comment (the one carrying the
   *  findings to act on). These are bot comments — excluded from devComments —
   *  so review-fix mode pulls them back out here. A "passed" review comment is
   *  ignored (it has no findings to fix). */
  private findLatestReviewFindings(comments: any[]): { id: string; text: string } | null {
    for (let i = comments.length - 1; i >= 0; i--) {
      const text = extractCommentText(comments[i]).trim();
      const lower = text.toLowerCase();
      if (!lower.includes(CODE_REVIEW_MARKER)) continue;
      // The findings comment is the failing one — formatReviewComment renders a
      // "❌ … N issue(s) found" header. Skip the "✅ … Passed" variant.
      if (lower.includes('issue(s) found') || lower.includes('❌')) {
        return { id: comments[i].id, text };
      }
    }
    return null;
  }

  /** Prompt for REVIEW-FIX mode — resolve the AI Code Review's findings on the
   *  PR. Frames the work as addressing reviewer feedback (not a QC regression or
   *  a fresh build), and is explicit that the change goes back through review. */
  private buildReviewFixPrompt(ctx: {
    taskName: string;
    customId?: string;
    iteration: number;
    maxIterations: number;
    reviewFindings: string;
    devComments: string[];
    priorBotAttempts: string[];
  }): string {
    const priorSection = ctx.priorBotAttempts.length > 0
      ? `\n## Previous Auto Code Attempts\nYou have already made the following changes. Don't repeat an approach that didn't satisfy the reviewer — address the remaining findings at their root.\n\n${ctx.priorBotAttempts.map((p, i) => `### Attempt ${i + 1}\n${p}`).join('\n\n')}\n`
      : '';

    const contextSection = ctx.devComments.length > 0
      ? `\n## Additional Context from Task Comments\n${ctx.devComments.join('\n\n')}\n`
      : '';

    return `You are an autonomous coding agent working in an isolated git worktree that already holds an open PR. An automated Code Review FAILED on that PR. Address every finding so the re-review passes, then produce a commit.

## Task
${ctx.customId ? `ID: ${ctx.customId}\n` : ''}Title: ${ctx.taskName}
Review-fix attempt: ${ctx.iteration} of ${ctx.maxIterations}

## Code Review Findings (what FAILED — resolve all of these)
${ctx.reviewFindings || '(The findings comment was empty — inspect the PR review comments with `gh pr view` / `gh pr diff` and resolve anything flagged.)'}
${contextSection}${priorSection}
## Instructions
1. Read every finding above carefully. Each names a file/line and explains what's wrong.
2. Inspect the current code (\`gh pr diff\`, \`git log\`, read the referenced source files) to confirm the root cause.
3. Fix EVERY finding — critical and major issues are mandatory; resolve minor/suggestions too unless doing so would expand scope or risk a regression.
4. Do not introduce new issues. Keep changes minimal and focused on what the review flagged.
5. Commit your changes with a clear message describing which findings you resolved.
6. DO NOT push — the orchestrator pushes the update and hands the PR back to Code Review for re-verification.
7. As your FINAL message, output a concise summary (3-6 bullets) mapping each finding to how you resolved it. This is posted verbatim for reviewers, so make it self-contained and skip any preamble.

## Constraints
- Address the reviewer's findings — don't refactor unrelated code.
- If a finding is a false positive (the code is actually correct), say so explicitly in your summary with a short justification instead of changing it.
- If you genuinely cannot resolve the findings from the information given, exit WITHOUT committing — the orchestrator will escalate to a human.
- You have full shell access — run builds/tests/checks to validate your work.`;
  }

  /** Download images embedded in a QC comment into the worktree so Claude can
   *  read them as vision inputs via the `@<relpath>` syntax. Returns the list
   *  of relative paths (relative to the worktree root) that were successfully
   *  saved — failed downloads are skipped silently so a flaky CDN can't block
   *  the entire fix attempt. */
  private async downloadCommentImages(
    commentId: string,
    images: CommentImage[],
    worktreeDir: string,
  ): Promise<string[]> {
    if (!images || images.length === 0) return [];
    const relDir = `.qc-images/${commentId}`;
    const absDir = join(worktreeDir, relDir);
    try { mkdirSync(absDir, { recursive: true }); } catch { /* will fail on write below */ }
    // Mark .qc-images/ as locally-excluded so commitStragglers' `git add -A`
    // doesn't drag the screenshots into the auto-code commit. info/exclude is
    // per-worktree and never committed, so it's the right place for this.
    await this.markExcluded(worktreeDir, '.qc-images/');
    const saved: string[] = [];
    await Promise.all(
      images.map(async (img, idx) => {
        const ext = (img.extension || 'png').replace(/^\./, '');
        const baseName = `${idx + 1}.${ext}`;
        const dest = join(absDir, baseName);
        try {
          await downloadToFile(img.url, dest);
          // Normalize to forward slashes — `@path` lookups work with either,
          // but logs and prompts read cleaner with /.
          saved.push(`${relDir}/${baseName}`);
        } catch (err) {
          this.emitLog({
            message: `Failed to download QC screenshot ${img.name} from comment ${commentId}: ${err instanceof Error ? err.message : String(err)}`,
            level: 'warn',
          });
        }
      }),
    );
    return saved;
  }

  /** Append a pattern to the worktree's local `.git/info/exclude` (idempotent).
   *  Local-only — doesn't touch the project's tracked `.gitignore`. */
  private async markExcluded(worktreeDir: string, pattern: string): Promise<void> {
    const excludePath = await this.safeGitCmd('git rev-parse --git-path info/exclude', worktreeDir);
    if (!excludePath) return;
    const abs = excludePath.startsWith('/') || /^[A-Za-z]:/.test(excludePath)
      ? excludePath
      : join(worktreeDir, excludePath);
    try {
      const { readFileSync, appendFileSync } = await import('fs');
      let current = '';
      try { current = readFileSync(abs, 'utf-8'); } catch { /* file may not exist */ }
      if (!current.split(/\r?\n/).some((line) => line.trim() === pattern)) {
        appendFileSync(abs, (current && !current.endsWith('\n') ? '\n' : '') + pattern + '\n');
      }
    } catch (err) {
      this.emitLog({
        message: `Could not update worktree exclude file: ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
    }
  }

  /** Resolve the worktree for this dispatch, returning the dir + branch that
   *  were actually used (they may differ from the requested ones — see the
   *  base-mismatch handling below). The caller MUST use the returned values for
   *  push / PR / persistence. */
  private async ensureWorktree(
    projectPath: string,
    worktreeDir: string,
    branch: string,
    taskBaseBranch?: string,
  ): Promise<{ worktreeDir: string; branch: string }> {
    // Mutable: a base mismatch with un-disposable work switches these to a
    // fresh unique name so we open a new PR instead of clobbering or reusing.
    let dir = worktreeDir;
    let br = branch;

    if (existsSync(dir)) {
      // Sanity-check the existing worktree was actually forked from the
      // task's chosen base. When a worktree was created earlier from
      // origin/HEAD (e.g. via `claude --worktree` directly, or a pre-1.24.2
      // TerminalView path) the orchestrator would otherwise push a PR full
      // of unrelated commits from the wrong base — see DP2-24681.
      let mustRecreate = false;
      let useFresh = false;
      if (taskBaseBranch && taskBaseBranch.trim()) {
        const base = taskBaseBranch.trim();
        // Refresh the base from origin so the merge-base check uses the
        // latest tip — ignore failures (offline, branch is local-only).
        try { await execFileCmd('git', ['fetch', 'origin', base], dir, NETWORK_TIMEOUT); } catch { /* noop */ }
        // Only run the ancestor check if the base ref actually resolves —
        // otherwise we'd false-positive on local-only or deleted branches.
        const baseResolves = await this.safeExecFile(
          'git', ['rev-parse', '--verify', `${base}^{commit}`],
          dir,
        );
        if (baseResolves !== null) {
          const baseIsAncestor = await this.safeExecFile(
            'git', ['merge-base', '--is-ancestor', base, 'HEAD'],
            dir,
          );
          // safeExecFile returns '' on success, null on non-zero exit.
          // Non-zero → base is NOT reachable from HEAD → worktree was forked elsewhere
          // (e.g. an interactive `claude --worktree` run created it from origin/HEAD).
          if (baseIsAncestor === null) {
            if (await this.worktreeIsDisposable(dir, br)) {
              // No work to lose → delete and recreate from the correct base.
              this.emitLog({
                message: `Worktree "${br}" was forked from the wrong base — recreating from "${base}" (no local work to lose)`,
                level: 'warn',
              });
              mustRecreate = true;
            } else {
              // Has uncommitted/unpushed work → DON'T touch it and DON'T
              // escalate. Branch off the correct base under a fresh, unique
              // name and open a new PR there; the stale worktree is left intact
              // for a human to inspect.
              const fresh = await this.pickFreshWorktree(projectPath, dir);
              this.emitLog({
                message: `Worktree "${br}" was forked from the wrong base and has local work — leaving it intact and creating a fresh worktree "${fresh.branch}" from "${base}" for a new PR`,
                level: 'warn',
              });
              dir = fresh.worktreeDir;
              br = fresh.branch;
              useFresh = true;
            }
          }
        }
      }
      // Reusing the existing (correct-base) worktree — just fast-forward it.
      if (!mustRecreate && !useFresh) {
        try {
          await runCmd(`git pull --ff-only`, dir, NETWORK_TIMEOUT);
        } catch { /* non-critical */ }
        return { worktreeDir: dir, branch: br };
      }
      // Disposable + wrong base → tear down and fall through to recreation.
      // (Fresh-name path skips this: the old worktree is intentionally kept.)
      if (mustRecreate) {
        try { await execFileCmd('git', ['worktree', 'remove', '--force', dir], projectPath, 5_000); } catch { /* noop */ }
        try { await runCmd('git worktree prune --expire=now', projectPath, 5_000); } catch { /* noop */ }
        try { await execFileCmd('git', ['branch', '-D', br], projectPath, 5_000); } catch { /* noop */ }
      }
    }

    try { await runCmd('git worktree prune', projectPath, 5_000); } catch { /* noop */ }

    mkdirSync(join(projectPath, '.claude', 'worktrees'), { recursive: true });

    // Pick the base ref:
    //  1. Per-task baseBranch (chosen by the user when importing the task)
    //  2. origin/HEAD — matches `claude --worktree <name>`
    //  3. local HEAD — for projects with no remote
    let baseRef = 'HEAD';
    if (taskBaseBranch && taskBaseBranch.trim()) {
      baseRef = taskBaseBranch.trim();
    } else {
      try {
        const ref = await runCmd('git symbolic-ref refs/remotes/origin/HEAD --short', projectPath, 5_000);
        if (ref) baseRef = ref;
      } catch { /* no remote / HEAD not set — fall back to HEAD */ }
    }

    try {
      await execFileCmd('git', ['worktree', 'add', dir, '-b', br, baseRef], projectPath);
    } catch {
      // Stale worktree record (dir deleted manually) and/or stale branch — clear both before retrying
      try { await execFileCmd('git', ['worktree', 'remove', '--force', dir], projectPath, 5_000); } catch { /* noop */ }
      try { await runCmd('git worktree prune --expire=now', projectPath, 5_000); } catch { /* noop */ }
      try { await execFileCmd('git', ['branch', '-D', br], projectPath, 5_000); } catch { /* noop */ }
      await execFileCmd('git', ['worktree', 'add', dir, '-b', br, baseRef], projectPath);
    }

    try {
      const src = join(projectPath, '.claude');
      if (existsSync(src)) {
        const dest = join(dir, '.claude');
        mkdirSync(dest, { recursive: true });
        // Exclude .claude/worktrees/ from the copy — the worktree dir IS
        // inside that path and copying recursively would nest it inside
        // itself. We only need the config (settings, skills, plugins, etc).
        cpSync(src, dest, {
          recursive: true,
          filter: (s) => !s.replace(/\\/g, '/').includes('/.claude/worktrees'),
        });
      }
    } catch { /* non-critical */ }

    return { worktreeDir: dir, branch: br };
  }

  /** Find a free `<id>-N` worktree dir + `worktree-<id>-N` branch (N≥2) next to
   *  the given worktree dir — neither the directory nor the branch may already
   *  exist. Used when a base-mismatched worktree holds work we won't disturb, so
   *  the current run gets a clean isolated worktree (and its own PR) instead. */
  private async pickFreshWorktree(
    projectPath: string,
    currentDir: string,
  ): Promise<{ worktreeDir: string; branch: string }> {
    const parent = dirname(currentDir);
    const baseId = basename(currentDir);
    for (let n = 2; n < 100; n++) {
      const id = `${baseId}-${n}`;
      const candidateDir = join(parent, id);
      const candidateBranch = `worktree-${id}`;
      if (existsSync(candidateDir)) continue;
      const branchExists = await this.safeExecFile(
        'git', ['rev-parse', '--verify', `refs/heads/${candidateBranch}`],
        projectPath,
      );
      if (branchExists !== null) continue; // branch already exists
      return { worktreeDir: candidateDir, branch: candidateBranch };
    }
    // Pathological fallback (100 collisions) — timestamp guarantees uniqueness.
    const id = `${baseId}-${Date.now()}`;
    return { worktreeDir: join(parent, id), branch: `worktree-${id}` };
  }

  private async commitStragglers(cwd: string, message: string): Promise<void> {
    try {
      const status = await runCmd('git status --porcelain', cwd, 5_000);
      if (!status.trim()) return;

      await execFileCmd('git', ['add', '-A'], cwd);
      // argv-based — the message is passed as a single argument, never parsed
      // by a shell, so task-derived text can't inject commands.
      await execFileCmd('git', ['commit', '-m', message], cwd);
    } catch (err) {
      this.emitLog({
        message: `commitStragglers failed: ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
    }
  }

  private async resolvePR(
    projectPath: string,
    branch: string,
    taskName: string,
    taskIdentifier: string,
    baseBranch?: string,
  ): Promise<{ number: number; url: string } | null> {
    try {
      const existing = await execFileCmd(
        'gh', ['pr', 'view', branch, '--json', 'number,url,state'],
        projectPath,
        NETWORK_TIMEOUT,
      );
      const info = JSON.parse(existing);
      if ((info.state || '').toUpperCase() === 'OPEN') {
        return { number: info.number, url: info.url };
      }
    } catch { /* PR doesn't exist yet */ }

    try {
      // Title is task-derived (ClickUp name) — passed as a single argv element
      // via execFile, so it's never parsed by a shell. No escaping needed.
      const title = `Auto Code: ${taskIdentifier} — ${taskName}`.slice(0, 120);
      const body = `Automated change for ClickUp task \`${taskIdentifier}\`.\n\nThis PR was opened by the Auto Code Loop. It will be updated with additional commits on subsequent iterations if QC reports further failures.\n\n${BOT_FIX_MARKER}`;
      const bodyFile = join(tmpdir(), `auto-code-body-${Date.now()}.md`);
      writeFileSync(bodyFile, body, 'utf-8');
      // Without --base, gh defaults to the repo's default branch — wrong when
      // the task was forked from a different base (e.g. Develop).
      const args = ['pr', 'create', '--head', branch, '--title', title, '--body-file', bodyFile];
      if (baseBranch && baseBranch.trim()) args.splice(2, 0, '--base', baseBranch.trim());
      let url: string;
      try {
        url = await execFileCmd('gh', args, projectPath, NETWORK_TIMEOUT);
      } finally {
        try { unlinkSync(bodyFile); } catch { /* noop */ }
      }
      const match = url.match(/\/pull\/(\d+)/);
      const number = match ? parseInt(match[1], 10) : 0;
      return { number, url };
    } catch (err) {
      this.emitLog({
        message: `Failed to create PR for ${branch}: ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
      return null;
    }
  }

  /** Collect a factual record of what the run changed: the list of files
   *  touched (with +/- churn) and the commit subjects between headBefore and
   *  headAfter. Deterministic — always accurate even when the agent's prose
   *  summary is thin. Both lists are best-effort (empty on git failure). */
  private async summarizeChanges(
    worktreeDir: string,
    headBefore: string | null,
    headAfter: string | null,
  ): Promise<{ files: string[]; commits: string[] }> {
    if (!headBefore || !headAfter || headBefore === headAfter) {
      return { files: [], commits: [] };
    }
    const range = `${headBefore}..${headAfter}`;
    const filesRaw = await this.safeGitCmd(`git diff --stat ${headBefore} ${headAfter}`, worktreeDir);
    const commitsRaw = await this.safeGitCmd(`git log --format=%s ${range}`, worktreeDir);
    // Drop git's trailing "N files changed, …" summary line from --stat; keep
    // the per-file rows, trimmed.
    const files = (filesRaw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.includes('|'));
    const commits = (commitsRaw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return { files, commits };
  }

  /** Build the "completed" ClickUp comment: what was done, how (agent summary),
   *  the concrete files + commits, and the PR/commit/status footer. Designed so
   *  a reviewer reading ClickUp alone understands the change without opening
   *  the diff. */
  private formatCompletionComment(ctx: {
    mode: AutoCodeMode;
    iteration: number;
    maxIterations: number;
    qcFeedback?: string;
    agentSummary?: string;
    changedFiles: string[];
    commits: string[];
    shortSha: string;
    prUrl?: string;
    branch: string;
    retestStatus: string;
  }): string {
    const header =
      ctx.mode === 'implement'
        ? `✨ **Auto Code — Implemented**`
        : ctx.mode === 'review-fix'
          ? `🔍 **Auto Code — Review Fix Attempt ${ctx.iteration}/${ctx.maxIterations}**`
          : `🔧 **Auto Code — Fix Attempt ${ctx.iteration}/${ctx.maxIterations}**`;
    const lines: string[] = [header, ``];

    if (ctx.mode === 'review-fix') {
      lines.push(`Addressed the automated Code Review findings — handing the PR back for re-review.`, ``);
      if (ctx.qcFeedback) {
        const fb = ctx.qcFeedback.slice(0, 200);
        lines.push(`**Resolving review findings:** _"${fb}${ctx.qcFeedback.length > 200 ? '…' : ''}"_`, ``);
      }
    } else if (ctx.mode === 'fix' && ctx.qcFeedback) {
      const fb = ctx.qcFeedback.slice(0, 200);
      lines.push(`**Addressing QC feedback:** _"${fb}${ctx.qcFeedback.length > 200 ? '…' : ''}"_`, ``);
    } else if (ctx.mode === 'implement') {
      lines.push(`Implemented from the task description.`, ``);
    }

    // What & how — the agent's own summary of the change (capped).
    if (ctx.agentSummary && ctx.agentSummary.trim()) {
      const summary = ctx.agentSummary.trim();
      const capped = summary.length > 1500 ? summary.slice(0, 1500) + '…' : summary;
      lines.push(`**What changed & how:**`, ``, capped, ``);
    }

    // Concrete commits (the agent's commit messages describe each step).
    if (ctx.commits.length > 0) {
      lines.push(`**Commits:**`);
      for (const c of ctx.commits.slice(0, 10)) lines.push(`- ${c}`);
      if (ctx.commits.length > 10) lines.push(`- …and ${ctx.commits.length - 10} more`);
      lines.push(``);
    }

    // Concrete files touched.
    if (ctx.changedFiles.length > 0) {
      lines.push(`**Files changed (${ctx.changedFiles.length}):**`);
      lines.push('```');
      for (const f of ctx.changedFiles.slice(0, 25)) lines.push(f);
      if (ctx.changedFiles.length > 25) lines.push(`…and ${ctx.changedFiles.length - 25} more`);
      lines.push('```');
      lines.push(``);
    }

    lines.push(
      `- Commit: \`${ctx.shortSha}\``,
      ctx.prUrl ? `- PR: ${ctx.prUrl}` : `- PR: (branch \`${ctx.branch}\` pushed — open a PR if one doesn't exist)`,
      `- Status flipped to \`${ctx.retestStatus}\` for review`,
      ``,
      BOT_FIX_MARKER,
    );
    return lines.join('\n');
  }

  /** Run the fix/implement agent headlessly and return its raw stdout. Launched
   *  with jsonOutput so the caller can recover the session id (to resume later)
   *  and the agent's final summary for the ClickUp comment. */
  private async runAgentFix(
    prompt: string,
    cwd: string,
    providerId: AgentProviderId,
    model?: string,
  ): Promise<string> {
    return this.runAgentHeadless(prompt, cwd, providerId, model, FIX_TIMEOUT_MS, true);
  }

  /** Spawn an agent in single-shot headless mode, pipe `prompt` to stdin, and
   *  resolve with its stdout. Used both for the fix run (output ignored) and
   *  the review gate (output parsed). Validates the model against shell
   *  injection and rejects agents without a headless mode. */
  private runAgentHeadless(
    prompt: string,
    cwd: string,
    providerId: AgentProviderId,
    model?: string,
    timeoutMs: number = FIX_TIMEOUT_MS,
    jsonOutput = false,
  ): Promise<string> {
    const agent = agentRegistry.get(providerId);
    if (!agent || !agent.isAvailable()) {
      return Promise.reject(
        new Error(`${agent?.displayName || providerId} CLI is not installed`),
      );
    }

    // SECURITY: `model` is user-controlled (KanbanTask.autoCodeModel) and gets
    // interpolated into argv that runs under `shell: true` below. Validate it
    // strictly before it can reach the shell. Must start alphanumeric (blocks
    // leading-`-` flag smuggling) and contain only model-id characters; this
    // rejects shell metacharacters (; | & $ ` etc.) outright.
    if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
      return Promise.reject(
        new Error(`Invalid auto-code model "${model}" — refusing to run`),
      );
    }

    // Headless mode is opt-in per provider. Agents without it (copilot, qwen,
    // aider, …) can't run the unattended fix loop — escalate with a clear msg
    // rather than spawning an interactive CLI that would hang on stdin.
    const args = agent.buildHeadlessArgs?.({ model, cwd, jsonOutput });
    if (!args) {
      return Promise.reject(
        new Error(
          `${agent.displayName} does not support headless auto-code runs — ` +
          `choose a different agent for this task (e.g. Claude Code or Gemini CLI)`,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      // Claude refuses to nest inside another Claude session; harmless for
      // other agents, so we always strip it.
      delete env.CLAUDECODE;

      // shell:true is required so Windows can resolve PATH-installed CLI shims
      // (`claude`/`gemini` are .cmd wrappers that won't spawn without a shell).
      // Injection surface is contained: `agent.command` comes from the trusted
      // built-in registry, `model` is strictly validated above, the prompt goes
      // via stdin (never argv), and the only interpolated arg is the local
      // worktree `cwd` (operator-controlled, not remote/task-derived).
      const child = spawn(agent.command, args, {
        env,
        cwd,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin?.write(prompt);
      child.stdin?.end();

      let settled = false;
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* noop */ }
        reject(new Error(`${agent.displayName} run timed out`));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr.trim().slice(0, 500) || `${agent.displayName} exited with code ${code}`));
          return;
        }
        resolve(stdout);
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Pick a reviewer agent distinct from the fixer when possible, so the gate
   *  is a genuine second pair of eyes. Falls back to the fixer's provider if no
   *  other headless-capable agent is installed. */
  private pickReviewer(fixerId: AgentProviderId): AgentProviderId {
    const others = agentRegistry
      .getAll()
      .filter((a) => a.id !== fixerId && a.capabilities.headless && a.isAvailable());
    return others.length > 0 ? others[0].id : fixerId;
  }

  /** Second-agent review gate. Reviews the fix diff (headBefore..headAfter)
   *  with a different agent and returns a verdict. A `pass: false` result —
   *  or any 'critical' finding — should hold the task back from QC. Returns
   *  null if the review couldn't run (we then fail open and proceed to QC). */
  private async reviewFixDiff(
    cwd: string,
    headBefore: string,
    headAfter: string,
    taskName: string,
    fixerId: AgentProviderId,
  ): Promise<{ pass: boolean; findings: CodeReviewFinding[] } | null> {
    const diff = await this.safeGitCmd(`git diff ${headBefore} ${headAfter}`, cwd);
    if (!diff || !diff.trim()) return null;

    const reviewerId = this.pickReviewer(fixerId);
    // Cap the diff so an enormous change set doesn't blow the prompt.
    const clippedDiff = diff.length > 60_000 ? diff.slice(0, 60_000) + '\n…(diff truncated)…' : diff;

    const prompt = `You are a senior engineer reviewing an automated bug-fix BEFORE it goes to QC.
Task: ${taskName}

Review the unified diff below. Look ONLY for correctness regressions, security issues, and obvious bugs introduced by THIS change — not style nits. Be strict about anything that would fail QC or break production.

Respond with STRICT JSON and nothing else, in this exact shape:
{"pass": boolean, "findings": [{"severity": "critical"|"major"|"minor"|"suggestion", "file": string, "line": number, "description": string, "suggestion": string}]}
Set "pass" to false if there is any critical issue. Keep findings concise.

\`\`\`diff
${clippedDiff}
\`\`\``;

    let raw: string;
    try {
      raw = await this.runAgentHeadless(prompt, cwd, reviewerId, undefined, REVIEW_TIMEOUT_MS);
    } catch (err) {
      this.emitLog({
        message: `Review gate could not run (${err instanceof Error ? err.message : String(err)}) — proceeding to QC`,
        level: 'warn',
      });
      return null;
    }

    const parsed = this.parseReviewJSON(raw);
    if (!parsed) {
      this.emitLog({ message: 'Review gate returned unparseable output — proceeding to QC', level: 'warn' });
      return null;
    }
    return parsed;
  }

  /** Best-effort extraction of the review verdict JSON from agent stdout. */
  private parseReviewJSON(raw: string): { pass: boolean; findings: CodeReviewFinding[] } | null {
    const tryParse = (s: string): { pass: boolean; findings: CodeReviewFinding[] } | null => {
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj.pass === 'boolean') {
          return { pass: obj.pass, findings: Array.isArray(obj.findings) ? obj.findings : [] };
        }
      } catch { /* not JSON */ }
      return null;
    };
    const trimmed = raw.trim();
    const direct = tryParse(trimmed);
    if (direct) return direct;
    // Pull the largest {...} block out of surrounding prose / code fences.
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return tryParse(trimmed.slice(first, last + 1));
    }
    return null;
  }

  /** Render a review-gate rejection as a ClickUp comment. Carries the bot
   *  escalation marker so the orchestrator won't treat it as new QC feedback. */
  private formatReviewRejection(iteration: number, findings: CodeReviewFinding[]): string {
    const order = { critical: 0, major: 1, minor: 2, suggestion: 3 } as const;
    const sorted = [...findings].sort(
      (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9),
    );
    const lines = [
      `🛑 **Auto Code Review Gate — Attempt ${iteration} held back**`,
      ``,
      `A reviewing agent flagged issues in the fix diff, so it was NOT sent to QC. Re-queue after a human takes a look.`,
      ``,
    ];
    for (const f of sorted.slice(0, 15)) {
      const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      lines.push(`- **[${f.severity}]** ${loc} ${f.description}${f.suggestion ? ` — _${f.suggestion}_` : ''}`);
    }
    lines.push('', BOT_ESCALATION_MARKER);
    return lines.join('\n');
  }

  private async safeGitCmd(command: string, cwd: string): Promise<string | null> {
    try {
      return await runCmd(command, cwd, 5_000);
    } catch {
      return null;
    }
  }

  /** Like safeGitCmd but argv-based (no shell). Returns '' / stdout on success,
   *  null on a non-zero exit — same contract callers rely on. */
  private async safeExecFile(file: string, args: string[], cwd: string): Promise<string | null> {
    try {
      return await execFileCmd(file, args, cwd, 5_000);
    } catch {
      return null;
    }
  }

  /** True only when a worktree can be deleted without losing work — used to
   *  decide whether a wrong-base worktree may be auto-recreated. Disposable
   *  means: clean working tree, the branch hasn't been pushed (no remote branch
   *  that might back a PR), and no commits exist only locally. Any check that
   *  can't be verified errs toward NOT disposable so we never destroy work. */
  private async worktreeIsDisposable(worktreeDir: string, branch: string): Promise<boolean> {
    // Uncommitted changes → keep it.
    const dirty = await this.safeExecFile('git', ['status', '--porcelain'], worktreeDir);
    if (dirty === null || dirty.trim() !== '') return false;
    // Branch already pushed → it may back an open PR; keep it.
    const pushed = await this.safeExecFile('git', ['ls-remote', '--heads', 'origin', branch], worktreeDir);
    if (pushed === null || pushed.trim() !== '') return false;
    // Commits that live only in this worktree (on no remote) → real work; keep it.
    const localOnly = await this.safeExecFile('git', ['rev-list', '--count', 'HEAD', '--not', '--remotes'], worktreeDir);
    return localOnly !== null && localOnly.trim() === '0';
  }

  // ─── Persistence / events ────────────────────────────────────

  /** Update a KanbanTask record AND emit a task-updated event to the renderer. */
  private patch(kanbanTaskId: string, patch: Partial<KanbanTask>): KanbanTask | null {
    const next = updateKanbanTask(kanbanTaskId, patch);
    if (next) broadcastKanbanEvent({ type: 'task-updated', task: next });
    return next;
  }

  private emitEvent(event: AutoCodeEvent): void {
    const win = this.getWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.AUTO_CODE_EVENT, event);
    }
  }

  private emitStatus(): void {
    this.emitEvent({ type: 'status', payload: this.getStatus() });
  }

  /** Record a cross-project activity event scoped to a task (drives the
   *  Activity feed + OS notifications). Pulls project/task context off the
   *  KanbanTask so the feed row can deep-link. Never throws. */
  private activity(
    task: KanbanTask,
    kind: string,
    level: ActivityLevel,
    title: string,
    message?: string,
    url?: string,
  ): void {
    recordActivity({
      source: 'auto-code',
      kind,
      level,
      title,
      message,
      url: url || task.prUrl || task.clickupUrl,
      projectPath: task.projectPath,
      taskId: task.id,
      clickupTaskId: task.clickupTaskId,
      taskName: task.clickupName,
    });
  }

  private emitLog(payload: { taskId?: string; message: string; level: 'info' | 'warn' | 'error' }): void {
    const line = `[AutoCode${payload.taskId ? `:${payload.taskId}` : ''}] ${payload.message}`;
    if (payload.level === 'error') debugError(line);
    else debugLog(line);
    this.emitEvent({ type: 'log', ...payload });
  }
}

export const autoCodeOrchestrator = new AutoCodeOrchestrator();
export type AutoCodeOrchestratorInstance = typeof autoCodeOrchestrator;

// Keep the AutoCodeTaskState export so shared types importers still compile
export type { AutoCodeTaskState };
