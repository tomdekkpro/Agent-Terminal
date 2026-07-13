import type { BrowserWindow, IpcMain } from 'electron';
import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/constants';
import type { DashboardNotice, NoticeSource, TaskManagerTask } from '../../shared/types';
import { getSettings } from './settings-handlers';
import { ClickUpProvider } from './providers/clickup';
import { agentRegistry } from './providers/agent-registry';
import { debugLog, debugError } from '../../shared/utils';
import { recordActivity } from '../activity/activity-store';
import {
  listNotices,
  getNotice,
  saveNotice,
  patchNotice,
  deleteNotice,
  type SaveNoticeInput,
} from '../dashboard/notice-store';

const clickUpProvider = new ClickUpProvider();

const RUN_TIMEOUT_MS = 5 * 60_000;
const MAX_TASK_PAGES = 3; // up to ~300 tasks fed as context

let schedulerInterval: NodeJS.Timeout | null = null;
const runningIds = new Set<string>();

// ─── Helpers ──────────────────────────────────────────────────
function emit(getWindow: () => BrowserWindow | null, event: unknown): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.DASHBOARD_EVENT, event);
  }
}

/**
 * Validate a user-selected project path before it's used as the Claude CLI cwd
 * or `--add-dir`. Because the CLI is spawned with `shell: true` (required for
 * the `claude` shim on Windows), an unvalidated path could smuggle shell
 * metacharacters into the command line. We require an absolute, existing
 * directory with no leading `-` (argv flag smuggling) and no shell
 * metacharacters. Returns the safe path, or undefined when it doesn't qualify.
 */
