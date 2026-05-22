import type { BrowserWindow } from 'electron';
import { exec, spawn } from 'child_process';
import { existsSync, mkdirSync, cpSync, writeFileSync, unlinkSync, createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { URL } from 'url';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog, debugError } from '../../shared/utils';
import { getSettings } from '../ipc/settings-handlers';
import { ClickUpProvider } from '../ipc/providers/clickup';
import { agentRegistry } from '../ipc/providers/agent-registry';
import type { KanbanTask, AutoFixTaskState } from '../../shared/types';
import {
  listKanbanTasks,
  getKanbanTask,
  updateKanbanTask,
} from '../kanban/kanban-task-store';
import { broadcastKanbanEvent } from '../ipc/kanban-handlers';
import { mapClickupStatusToKanban } from '../../shared/kanban-status-mapper';

const GIT_TIMEOUT = 30_000;
const NETWORK_TIMEOUT = 60_000;
const FIX_TIMEOUT_MS = 20 * 60_000;
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

/** Stream a remote file to disk. Follows up to 3 redirects (ClickUp's CDN can
 *  308-redirect to a signed location). Resolves on 2xx, rejects otherwise. */
function downloadToFile(url: string, destPath: string, hops = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch (err) { reject(err); return; }
    const transport = parsed.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = transport(parsed, { method: 'GET' }, (res) => {
      const status = res.statusCode || 0;
      if ((status === 301 || status === 302 || status === 307 || status === 308) && res.headers.location && hops > 0) {
        res.resume();
        const next = new URL(res.headers.location, parsed).toString();
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

export interface AutoFixStatusPayload {
  active: boolean;
  running: boolean;
  lastRun: string | null;
  nextRun: string | null;
  intervalMinutes: number;
  maxIterations: number;
}

export type AutoFixEvent =
  | { type: 'status'; payload: AutoFixStatusPayload }
  | { type: 'cycle-start'; at: string }
  | { type: 'cycle-end'; at: string; processed: number; errors: number }
  | { type: 'log'; taskId?: string; message: string; level: 'info' | 'warn' | 'error' };

const clickUpProvider = new ClickUpProvider();

class AutoFixOrchestrator {
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;
  private lastRun: string | null = null;
  private nextRun: string | null = null;
  private intervalMs = 30 * 60_000;
  private getWindow: (() => BrowserWindow | null) | null = null;

  init(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow;
  }

  getStatus(): AutoFixStatusPayload {
    const settings = getSettings();
    return {
      active: this.intervalHandle !== null,
      running: this.running,
      lastRun: this.lastRun,
      nextRun: this.nextRun,
      intervalMinutes: settings.autoFixPollIntervalMinutes || 30,
      maxIterations: settings.autoFixMaxIterations || 3,
    };
  }

  start(): void {
    const settings = getSettings();
    if (!settings.autoFixEnabled) {
      debugLog('[AutoFix] Not starting — master switch is off');
      return;
    }

    const minutes = Math.max(1, settings.autoFixPollIntervalMinutes || 30);
    this.intervalMs = minutes * 60_000;

    this.stop();

    this.nextRun = new Date(Date.now() + this.intervalMs).toISOString();
    debugLog(`[AutoFix] Starting orchestrator, interval = ${minutes}m, next run at ${this.nextRun}`);

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
    debugLog('[AutoFix] Orchestrator stopped');
    this.emitStatus();
  }

  async runNow(): Promise<void> {
    await this.runCycle();
  }

  /** Reset a Kanban task's iteration count and return it to the failed queue */
  requeueTask(kanbanTaskId: string): KanbanTask | null {
    const updated = this.patch(kanbanTaskId, {
      iterationCount: 0,
      autoFixState: 'idle',
      lastError: null,
    });
    if (updated) {
      this.emitLog({ taskId: kanbanTaskId, message: 'Task re-queued — iteration count reset', level: 'info' });
    }
    return updated;
  }

  private async runCycle(): Promise<void> {
    if (this.running) {
      debugLog('[AutoFix] Skipping cycle — previous cycle still running');
      return;
    }

    const settings = getSettings();
    if (!settings.autoFixEnabled) return;
    if (settings.taskManagerProvider !== 'clickup') return;

    const all = listKanbanTasks();
    if (all.length === 0) {
      debugLog('[AutoFix] No Kanban tasks imported — nothing to do');
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

      processed = await this.handleFailedTasks();
      await this.handleAwaitingQCTasks();
    } catch (err) {
      errors++;
      debugError('[AutoFix] Cycle error:', err);
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
    await Promise.all(
      tasks.map(async (task) => {
        // Local tasks aren't backed by ClickUp.
        if (task.provider === 'local') return;
        try {
          const result = await clickUpProvider.getTask(settings, task.clickupTaskId);
          if (!result.success) return;
          const fresh = result.data;

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
            clickupUpdatedAt: fresh.updatedAt,
          };

          // Auto-map the column when ClickUp status actually changed — only on diff,
          // so we don't overwrite a manual drag that happened between cycles.
          if (fresh.status.name && fresh.status.name !== task.clickupStatus) {
            const mapped = mapClickupStatusToKanban(fresh.status.name, settings);
            if (mapped && mapped !== task.kanbanStatus) {
              snapshotPatch.kanbanStatus = mapped;
            }
          }

          this.patch(task.id, snapshotPatch);
        } catch {
          /* non-critical — we'll try again next cycle */
        }
      }),
    );
  }

  private async handleFailedTasks(): Promise<number> {
    const settings = getSettings();
    const failedStatus = (settings.autoFixFailedStatus || 'failed').toLowerCase();
    const maxIterations = Math.max(1, settings.autoFixMaxIterations || 3);

    // After snapshot refresh, re-read tasks and pick Failed ones
    const all = listKanbanTasks();
    const eligible: KanbanTask[] = [];

    for (const task of all) {
      // Local tasks have no ClickUp QC signal — skip the auto-fix loop.
      if (task.provider === 'local') continue;
      // No-worktree tasks share the project's checked-out branch — auto-fix
      // would clobber whatever the user is working on. Skip them.
      if (task.useWorktree === false) continue;
      if (task.clickupStatus?.toLowerCase() !== failedStatus) continue;

      // Mirror Kanban status to Failed column whenever ClickUp reports Failed
      if (task.kanbanStatus !== 'failed') {
        this.patch(task.id, { kanbanStatus: 'failed' });
      }

      // Respect per-task override (explicit false skips; explicit true runs
      // even if the master is on; null falls back to the global toggle which
      // has already passed the early return above).
      if (task.autoFixOverride === false) {
        this.emitLog({ taskId: task.id, message: 'Auto-fix disabled for this task — skipping', level: 'info' });
        continue;
      }

      if (task.autoFixState === 'escalated') continue;

      const lastActionAge = task.lastFixActionAt ? Date.now() - Date.parse(task.lastFixActionAt) : Infinity;
      if (task.autoFixState === 'fixing' && lastActionAge < STALE_FIXING_MS) {
        this.emitLog({ taskId: task.id, message: 'Already being fixed — skipping this cycle', level: 'info' });
        continue;
      }

      const current = getKanbanTask(task.id);
      if (!current) continue;

      if (current.iterationCount >= maxIterations) {
        await this.escalate(current, maxIterations);
        continue;
      }

      eligible.push(current);
    }

    if (eligible.length === 0) return 0;

    this.emitLog({ message: `Dispatching fix for ${eligible.length} task(s)`, level: 'info' });

    await Promise.all(
      eligible.map(async (task) => {
        try {
          await this.dispatchFix(task.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Fix dispatch failed';
          this.emitLog({ taskId: task.id, message, level: 'error' });
          this.patch(task.id, { lastError: message, autoFixState: 'idle' });
          try {
            await clickUpProvider.postComment(
              getSettings(),
              task.clickupTaskId,
              `⚠️ **Auto-Fix Error** — "${task.clickupName}": ${message}\n\n${BOT_FIX_MARKER}`,
            );
          } catch { /* non-critical */ }
        }
      }),
    );

    return eligible.length;
  }

  private async handleAwaitingQCTasks(): Promise<void> {
    const settings = getSettings();
    const doneStatus = (settings.autoFixDoneStatus || 'done').toLowerCase();

    const tracked = listKanbanTasks().filter(
      (t) =>
        t.provider !== 'local' &&
        t.useWorktree !== false &&
        (t.autoFixState === 'awaiting-qc' || t.autoFixState === 'merging'),
    );

    for (const task of tracked) {
      const currentStatus = (task.clickupStatus || '').toLowerCase();
      if (currentStatus !== doneStatus) continue;

      const shouldMerge = this.resolveAutoMerge(task, settings.autoFixAutoMerge);

      if (task.autoFixState === 'merging') continue; // already queued

      if (!shouldMerge || !task.worktreeBranch) {
        this.patch(task.id, { autoFixState: 'done', kanbanStatus: 'done' });
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
        autoFixState: 'merging',
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
      await runCmd(`gh pr merge "${worktreeBranch}" --auto --squash`, projectPath, NETWORK_TIMEOUT);
      this.emitLog({
        taskId: task.id,
        message: `Auto-merge queued on branch "${worktreeBranch}" — will merge when CI passes`,
        level: 'info',
      });
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
      this.patch(task.id, { autoFixState: 'done', kanbanStatus: 'done', lastError: message.slice(0, 200) });
    }
  }

  private async escalate(task: KanbanTask, cap: number): Promise<void> {
    this.patch(task.id, { autoFixState: 'escalated', kanbanStatus: 'failed' });
    try {
      await clickUpProvider.postComment(
        getSettings(),
        task.clickupTaskId,
        `⚠️ **Auto-Fix Escalated** — ${cap} fix attempts did not resolve QC failures for "${task.clickupName}". This task needs manual review. Once the blocker is cleared, re-queue it from the Kanban Board.\n\n${BOT_ESCALATION_MARKER}`,
      );
    } catch (err) {
      this.emitLog({
        taskId: task.id,
        message: `Failed to post escalation comment: ${err instanceof Error ? err.message : String(err)}`,
        level: 'warn',
      });
    }
    this.emitLog({ taskId: task.id, message: `Escalated after ${cap} iterations`, level: 'warn' });
  }

  // ─── Fix dispatch ────────────────────────────────────────────

  private async dispatchFix(kanbanTaskId: string): Promise<void> {
    const settings = getSettings();
    const task = getKanbanTask(kanbanTaskId);
    if (!task) return;

    const projectPath = task.projectPath;
    if (!projectPath) throw new Error('KanbanTask has no projectPath');

    // 1. Fetch fresh QC comments
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

    if (devComments.length === 0) {
      throw new Error('Task is Failed but has no QC comments to act on');
    }

    const latest = devComments[devComments.length - 1];
    if (task.lastSeenFailureCommentId && task.lastSeenFailureCommentId === latest.id) {
      this.emitLog({
        taskId: task.id,
        message: 'No new failure comment since last fix — waiting for QC re-test',
        level: 'info',
      });
      this.patch(task.id, { autoFixState: 'awaiting-qc', kanbanStatus: 'review' });
      return;
    }

    // 2. Begin fixing
    const iteration = (task.iterationCount || 0) + 1;
    const safeId = sanitizeTaskId(task.clickupCustomId || task.clickupTaskId);
    // Use Claude's native worktree convention so a `claude --worktree <id>`
    // run anywhere reuses this same dir + branch.
    const worktreeDir = join(projectPath, '.claude', 'worktrees', safeId);
    const branch = `worktree-${safeId}`;

    this.patch(task.id, {
      autoFixState: 'fixing',
      kanbanStatus: 'in-progress',
      iterationCount: iteration,
      lastSeenFailureCommentId: latest.id,
      lastError: null,
      lastFixActionAt: new Date().toISOString(),
      worktreeBranch: branch,
      worktreePath: worktreeDir,
    });
    this.emitLog({ taskId: task.id, message: `Fix attempt ${iteration} — starting`, level: 'info' });

    // 3. Resolve worktree — fork from the task's chosen base branch, not the repo default
    await this.ensureWorktree(projectPath, worktreeDir, branch, task.baseBranch);

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
    const prompt = this.buildFixPrompt({
      taskName: task.clickupName,
      customId: task.clickupCustomId,
      iteration,
      maxIterations: settings.autoFixMaxIterations,
      devComments: renderedDevComments,
      priorBotAttempts,
    });

    const headBefore = await this.safeGitCmd('git rev-parse HEAD', worktreeDir);

    // 5. Run Claude
    await this.runClaudeFix(prompt, worktreeDir);

    await this.commitStragglers(worktreeDir, `Auto-fix attempt ${iteration} for ${task.clickupCustomId || task.clickupTaskId}`);

    const headAfter = await this.safeGitCmd('git rev-parse HEAD', worktreeDir);
    const producedChanges = headBefore !== null && headAfter !== null && headBefore !== headAfter;

    if (!producedChanges) {
      this.emitLog({ taskId: task.id, message: 'Claude produced no commits — escalating', level: 'warn' });
      this.patch(task.id, { autoFixState: 'escalated', kanbanStatus: 'failed' });
      try {
        await clickUpProvider.postComment(
          settings,
          task.clickupTaskId,
          `⚠️ **Auto-Fix Unable to Produce a Fix** — Attempt ${iteration} finished without committing any changes. Please clarify the failure and re-queue.\n\n${BOT_ESCALATION_MARKER}`,
        );
      } catch { /* non-critical */ }
      return;
    }

    // 6. Push
    try {
      await runCmd(`git push -u origin ${branch}`, worktreeDir, NETWORK_TIMEOUT);
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

    // 8. ClickUp status flip + comment
    const shortSha = headAfter ? headAfter.substring(0, 7) : 'HEAD';
    const retestStatus = settings.autoFixRetestStatus || 'qc';
    const commentLines = [
      `🔧 **Auto-Fix Attempt ${iteration}/${settings.autoFixMaxIterations}**`,
      ``,
      `Addressed QC feedback: _"${latest.text.slice(0, 200)}${latest.text.length > 200 ? '…' : ''}"_`,
      ``,
      `- Commit: \`${shortSha}\``,
      pr?.url ? `- PR: ${pr.url}` : `- PR: (branch \`${branch}\` pushed — open a PR if one doesn't exist)`,
      `- Status flipped to \`${retestStatus}\` for re-testing`,
      ``,
      BOT_FIX_MARKER,
    ];
    try {
      await clickUpProvider.postComment(settings, task.clickupTaskId, commentLines.join('\n'));
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
      autoFixState: 'awaiting-qc',
      kanbanStatus: 'review',
    });
    this.emitLog({ taskId: task.id, message: `Fix pushed (commit ${shortSha}) — awaiting QC`, level: 'info' });
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private buildFixPrompt(ctx: {
    taskName: string;
    customId?: string;
    iteration: number;
    maxIterations: number;
    devComments: string[];
    priorBotAttempts: string[];
  }): string {
    const priorSection = ctx.priorBotAttempts.length > 0
      ? `\n## Previous Fix Attempts\nYou have already tried the following approaches. Do NOT repeat a fix that did not work — look deeper or reconsider the root cause.\n\n${ctx.priorBotAttempts.map((p, i) => `### Attempt ${i + 1}\n${p}`).join('\n\n')}\n`
      : '';

    return `You are an autonomous fix agent working in an isolated git worktree. Address QC feedback and produce a commit that resolves it.

## Task
${ctx.customId ? `ID: ${ctx.customId}\n` : ''}Title: ${ctx.taskName}
Fix attempt: ${ctx.iteration} of ${ctx.maxIterations}

## QC Failure Comments (chronological)
Each comment may include screenshots saved under \`.qc-images/<commentId>/\`. Their paths are listed in the comment block (e.g. \`@.qc-images/123/1.png\`). Open every screenshot with the Read tool — QC often points at a specific UI state that the text alone doesn't fully describe.

${ctx.devComments.join('\n\n')}
${priorSection}
## Instructions
1. Read every failure comment carefully. The LATEST comment is the current blocker.
2. Use the Read tool to open every screenshot referenced as \`@.qc-images/...\` so you can see what QC actually saw. Don't skip them.
3. Inspect the repository as needed (\`gh pr diff\`, \`git log\`, read source files).
4. Implement a fix that addresses the root cause.
5. Commit your changes with a clear message.
6. DO NOT push — the orchestrator will push and update the PR.

## Constraints
- Make minimal, surgical changes. Do not refactor unrelated code.
- If you cannot determine a fix from the information given, exit without committing — the orchestrator will escalate to a human.
- You have full shell access — run tests or checks if that helps you validate the fix.`;
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
    // doesn't drag the screenshots into the auto-fix commit. info/exclude is
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

  private async ensureWorktree(
    projectPath: string,
    worktreeDir: string,
    branch: string,
    taskBaseBranch?: string,
  ): Promise<void> {
    if (existsSync(worktreeDir)) {
      // Sanity-check the existing worktree was actually forked from the
      // task's chosen base. When a worktree was created earlier from
      // origin/HEAD (e.g. via `claude --worktree` directly, or a pre-1.24.2
      // TerminalView path) the orchestrator would otherwise push a PR full
      // of unrelated commits from the wrong base — see DP2-24681.
      if (taskBaseBranch && taskBaseBranch.trim()) {
        const base = taskBaseBranch.trim();
        // Refresh the base from origin so the merge-base check uses the
        // latest tip — ignore failures (offline, branch is local-only).
        try { await runCmd(`git fetch origin "${base}"`, worktreeDir, NETWORK_TIMEOUT); } catch { /* noop */ }
        // Only run the ancestor check if the base ref actually resolves —
        // otherwise we'd false-positive on local-only or deleted branches.
        const baseResolves = await this.safeGitCmd(
          `git rev-parse --verify "${base}^{commit}"`,
          worktreeDir,
        );
        if (baseResolves !== null) {
          const baseIsAncestor = await this.safeGitCmd(
            `git merge-base --is-ancestor "${base}" HEAD`,
            worktreeDir,
          );
          // safeGitCmd returns '' on success, null on non-zero exit.
          // Non-zero → base is NOT reachable from HEAD → worktree was forked elsewhere.
          if (baseIsAncestor === null) {
            const safeId = branch.replace(/^worktree-/, '');
            throw new Error(
              `Worktree base mismatch — branch "${branch}" was not forked from "${base}". ` +
              `Opening a PR now would include unrelated commits from a different base. ` +
              `Delete .claude/worktrees/${safeId} (and the branch with \`git branch -D ${branch}\`), ` +
              `then re-open the task so the worktree is recreated from "${base}".`,
            );
          }
        }
      }
      try {
        await runCmd(`git pull --ff-only`, worktreeDir, NETWORK_TIMEOUT);
      } catch { /* non-critical */ }
      return;
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
      await runCmd(`git worktree add "${worktreeDir}" -b "${branch}" ${baseRef}`, projectPath);
    } catch {
      // Stale worktree record (dir deleted manually) and/or stale branch — clear both before retrying
      try { await runCmd(`git worktree remove --force "${worktreeDir}"`, projectPath, 5_000); } catch { /* noop */ }
      try { await runCmd('git worktree prune --expire=now', projectPath, 5_000); } catch { /* noop */ }
      try { await runCmd(`git branch -D "${branch}"`, projectPath, 5_000); } catch { /* noop */ }
      await runCmd(`git worktree add "${worktreeDir}" -b "${branch}" ${baseRef}`, projectPath);
    }

    try {
      const src = join(projectPath, '.claude');
      if (existsSync(src)) {
        const dest = join(worktreeDir, '.claude');
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
  }

  private async commitStragglers(cwd: string, message: string): Promise<void> {
    try {
      const status = await runCmd('git status --porcelain', cwd, 5_000);
      if (!status.trim()) return;

      await runCmd('git add -A', cwd);
      const escaped = message.replace(/"/g, '\\"');
      try {
        await runCmd(`git commit -m "${escaped}"`, cwd);
      } catch {
        const tmp = join(tmpdir(), `auto-fix-msg-${Date.now()}.txt`);
        writeFileSync(tmp, message, 'utf-8');
        try {
          await runCmd(`git commit -F "${tmp}"`, cwd);
        } finally {
          try { unlinkSync(tmp); } catch { /* noop */ }
        }
      }
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
      const existing = await runCmd(
        `gh pr view "${branch}" --json number,url,state`,
        projectPath,
        NETWORK_TIMEOUT,
      );
      const info = JSON.parse(existing);
      if ((info.state || '').toUpperCase() === 'OPEN') {
        return { number: info.number, url: info.url };
      }
    } catch { /* PR doesn't exist yet */ }

    try {
      const title = `Auto-Fix: ${taskIdentifier} — ${taskName}`.slice(0, 120);
      const body = `Automated fix for ClickUp task \`${taskIdentifier}\`.\n\nThis PR was opened by the Auto-Fix Loop. It will be updated with additional commits on subsequent iterations if QC reports further failures.\n\n${BOT_FIX_MARKER}`;
      const escapedTitle = title.replace(/"/g, '\\"');
      const bodyFile = join(tmpdir(), `auto-fix-body-${Date.now()}.md`);
      writeFileSync(bodyFile, body, 'utf-8');
      // Without --base, gh defaults to the repo's default branch — wrong when
      // the task was forked from a different base (e.g. Develop).
      const baseFlag = baseBranch && baseBranch.trim() ? `--base "${baseBranch.trim()}" ` : '';
      let url: string;
      try {
        url = await runCmd(
          `gh pr create ${baseFlag}--head "${branch}" --title "${escapedTitle}" --body-file "${bodyFile}"`,
          projectPath,
          NETWORK_TIMEOUT,
        );
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

  private runClaudeFix(prompt: string, cwd: string): Promise<void> {
    const agent = agentRegistry.get('claude');
    if (!agent || !agent.isAvailable()) {
      return Promise.reject(new Error('Claude Code CLI is not installed'));
    }

    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.CLAUDECODE;

      const args = [
        '--output-format', 'text',
        '--model', 'claude-sonnet-4-6',
        '--add-dir', cwd,
        '--dangerously-skip-permissions',
        '-p',
      ];

      const child = spawn('claude', args, {
        env,
        cwd,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin?.write(prompt);
      child.stdin?.end();

      let settled = false;
      let stderr = '';

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGTERM'); } catch { /* noop */ }
        reject(new Error('Claude fix timed out after 20 minutes'));
      }, FIX_TIMEOUT_MS);

      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(stderr.trim().slice(0, 500) || `Claude exited with code ${code}`));
          return;
        }
        resolve();
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async safeGitCmd(command: string, cwd: string): Promise<string | null> {
    try {
      return await runCmd(command, cwd, 5_000);
    } catch {
      return null;
    }
  }

  // ─── Persistence / events ────────────────────────────────────

  /** Update a KanbanTask record AND emit a task-updated event to the renderer. */
  private patch(kanbanTaskId: string, patch: Partial<KanbanTask>): KanbanTask | null {
    const next = updateKanbanTask(kanbanTaskId, patch);
    if (next) broadcastKanbanEvent({ type: 'task-updated', task: next });
    return next;
  }

  private emitEvent(event: AutoFixEvent): void {
    const win = this.getWindow?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.AUTO_FIX_EVENT, event);
    }
  }

  private emitStatus(): void {
    this.emitEvent({ type: 'status', payload: this.getStatus() });
  }

  private emitLog(payload: { taskId?: string; message: string; level: 'info' | 'warn' | 'error' }): void {
    const line = `[AutoFix${payload.taskId ? `:${payload.taskId}` : ''}] ${payload.message}`;
    if (payload.level === 'error') debugError(line);
    else debugLog(line);
    this.emitEvent({ type: 'log', ...payload });
  }
}

export const autoFixOrchestrator = new AutoFixOrchestrator();
export type AutoFixOrchestratorInstance = typeof autoFixOrchestrator;

// Keep the AutoFixTaskState export so shared types importers still compile
export type { AutoFixTaskState };