function safeProjectDir(p?: string): string | undefined {
  if (!p) return undefined;
  const t = p.trim();
  if (!t || t.startsWith('-')) return undefined;
  // Reject shell-significant characters. Legitimate Windows/Unix paths only need
  // letters, digits, space, and these: \ / : . _ - ~ (space is handled by quoting).
  if (/[;&|`$(){}<>"'!\n\r*?]/.test(t)) return undefined;
  try {
    if (!path.isAbsolute(t)) return undefined;
    if (!fs.statSync(t).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return t;
}

/** Quote a (already-validated, metachar-free) path for a shell:true command line. */
function shellQuote(p: string): string {
  return process.platform === 'win32' ? `"${p}"` : `'${p}'`;
}

/**
 * Pre-approve the tools a notice's run may use, scoped to its sources, so the
 * headless `claude -p` run never blocks on a permission prompt. Scoping also
 * limits blast radius: a Web notice gets web tools but NOT Bash, so a malicious
 * page can't trick the agent into running shell commands.
 */
function buildAllowedTools(sources: NoticeSource[]): string[] {
  const tools = new Set<string>(['Read', 'Glob', 'Grep']); // safe read-only baseline
  if (sources.includes('web')) {
    tools.add('WebSearch');
    tools.add('WebFetch');
    tools.add('mcp__playwright'); // allow the Playwright browser MCP server if configured
  }
  if (sources.includes('github')) {
    tools.add('Bash'); // gh / git
  }
  return Array.from(tools);
}

function localHHmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Fetch the user's tasks from ClickUp (best-effort, capped) as a context block. */
async function fetchTaskContext(notice: DashboardNotice): Promise<{ count: number; text: string }> {
  const settings = getSettings();
  if (settings.taskManagerProvider !== 'clickup') return { count: 0, text: '' };

  const listId = notice.listId || settings.kanbanBacklogListId || settings.clickupListId;
  if (!listId) return { count: 0, text: '' };

  const assigneeId = settings.kanbanFilterAssigneeId?.trim();
  const all: TaskManagerTask[] = [];
  try {
    for (let page = 0; page < MAX_TASK_PAGES; page++) {
      const res = await clickUpProvider.searchTasks(
        settings,
        '',
        { includeClosed: false, assignees: assigneeId ? [assigneeId] : undefined },
        listId,
        page,
      );
      if (!res.success) break;
      const tasks = res.data || [];
      all.push(...tasks);
      if (tasks.length < 100) break;
    }
  } catch (err) {
    debugError('[Dashboard] Failed to fetch tasks for notice context:', err);
  }

  if (all.length === 0) return { count: 0, text: '' };

  const lines = all.map((t) => {
    const parts = [
      `- [${t.customId || t.id}] ${t.name}`,
      `status: ${t.status.name || 'none'}`,
    ];
    if (t.priority?.name) parts.push(`priority: ${t.priority.name}`);
    if (t.releaseVersion) parts.push(`release: ${t.releaseVersion}`);
    const who = (t.assignees || []).map((a) => a.username).filter(Boolean).join(', ');
    if (who) parts.push(`assignees: ${who}`);
    const tags = (t.tags || []).map((tg) => tg.name).filter(Boolean).join(', ');
    if (tags) parts.push(`tags: ${tags}`);
    if (t.updatedAt) {
      const ms = Number(t.updatedAt) || Date.parse(t.updatedAt);
      if (ms) parts.push(`updated: ${new Date(ms).toISOString().split('T')[0]}`);
    }
    return parts.join(' | ');
  });

  return { count: all.length, text: lines.join('\n') };
}

function buildPrompt(
  notice: DashboardNotice,
  sources: NoticeSource[],
  ctx: { count: number; text: string },
): string {
  const now = new Date();
  const today = now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const sections: string[] = [];
  if (sources.includes('clickup')) {
    sections.push(ctx.count > 0
      ? `## ClickUp tasks (${ctx.count})\nUse ONLY this data for task info — do not invent tasks.\n${ctx.text}`
      : `## ClickUp\nEnabled, but no tasks were found (not connected or the list is empty).`);
  }
  if (sources.includes('github')) {
    sections.push(notice.projectPath?.trim()
      ? `## GitHub\nYou may run the \`gh\` CLI and read the repository at "${notice.projectPath}" (via Bash) to gather GitHub data — pull requests, issues, commits, CI/checks, diffs.`
      : `## GitHub\nEnabled, but no project was selected, so repository access is limited. Use \`gh\` only if a default repo is configured.`);
  }
  if (sources.includes('web')) {
    const urls = (notice.urls || []).filter((u) => u.trim());
    sections.push(`## Web\nYou may use web search and web fetch tools to consult external sites.${
      urls.length ? `\nRelevant URLs:\n${urls.map((u) => `- ${u}`).join('\n')}` : ''
    }`);
  }

  const ctxBlock = sections.length
    ? `You have access to the following sources:\n\n${sections.join('\n\n')}`
    : `No external data sources are enabled — answer directly from the request and your knowledge.`;

  return `You are a helpful assistant generating a concise briefing for a developer. Today is ${today}.

USER REQUEST:
"${notice.prompt}"

${ctxBlock}

Respond in clear, skimmable GitHub-flavored Markdown:
- Start directly with the content — no preamble like "Here is".
- Use short section headers and bullet lists.
- **Bold** key identifiers (task IDs like **DP2-1234**, PR numbers like **#123**).
- If the request asks to prioritize or filter, do that and add a one-line reason per item.
- If nothing matches, say so plainly in one sentence.`;
}

/** Run the prompt through the Claude CLI, returning Markdown text. */
function runClaude(prompt: string, cwd: string, addDir?: string, allowedTools?: string[]): Promise<string> {
  const agent = agentRegistry.get('claude');
  if (!agent || !agent.isAvailable()) {
    return Promise.reject(
      new Error('Claude Code CLI is not installed. Install with: npm install -g @anthropic-ai/claude-code'),
    );
  }

  return new Promise((resolve, reject) => {
    const args = ['--output-format', 'text', '--model', 'claude-sonnet-4-6', '-p'];
    // addDir is pre-validated (absolute existing dir, no metacharacters); quote
    // it so paths with spaces survive the shell:true command line intact.
    if (addDir) args.push('--add-dir', shellQuote(addDir));
    // Pre-approve tools (comma-separated, no metacharacters) so the run doesn't
    // block on permission prompts in headless mode.
    if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn('claude', args, { env, cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin?.write(prompt);
    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Notice timed out after 5 minutes'));
    }, RUN_TIMEOUT_MS);

    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.on('close', (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const out = stdout.trim();
      if (!out && code !== 0) {
        reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
        return;
      }
      resolve(out || '_No output produced._');
    });
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Run a single notice: gather context, call Claude, persist + broadcast result. */
async function runNotice(id: string, getWindow: () => BrowserWindow | null): Promise<void> {
  if (runningIds.has(id)) return;
  const notice = getNotice(id);
  if (!notice) return;

  runningIds.add(id);
  // Stamp lastRunDate immediately so the scheduler won't re-fire this minute.
  let updated = patchNotice(id, { status: 'running', lastError: undefined, lastRunDate: localDate(new Date()) });
  if (updated) emit(getWindow, { type: 'notice-updated', notice: updated });

  try {
    // Undefined sources = legacy ClickUp-only; an explicit (even empty) array is honored.
    const sources: NoticeSource[] = notice.sources === undefined ? ['clickup'] : notice.sources;
    // Validate the user-selected project path before it touches the shell.
    const safeDir = safeProjectDir(notice.projectPath);
    const cwd = safeDir || os.homedir();
    const ctx = sources.includes('clickup') ? await fetchTaskContext(notice) : { count: 0, text: '' };
    const prompt = buildPrompt(notice, sources, ctx);
    const addDir = sources.includes('github') ? safeDir : undefined;
    const result = await runClaude(prompt, cwd, addDir, buildAllowedTools(sources));

    updated = patchNotice(id, {
      status: 'done',
      lastResult: result,
      lastRunAt: new Date().toISOString(),
      lastError: undefined,
    });
    if (updated) emit(getWindow, { type: 'notice-updated', notice: updated });
    recordActivity({
      source: 'dashboard',
      kind: 'notice-ready',
      level: 'info',
      title: `Notice ready: ${notice.title}`,
      message: result.slice(0, 160),
    });
    debugLog(`[Dashboard] Notice "${notice.title}" completed (${ctx.count} tasks in context)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to run notice';
    updated = patchNotice(id, { status: 'error', lastError: message, lastRunAt: new Date().toISOString() });
    if (updated) emit(getWindow, { type: 'notice-updated', notice: updated });
    debugError(`[Dashboard] Notice "${notice.title}" failed:`, message);
  } finally {
    runningIds.delete(id);
  }
}

// ─── Scheduler ────────────────────────────────────────────────
function tick(getWindow: () => BrowserWindow | null): void {
  const now = new Date();
  const hhmm = localHHmm(now);
  const today = localDate(now);
  for (const notice of listNotices()) {
    if (!notice.enabled || !notice.scheduleTime) continue;
    if (notice.lastRunDate === today) continue;   // already ran today
    // Catch-up: fire once the scheduled minute has passed today, even if the
    // exact minute was missed (app closed/asleep, poll drift). HH:mm strings are
    // zero-padded, so lexicographic compare matches time-of-day ordering.
    if (notice.scheduleTime > hhmm) continue;     // not due yet today
    if (runningIds.has(notice.id)) continue;
    debugLog(`[Dashboard] Scheduler firing notice "${notice.title}" (scheduled ${notice.scheduleTime}, now ${hhmm})`);
    void runNotice(notice.id, getWindow);
  }
}

function startScheduler(getWindow: () => BrowserWindow | null): void {
  if (schedulerInterval) clearInterval(schedulerInterval);
  // Poll every minute — cheap, and time-of-day granularity is per-minute.
  schedulerInterval = setInterval(() => tick(getWindow), 60_000);
  // Run once now so a notice already overdue at launch (app was closed/asleep at
  // its scheduled time) fires immediately instead of waiting up to a minute.
  tick(getWindow);
  debugLog('[Dashboard] Notice scheduler started');
}

export function stopDashboardScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}

export function registerDashboardHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  startScheduler(getWindow);

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_LIST, async () => {
    return { success: true, data: listNotices() };
  });

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_SAVE, async (_event, input: SaveNoticeInput) => {
    try {
      if (!input?.title?.trim()) return { success: false, error: 'Title is required' };
      if (!input?.prompt?.trim()) return { success: false, error: 'Prompt is required' };
      const notice = saveNotice(input);
      emit(getWindow, { type: 'notice-updated', notice });
      return { success: true, data: notice };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save notice' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_DELETE, async (_event, id: string) => {
    const ok = deleteNotice(id);
    if (!ok) return { success: false, error: 'Notice not found' };
    emit(getWindow, { type: 'notice-deleted', id });
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.DASHBOARD_RUN, async (_event, id: string) => {
    if (!getNotice(id)) return { success: false, error: 'Notice not found' };
    void runNotice(id, getWindow); // fire-and-forget; UI updates via events
    return { success: true };
  });
}
