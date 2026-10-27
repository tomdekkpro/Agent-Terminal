import type { BrowserWindow, IpcMain } from 'electron';
import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AppSettings, CodeReviewEvent, CodeReviewFinding, CodeReviewItem, CodeReviewMergeMethod, CodeReviewPR, CodeReviewReleaseBranch, CodeReviewSeverity, TaskManagerTask } from '../../shared/types';
import { getSettings } from './settings-handlers';
import { recordActivity } from '../activity/activity-store';
import { ClickUpProvider } from './providers/clickup';
import { debugLog, debugError } from '../../shared/utils';
import { agentRegistry } from './providers/agent-registry';
import { getProjects } from '../project/project-store';
import { queuePostMergeQc, startPostMergeQc } from '../qc/post-merge-qc';
import {
  type TestEvidence,
  MIN_MANUAL_NOTE_LENGTH,
  TEST_EVIDENCE_FINDING_FILE,
  TEST_EVIDENCE_FINDING_MARKER,
  describeTestEvidence,
  parseTestEvidence,
} from '../../shared/test-evidence';

const clickUpProvider = new ClickUpProvider();

const GH_TIMEOUT = 120000;

// ─── Scheduler state ──────────────────────────────────────────
let schedulerInterval: NodeJS.Timeout | null = null;
let schedulerRunning = false;
let lastSchedulerRun: string | null = null;
let nextSchedulerRun: string | null = null;

// ─── Active review processes (for cancellation) ──────────────
import type { ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
const activeReviews = new Map<string, ChildProcess>();
let stopAllRequested = false;

// ─── Session tracking for resumed reviews ────────────────────
// Key: `${taskId}__pr${prNumber}@${repo}`, Value: session UUID
const reviewSessions = new Map<string, string>();

function getSessionKey(taskId: string, prNumber: number, repo: string | null): string {
  return `${taskId}__pr${prNumber}@${(repo ?? '').toLowerCase()}`;
}

function clearReviewSession(taskId: string, prNumber: number, repo: string | null): void {
  const key = getSessionKey(taskId, prNumber, repo);
  if (reviewSessions.has(key)) {
    debugLog(`[CodeReview] Cleared session for ${key}`);
    reviewSessions.delete(key);
  }
}

function clearAllSessionsForTask(taskId: string): void {
  for (const key of reviewSessions.keys()) {
    if (key.startsWith(`${taskId}__`)) {
      reviewSessions.delete(key);
    }
  }
}

function killReviewProcess(taskId: string): boolean {
  const child = activeReviews.get(taskId);
  if (child) {
    child.kill('SIGTERM');
    activeReviews.delete(taskId);
    return true;
  }
  return false;
}

function killAllReviewProcesses(): void {
  stopAllRequested = true;
  for (const [taskId, child] of activeReviews) {
    child.kill('SIGTERM');
    activeReviews.delete(taskId);
  }
}

/** Approval keywords that a developer can post in a ClickUp comment to override a failed review */
const APPROVAL_KEYWORDS = ['review:approve', 'review:ok', 'review:approved', 'review:lgtm'];

/** Tag that marks a task for manual review — AI auto-review must skip these */
const MANUAL_REVIEW_TAG = 'manual-review';

function hasManualReviewTag(task: { tags?: Array<{ name: string }> }): boolean {
  return !!task.tags?.some((t) => t.name.toLowerCase() === MANUAL_REVIEW_TAG);
}

/** Signature markers that identify comments posted by this bot (must be excluded from approval detection) */
const BOT_COMMENT_MARKERS = [
  '_automated review by agent terminal_',
  '_automated by agent terminal_',
  '_approved via agent terminal_',
];

/** Extract plain text from a ClickUp comment (handles both comment_text and rich text comment array) */
function extractCommentText(comment: any): string {
  // Try comment_text first (plain text field)
  if (comment.comment_text) return comment.comment_text;
  // Fallback: extract from rich text comment array
  if (Array.isArray(comment.comment)) {
    return comment.comment
      .map((block: any) => block.text || '')
      .join('')
      .trim();
  }
  return '';
}

/** True if the comment was posted by this bot (identified by footer signature) */
function isBotComment(text: string): boolean {
  const lower = text.toLowerCase();
  return BOT_COMMENT_MARKERS.some((marker) => lower.includes(marker));
}

/** Check whether a developer has posted an approval comment on the task (newer than the last review) */
async function hasApprovalComment(taskId: string): Promise<boolean> {
  try {
    const settings = getSettings();
    const commentsResult = await clickUpProvider.getComments(settings, taskId);
    if (!commentsResult.success || !commentsResult.data) return false;

    // Check recent comments (last 20) for approval keywords — skip bot messages
    const recentComments = commentsResult.data
      .filter((c: any) => c.user?.id !== -1)
      .slice(-20);

    for (const comment of recentComments) {
      const text = extractCommentText(comment).trim();
      // Skip bot's own comments (they contain instructional text mentioning "review:approve")
      if (isBotComment(text)) {
        debugLog(`[CodeReview] Skipping bot comment on task ${taskId}`);
        continue;
      }
      const lower = text.toLowerCase();
      debugLog(`[CodeReview] Checking comment from ${comment.user?.username || 'unknown'}: "${lower.substring(0, 100)}"`);
      if (APPROVAL_KEYWORDS.some((kw) => lower.includes(kw))) {
        debugLog(`[CodeReview] Found approval comment on task ${taskId}: "${lower.substring(0, 80)}"`);
        return true;
      }
    }
    debugLog(`[CodeReview] No approval comment found among ${recentComments.length} comments for task ${taskId}`);
  } catch (err) {
    debugError('[CodeReview] Failed to check approval comments:', err);
  }
  return false;
}

// ─── Test evidence gate ──────────────────────────────────────
// A review only passes code the developer has tested. The proof is a ClickUp
// comment — a /dp:tester-local (or tester / qc-demo) report, or a
// `test:manual` note, or the developer's write-up with test results — that
// names the developer's last own commit or came after it. Merges after it
// (the base, or the branch a stacked PR sits on) need no new test. See
// shared/test-evidence.ts for what is recognised.

/** Pages of 25 comments read for evidence. ClickUp returns the newest 25 per
 *  call, and on a busy task — build notices, QC rounds, reviews — the test
 *  report soon falls off the first page. */
const EVIDENCE_COMMENT_PAGES = 8;

/** Test evidence among the task's human comments, oldest first. Throws when the
 *  comments can't be read, so a ClickUp hiccup errors the review instead of
 *  failing the task. */
async function loadTestEvidence(taskId: string): Promise<TestEvidence[]> {
  const result = await clickUpProvider.getTaskComments(getSettings(), taskId, { maxPages: EVIDENCE_COMMENT_PAGES });
  if (!result.success) {
    throw new Error(`Couldn't read the task's comments to check test evidence: ${result.error}`);
  }
  const evidence: TestEvidence[] = [];
  for (const comment of result.data.comments) {
    const text = comment.text.trim();
    if (!text || isBotComment(text)) continue;
    const parsed = parseTestEvidence(text);
    if (!parsed) continue;
    evidence.push({
      ...parsed,
      commentId: comment.id,
      author: comment.user.username,
      postedAt: comment.createdAtMs,
    });
  }
  return evidence.sort((a, b) => a.postedAt - b.postedAt);
}

type TestEvidenceCheck = {
  /** The task's newest evidence, when it passed. */
  evidence: TestEvidence | null;
  /** The finding to fail the review with, when there is none (or it failed). */
  finding: CodeReviewFinding | null;
};

/**
 * Has the task been tested? Only that, not which commit: the newest evidence
 * on the task decides, and a fix pushed after it doesn't void it. Returns a
 * critical finding when there is none, or the newest run failed, which fails
 * the review like any other critical finding: failure comment, "review
 * failed", no pass tag, no merge. Always passes when the gate is turned off in
 * settings.
 */
async function checkTestEvidence(taskId: string, target: RepoTarget, prNumber: number): Promise<TestEvidenceCheck> {
  if (!getSettings().codeReviewRequireTestEvidence) return { evidence: null, finding: null };

  const [evidence, task] = await Promise.all([
    loadTestEvidence(taskId),
    clickUpProvider.getTask(getSettings(), taskId).catch(() => null),
  ]);
  const latest = evidence[evidence.length - 1] ?? null;
  const label = prLabel(target, prNumber);
  const ticket = (task?.success && task.data?.customId) || 'DP2-XXXXX';
  const howToTest = `Run \`/dp:tester-local ${ticket}\` on the branch, or post a comment on this task with a test section and its results (for example "Test cases & results" with "TC1 PASS" lines, or "Tests: 4/4"), or one that starts with \`test:manual\` followed by what you tested and the result (at least ${MIN_MANUAL_NOTE_LENGTH} characters). Then move the task back to review.`;

  if (latest && !latest.failed) {
    debugLog(`[CodeReview] Task ${taskId} ${label} tested: ${describeTestEvidence(latest)}`);
    return { evidence: latest, finding: null };
  }

  if (latest?.failed) {
    return {
      evidence: null,
      finding: {
        severity: 'critical',
        file: TEST_EVIDENCE_FINDING_FILE,
        description: `${label}: the latest test run (${describeTestEvidence(latest)}) reported failing cases. ${TEST_EVIDENCE_FINDING_MARKER}, and these tests did not pass.`,
        suggestion: `Fix the failing cases and test again. ${howToTest}`,
      },
    };
  }

  return {
    evidence: null,
    finding: {
      severity: 'critical',
      file: TEST_EVIDENCE_FINDING_FILE,
      description: `${label}: the task has no test evidence. ${TEST_EVIDENCE_FINDING_MARKER}.`,
      suggestion: howToTest,
    },
  };
}

/** The test finding for a task a developer approved by comment, when it has
 *  an open PR — empty when it is tested. Evidence is per task, so one check
 *  answers for every PR. */
async function approvalTestGaps(projectPath: string, taskId: string, prs: PRInfo[]): Promise<CodeReviewFinding[]> {
  for (const pr of prs) {
    const target = await resolveTarget(projectPath, pr.repo);
    const info = await fetchPRInfo(target, pr.prNumber);
    if (info.state !== 'OPEN') continue;
    const { finding } = await checkTestEvidence(taskId, target, pr.prNumber);
    return finding ? [finding] : [];
  }
  return [];
}

/** The "Tested: …" line of a pass comment, so QC can see how the code was verified. */
function testedLine(testedBy: string | null | undefined): string {
  return testedBy ? `\nTested: ${testedBy}.` : '';
}

function sendReviewEvent(getWindow: () => BrowserWindow | null, event: CodeReviewEvent) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.CODE_REVIEW_EVENT, event);
  }
}

// ─── Repos ───────────────────────────────────────────────────
// A task can need PRs in more than one repo — a fix in both wp and customerweb
// — so every PR carries the repo it lives in, and every gh call is pointed at
// that repo with `-R`. PR numbers are only unique per repo: customerweb #129
// and wp #129 are unrelated PRs.

/** Where to act on a PR. `repo` is `owner/name` (null only when the selected
 *  project's own repo couldn't be resolved — gh then uses whatever `cwd` is).
 *  `cwd` is a local checkout of that repo when one is registered, so the
 *  reviewer can read source files; otherwise the selected project, and
 *  `checkout` is false. `isMain` marks the selected project's repo, which owns
 *  the release branch. */
type RepoTarget = { cwd: string; repo: string | null; isMain: boolean; checkout: boolean };

function sameRepo(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** `-R owner/name`, so gh acts on the PR's own repo whatever `cwd` is. */
function repoArgs(target: RepoTarget): string[] {
  return target.repo ? ['-R', target.repo] : [];
}

/** `owner/name` from a GitHub remote URL (https or ssh). */
function parseGitHubSlug(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The origin remote of a checkout, read straight from .git/config. No git
 *  process, so a checkout git refuses to open ("dubious ownership") still
 *  resolves. Null for worktrees (.git is a file there) and non-GitHub remotes. */
function readOriginSlug(dir: string): string | null {
  try {
    const config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf-8');
    const section = config.match(/\[remote "origin"\]([^[]*)/);
    const url = section?.[1].match(/^\s*url\s*=\s*(.+)$/m)?.[1];
    return url ? parseGitHubSlug(url) : null;
  } catch {
    return null;
  }
}

/** Only successes are cached, so a gh hiccup isn't remembered forever. */
const repoSlugCache = new Map<string, string>();

/** `owner/name` of the repo checked out at `dir`. */
async function repoOfPath(dir: string): Promise<string | null> {
  const hit = repoSlugCache.get(dir);
  if (hit) return hit;
  let slug = readOriginSlug(dir);
  if (!slug) {
    try {
      slug = JSON.parse(await ghRun(['repo', 'view', '--json', 'nameWithOwner'], dir)).nameWithOwner || null;
    } catch {
      slug = null;
    }
  }
  if (slug) repoSlugCache.set(dir, slug);
  return slug;
}

/** Where to act on a PR in `repo` (default: the selected project's repo). */
async function resolveTarget(projectPath: string, repo?: string | null): Promise<RepoTarget> {
  const main = await repoOfPath(projectPath);
  if (!repo || sameRepo(repo, main)) return { cwd: projectPath, repo: main, isMain: true, checkout: true };
  const checkout = getProjects().find((p) => sameRepo(readOriginSlug(p.path), repo));
  return { cwd: checkout?.path ?? projectPath, repo, isMain: false, checkout: !!checkout };
}

/** "PR #129" in the selected project's repo, "customerweb PR #129" elsewhere —
 *  a task with PRs in two repos needs the repo to tell them apart. */
function prLabel(target: RepoTarget, prNumber: number, title?: string): string {
  const repo = !target.isMain && target.repo ? `${target.repo.split('/').pop()} ` : '';
  return `${repo}PR #${prNumber}${title ? ` (${title})` : ''}`;
}

/** Post a comment on a PR. The body goes through a file, not argv, because
 *  review comments can run past the Windows command-line limit. */
async function postPRComment(target: RepoTarget, prNumber: number, body: string): Promise<void> {
  const tmpFile = path.join(os.tmpdir(), `cr-comment-${Date.now()}-${prNumber}.md`);
  fs.writeFileSync(tmpFile, body, 'utf-8');
  try {
    await ghRun(['pr', 'comment', String(prNumber), ...repoArgs(target), '--body-file', tmpFile], target.cwd);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

/** `repo` is the `owner/name` from the PR URL; null for a bare "PR #123",
 *  which means the selected project's repo. */
type PRInfo = { prNumber: number; prUrl: string | null; repo: string | null };

function prKey(pr: { prNumber: number; repo: string | null }): string {
  return `${(pr.repo ?? '').toLowerCase()}#${pr.prNumber}`;
}

/** Extract all PRs from any text */
function extractAllPRsFromText(text: string): PRInfo[] {
  const prs: PRInfo[] = [];
  const seen = new Set<string>();
  const urlNumbers = new Set<number>();

  // Match GitHub PR URLs: github.com/owner/repo/pull/123 — the repo is kept,
  // it is what tells customerweb #129 apart from wp #129.
  const urlRegex = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    const pr: PRInfo = { prNumber: parseInt(match[3], 10), prUrl: match[0], repo: `${match[1]}/${match[2]}` };
    urlNumbers.add(pr.prNumber);
    if (!seen.has(prKey(pr))) {
      seen.add(prKey(pr));
      prs.push(pr);
    }
  }

  // Match PR #123 or PR: #123 patterns. Skipped when that number was already
  // linked by URL — "PR #129" next to a customerweb/pull/129 link is the same
  // PR, not wp #129.
  const hashRegex = /PR[:\s]*#(\d+)/gi;
  while ((match = hashRegex.exec(text)) !== null) {
    const pr: PRInfo = { prNumber: parseInt(match[1], 10), prUrl: null, repo: null };
    if (!urlNumbers.has(pr.prNumber) && !seen.has(prKey(pr))) {
      seen.add(prKey(pr));
      prs.push(pr);
    }
  }

  return prs;
}

/** Extract all PRs from task name + description */
function extractPRsFromTask(task: { description?: string; name?: string }): PRInfo[] {
  const text = `${task.name || ''} ${task.description || ''}`;
  return extractAllPRsFromText(text);
}

/** Search task comments for all PR URLs */
async function extractPRsFromComments(taskId: string): Promise<PRInfo[]> {
  try {
    const settings = getSettings();
    const result = await clickUpProvider.getComments(settings, taskId);
    if (!result.success || !result.data) return [];

    // Copy before reversing - getComments hands back its cached array, and
    // reversing in place would scramble it for every later reader.
    const allText = [...result.data]
      .reverse()
      .map((c: any) => c.comment_text || '')
      .join('\n');
    const prs = extractAllPRsFromText(allText);
    if (prs.length > 0) {
      debugLog(`[CodeReview] Found ${prs.length} PR(s) in comments for task ${taskId}: ${prs.map((p) => `#${p.prNumber}`).join(', ')}`);
    }
    return prs;
  } catch (err) {
    debugError('[CodeReview] Failed to search comments for PR:', err);
  }
  return [];
}

/**
 * Open-PR listings for one batch (a page load or a scheduler cycle), fetched
 * once per repo and shared by every task in it. `null` asks for the selected
 * project's repo. Listings resolve to null when gh is unavailable.
 */
type PRLookup = {
  /** `owner/name` of the selected project's repo; null if it can't be resolved. */
  mainRepo: Promise<string | null>;
  openPRs(repo: string | null): Promise<OpenPRList | null>;
};

function createPRLookup(projectPath: string | undefined): PRLookup {
  const mainRepo = projectPath ? repoOfPath(projectPath) : Promise.resolve(null);
  return {
    mainRepo,
    async openPRs(repo) {
      if (!projectPath) return null;
      const main = await mainRepo;
      const isMain = !repo || sameRepo(repo, main);
      return fetchOpenPRMetadata({ cwd: projectPath, repo: isMain ? main : repo, isMain, checkout: isMain });
    },
  };
}

/** Other repos a task's PRs can live in (`owner/name`), from settings. */
function linkedRepos(): string[] {
  return (getSettings().codeReviewLinkedRepos || '')
    .split(/[\s,]+/)
    .map((r) => r.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, ''))
    .filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r));
}

/** `text` names the ticket `id` as a whole id: DP2-2657 is not in a branch
 *  for DP2-26572. Case-insensitive. */
function mentionsId(text: string | undefined, id: string): boolean {
  if (!text) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![0-9])`, 'i').test(text);
}

/**
 * Try all methods to find PRs: task fields, branch/title matching against the
 * selected repo's open-PR list, branch matching in the linked repos, and the
 * task's comment thread.
 *
 * The comment thread is always read. It used to be skipped once a PR had been
 * found by branch, but a task fixed in two repos usually has its second PR
 * (e.g. customerweb) linked only in a comment — finding the wp PR by branch
 * said nothing about it, so it was never reviewed or merged.
 *
 * Listings come from `lookup`, shared by every task in the batch — this used
 * to shell out to `gh pr list` up to four times PER TASK, which made the Code
 * Review page take minutes to load once a dozen tasks sat in review. When gh
 * is unavailable, branch matching and open-filtering are skipped
 * (comment/description PRs pass through).
 */
async function findPRsForTask(
  task: { id: string; customId?: string; description?: string; name?: string },
  lookup: PRLookup,
): Promise<PRInfo[]> {
  const mainRepo = await lookup.mainRepo;
  const seen = new Set<string>();
  const results: PRInfo[] = [];

  function addPRs(prs: PRInfo[]) {
    for (const raw of prs) {
      // A URL into the selected repo and a bare "PR #123" are the same PR.
      const pr = { ...raw, repo: !raw.repo || sameRepo(raw.repo, mainRepo) ? mainRepo : raw.repo };
      if (!seen.has(prKey(pr))) {
        seen.add(prKey(pr));
        results.push(pr);
      }
    }
  }

  // 1. Check task name + description — already in memory, costs nothing.
  addPRs(extractPRsFromTask(task));

  // 2. Match the custom ID (e.g. DP2-1234) against open PR branch names, and
  //    the internal task id against branches (e.g. task/86d28ttjq):
  //    - in the selected repo, PR titles too;
  //    - in the linked repos (customerweb, webshop), branch names only. A
  //      task's PR there is usually linked in a comment, but when nobody
  //      posted the link it was never reviewed or merged — and the wp half of
  //      the fix merged alone. Branch only, and only in listed repos, so a
  //      docs or tooling PR that merely mentions the ticket id is never
  //      pulled into the review and merged.
  const ids = [task.customId, task.customId?.replace(/[^a-zA-Z0-9_-]/g, '-'), task.id].filter((id): id is string => !!id);
  const searches: Array<{ repo: string | null; titles: boolean }> = [
    { repo: null, titles: true },
    ...linkedRepos().filter((repo) => !sameRepo(repo, mainRepo)).map((repo) => ({ repo, titles: false })),
  ];
  for (const search of searches) {
    const openPRs = await lookup.openPRs(search.repo);
    if (!openPRs) continue;
    for (const [prNumber, meta] of openPRs.byNumber) {
      const branchMatch = ids.some((id) => mentionsId(meta.branch, id));
      const titleMatch = search.titles && !!task.customId && mentionsId(meta.title, task.customId);
      if (branchMatch || titleMatch) {
        addPRs([{ prNumber, prUrl: meta.url ?? null, repo: search.repo ?? mainRepo }]);
      }
    }
  }

  // 3. The comment thread — see above for why this always runs.
  addPRs(await extractPRsFromComments(task.id));

  // 4. Keep only PRs that are still open, each checked against its own repo's
  //    listing (customerweb #129 against customerweb, not wp). Skipped for a
  //    listing truncated at OPEN_PR_LIMIT — there, a PR missing from
  //    `byNumber` may simply be past the cap, and dropping it would leave the
  //    task showing "No open PR found" even though the PR is open.
  //    A PR into a side branch (`Releases/26.6.Angular21`) is dropped too: it
  //    ports the change to a branch that isn't the release the task ships in,
  //    so it is neither reviewed, tested for, nor merged from here.
  const open: PRInfo[] = [];
  for (const pr of results) {
    const list = await lookup.openPRs(pr.repo);
    if (isSideBranch(list?.byNumber.get(pr.prNumber)?.baseBranch)) continue;
    if (!list?.complete || list.byNumber.has(pr.prNumber)) open.push(pr);
  }

  if (results.length > 0) {
    const names = (prs: PRInfo[]) => prs.map((p) => `${p.repo ?? ''}#${p.prNumber}`).join(', ');
    debugLog(`[CodeReview] Found ${results.length} PR(s) for task ${task.customId || task.id} (${names(results)}), ${open.length} open: ${names(open)}`);
  }
  return open;
}

/** A release-prefixed branch that isn't a version: `Releases/26.6.Angular21`,
 *  `Releases/test-master`. */
function isSideBranch(base: string | undefined): boolean {
  const prefix = getSettings().codeReviewReleaseBranchPrefix || 'Releases/';
  return !!base && base.startsWith(prefix) && !parseVersion(base.slice(prefix.length));
}

/** Fetch PR metadata using gh CLI (no diff — Claude fetches that itself) */
async function fetchPRInfo(target: RepoTarget, prNumber: number): Promise<{
  title: string;
  url: string;
  branch: string;
  baseBranch: string;
  author: string;
  state: string;
  mergeable: string;
  headSha: string;
}> {
  const infoJson = await ghRun(
    ['pr', 'view', String(prNumber), ...repoArgs(target), '--json', 'title,url,headRefName,baseRefName,author,state,mergeable,headRefOid'],
    target.cwd,
  );
  const info = JSON.parse(infoJson);
  return {
    title: info.title,
    url: info.url,
    branch: info.headRefName,
    baseBranch: info.baseRefName || '',
    author: info.author?.login || '',
    state: (info.state || '').toUpperCase(),
    mergeable: (info.mergeable || '').toUpperCase(),
    headSha: info.headRefOid || '',
  };
}

/** PR metadata shown in the review list (branch, base branch, author, title) */
type PRMetadata = { url?: string; branch?: string; baseBranch?: string; author?: string; title?: string };

/** The open-PR listing plus whether it covers every open PR in the repo.
 *  `complete` is false when the repo has more open PRs than OPEN_PR_LIMIT, in
 *  which case absence from `byNumber` does NOT prove a PR is closed. */
type OpenPRList = { byNumber: Map<number, PRMetadata>; complete: boolean };

/** gh pages the GitHub API 100 at a time (~750ms per page), so this is the
 *  whole cost of the listing. It was 200, which truncates on any repo with more
 *  open PRs than that — and a truncated listing disables the open-only filter,
 *  so tasks whose PR sat past the cap kept their PR but lost the closed check.
 *  Now that the listing no longer blocks the first paint it can afford to be
 *  complete. */
const OPEN_PR_LIMIT = 1000;

/** `gh pr list` is a multi-second shell round-trip and the same listing serves
 *  every task in a load, a Refresh click and the scheduler cycle behind it.
 *  Open PRs change on the order of minutes, so a stale entry is served
 *  immediately with a refresh started behind it rather than waited on. */
const OPEN_PR_CACHE_TTL = 5 * 60_000;
/** Past this an entry is too old to serve even optimistically. */
const OPEN_PR_STALE_TTL = 30 * 60_000;
const openPRCache = new Map<string, { list: OpenPRList; timestamp: number }>();
/** At most one gh listing in flight per repo; concurrent callers share it. */
const openPRInflight = new Map<string, Promise<OpenPRList | null>>();

/** Listings are per repo, whichever checkout gh ran in. */
function openPRCacheKey(target: RepoTarget): string {
  return (target.repo ?? target.cwd).toLowerCase();
}

/** Fetch metadata for all open PRs in one gh call, keyed by PR number.
 *  Returns null when gh is unavailable so callers can tell "no open PRs"
 *  apart from "couldn't ask".
 *
 *  Fresh within OPEN_PR_CACHE_TTL: returned outright. Between that and
 *  OPEN_PR_STALE_TTL: returned immediately and refreshed behind the caller, so
 *  reopening the Code Review page never waits on gh again. */
async function fetchOpenPRMetadata(target: RepoTarget): Promise<OpenPRList | null> {
  const key = openPRCacheKey(target);
  const hit = openPRCache.get(key);
  const age = hit ? Date.now() - hit.timestamp : Infinity;
  if (hit && age < OPEN_PR_CACHE_TTL) return hit.list;

  let refresh = openPRInflight.get(key);
  if (!refresh) {
    refresh = loadOpenPRMetadata(target).finally(() => openPRInflight.delete(key));
    openPRInflight.set(key, refresh);
  }

  if (hit && age < OPEN_PR_STALE_TTL) {
    void refresh.catch(() => {});
    return hit.list;
  }
  return refresh;
}

/** The actual gh call. Always resolves (null on failure) so background
 *  revalidation can never surface an unhandled rejection. */
async function loadOpenPRMetadata(target: RepoTarget): Promise<OpenPRList | null> {
  try {
    const json = await ghRun(
      ['pr', 'list', ...repoArgs(target), '--state', 'open', '--json', 'number,url,headRefName,baseRefName,title,author', '--limit', String(OPEN_PR_LIMIT)],
      target.cwd,
    );
    const parsed = JSON.parse(json);
    const byNumber = new Map<number, PRMetadata>();
    for (const pr of parsed) {
      byNumber.set(pr.number, {
        url: pr.url,
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        author: pr.author?.login,
        title: pr.title,
      });
    }
    const complete = parsed.length < OPEN_PR_LIMIT;
    debugLog(`[CodeReview] Open-PR listing for ${target.repo ?? target.cwd}: ${parsed.length} PR(s)`);
    if (!complete) {
      debugLog(`[CodeReview] Open-PR listing hit the ${OPEN_PR_LIMIT} cap — skipping the open-only filter so PRs past the cap aren't dropped`);
    }
    const list: OpenPRList = { byNumber, complete };
    openPRCache.set(openPRCacheKey(target), { list, timestamp: Date.now() });
    return list;
  } catch {
    // gh CLI not available or not in a repo — list will just lack metadata
    return null;
  }
}

// ─── Merging ─────────────────────────────────────────────────

/** Run gh with an argument array — no shell, so GraphQL queries and comment
 *  bodies need no quoting on either cmd.exe or sh. */
function ghRun(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, encoding: 'utf-8', timeout: GH_TIMEOUT, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
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

/** gh's own message is in stderr; `error.message` is just "Command failed: …". */
function ghErrorMessage(err: unknown): string {
  const stderr = (err as any)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().split('\n').slice(-3).join(' ');
  return err instanceof Error ? err.message : String(err);
}

/** `26.9.1` → [26, 9, 1]. Null for anything that isn't a plain dotted number —
 *  side branches like `Releases/26.6.Angular21` or `Releases/test-master` are
 *  never "the current release". */
function parseVersion(text: string): number[] | null {
  return /^\d+(\.\d+)+$/.test(text) ? text.split('.').map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Release branches with no commit within this window of the newest one are
 *  retired. Keeps a stray, long-dead `Releases/2026.2.3` from outranking the
 *  live `Releases/26.9.1` just because its number is bigger. */
const RELEASE_ACTIVE_WINDOW_MS = 45 * 24 * 60 * 60_000;
const RELEASE_BRANCH_TTL = 5 * 60_000;
const releaseBranchCache = new Map<string, { branch: string | null; timestamp: number }>();

const RELEASE_REFS_QUERY = `query($owner: String!, $name: String!, $prefix: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: $prefix, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { ... on Commit { committedDate } } }
    }
  }
}`;

/**
 * The current release branch: the highest `<prefix><x.y.z>` among release
 * branches still being committed to. Asks GitHub rather than local refs, which
 * are only as fresh as the user's last fetch. Null when there is none.
 */
async function detectReleaseBranch(target: RepoTarget, prefix: string, refresh = false): Promise<string | null> {
  const key = `${target.repo ?? target.cwd}\n${prefix}`;
  const hit = releaseBranchCache.get(key);
  if (!refresh && hit && Date.now() - hit.timestamp < RELEASE_BRANCH_TTL) return hit.branch;

  const slug = target.repo ?? await repoOfPath(target.cwd);
  if (!slug) throw new Error(`Couldn't tell which GitHub repo ${target.cwd} is`);
  const [owner, name] = slug.split('/');
  const branches: Array<{ name: string; version: number[]; committedAt: number }> = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const args = [
      'api', 'graphql',
      '-f', `query=${RELEASE_REFS_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-f', `prefix=refs/heads/${prefix}`,
    ];
    if (after) args.push('-f', `after=${after}`);
    const refs: any = JSON.parse(await ghRun(args, target.cwd))?.data?.repository?.refs;
    for (const node of refs?.nodes ?? []) {
      const version = parseVersion(node.name);
      const committedAt = Date.parse(node.target?.committedDate ?? '');
      if (version && Number.isFinite(committedAt)) {
        branches.push({ name: `${prefix}${node.name}`, version, committedAt });
      }
    }
    if (!refs?.pageInfo?.hasNextPage) break;
    after = refs.pageInfo.endCursor;
  }

  let branch: string | null = null;
  if (branches.length > 0) {
    const newest = Math.max(...branches.map((b) => b.committedAt));
    const active = branches.filter((b) => newest - b.committedAt <= RELEASE_ACTIVE_WINDOW_MS);
    active.sort((a, b) => compareVersions(b.version, a.version));
    branch = active[0].name;
  }
  debugLog(`[CodeReview] Current release branch for ${target.repo ?? target.cwd}: ${branch ?? '(none)'} (${branches.length} release branch(es))`);
  releaseBranchCache.set(key, { branch, timestamp: Date.now() });
  return branch;
}

/** The release branch of the selected project's repo — the one the pinned
 *  setting is about, and the one a task's Release version is checked against. */
async function getReleaseBranch(projectPath: string, refresh = false): Promise<CodeReviewReleaseBranch> {
  const settings = getSettings();
  const prefix = settings.codeReviewReleaseBranchPrefix || 'Releases/';
  const target = await resolveTarget(projectPath);
  const pinned = (settings.codeReviewReleaseBranch || '').trim();
  if (pinned) return { branch: pinned, source: 'pinned', prefix, repo: target.repo ?? undefined };
  const branch = await detectReleaseBranch(target, prefix, refresh);
  return { branch, source: branch ? 'detected' : 'none', prefix, repo: target.repo ?? undefined };
}

const INTEGRATION_REFS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", query: "develop", first: 100, orderBy: { field: ALPHABETICAL, direction: ASC }) { nodes { name } }
  }
}`;
const integrationBranchCache = new Map<string, { branch: string | null; timestamp: number }>();

/**
 * Where PRs merge in a repo with no release branches: its develop branch.
 * customerweb lands in `Develop`, dekkpro-webshop in `develop` — branch names
 * are case-sensitive, so the real name is read from GitHub rather than
 * assumed. Null when there is none; the default branch is never used instead,
 * since in these repos it is production (`main`).
 */
async function detectIntegrationBranch(target: RepoTarget): Promise<string | null> {
  const slug = target.repo ?? await repoOfPath(target.cwd);
  if (!slug) throw new Error(`Couldn't tell which GitHub repo ${target.cwd} is`);
  const hit = integrationBranchCache.get(slug.toLowerCase());
  if (hit && Date.now() - hit.timestamp < RELEASE_BRANCH_TTL) return hit.branch;

  const [owner, name] = slug.split('/');
  const out = await ghRun(
    ['api', 'graphql', '-f', `query=${INTEGRATION_REFS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`],
    target.cwd,
  );
  const names: string[] = (JSON.parse(out)?.data?.repository?.refs?.nodes ?? []).map((n: { name: string }) => n.name);
  const matches = names.filter((n) => n.toLowerCase() === 'develop');
  const branch = matches.includes('Develop') ? 'Develop' : matches[0] ?? null;
  debugLog(`[CodeReview] Integration branch for ${slug}: ${branch ?? '(none)'}`);
  integrationBranchCache.set(slug.toLowerCase(), { branch, timestamp: Date.now() });
  return branch;
}

const FAILING_CHECK_STATES = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

/** Names of failing and still-running checks from gh's statusCheckRollup,
 *  which mixes CheckRuns (status + conclusion) and StatusContexts (state). */
function summarizeChecks(rollup: any[]): { failing: string[]; pending: string[] } {
  const failing: string[] = [];
  const pending: string[] = [];
  for (const check of rollup ?? []) {
    const name = check.name || check.context || 'check';
    if (check.__typename === 'StatusContext') {
      const state = String(check.state || '').toUpperCase();
      if (state === 'PENDING' || state === 'EXPECTED') pending.push(name);
      else if (FAILING_CHECK_STATES.has(state)) failing.push(name);
    } else if (String(check.status || '').toUpperCase() !== 'COMPLETED') {
      pending.push(name);
    } else if (FAILING_CHECK_STATES.has(String(check.conclusion || '').toUpperCase())) {
      failing.push(name);
    }
  }
  return { failing, pending };
}

/**
 * Everything that must hold before a PR may merge. The release-branch rule is
 * the important one: the ClickUp task's Release version must be the current
 * release of the selected project's repo — a ticket planned for 26.8.1, or not
 * planned at all, must not land in 26.9.1 — and the PR must target:
 *  - in the selected repo: that release branch;
 *  - in another repo (a task fixed in both wp and customerweb): that repo's
 *    own current release branch, or its develop branch if it has none.
 *
 * Returns a human-readable reason when it may not merge, null when it may.
 */
async function checkMergeReadiness(
  projectPath: string,
  target: RepoTarget,
  taskId: string,
  pr: any,
  reviewedHeadSha: string | undefined,
): Promise<string | null> {
  if (pr.state !== 'OPEN') return `PR #${pr.number} is already ${String(pr.state).toLowerCase()}.`;
  if (pr.isDraft) return `PR #${pr.number} is still a draft.`;

  const release = await getReleaseBranch(projectPath);
  if (!release.branch) {
    return `No current release branch found (nothing named "${release.prefix}x.y.z"). Pin one in the Auto Review settings.`;
  }
  const expectedBase = target.isMain
    ? release.branch
    : (await detectReleaseBranch(target, release.prefix)) ?? await detectIntegrationBranch(target);
  if (!expectedBase) {
    return `${target.repo} has no release branch and no develop branch, so there is no branch to merge into from here. Merge ${prLabel(target, pr.number)} by hand.`;
  }
  if (pr.baseRefName !== expectedBase) {
    const where = target.isMain ? 'the current release branch is' : `${target.repo} merges into`;
    return `PR targets "${pr.baseRefName}", but ${where} "${expectedBase}". Retarget the PR before merging.`;
  }
  const head = String(pr.headRefName || '');
  if (head.startsWith(release.prefix) && parseVersion(head.slice(release.prefix.length))) {
    return `PR merges release branch "${head}" into "${pr.baseRefName}" — release-to-release merges must be done by hand.`;
  }

  // The task's Release version is required, not optional: an unplanned task
  // (empty field) or one we couldn't read must never slip into the release.
  const task = await clickUpProvider.getTask(getSettings(), taskId);
  if (!task.success) {
    return `Couldn't read the ClickUp task to check its Release version (${task.error}). Try again.`;
  }
  const taskRelease = task.data?.releaseVersion?.trim();
  if (!taskRelease) {
    return `Task has no Release version set — set it to ${release.branch.slice(release.prefix.length)} in ClickUp if it belongs in "${release.branch}".`;
  }
  if (`${release.prefix}${taskRelease}` !== release.branch) {
    return `Task is planned for release ${taskRelease}, but the current release branch is "${release.branch}". Fix the task's Release version or the PR target.`;
  }

  if (reviewedHeadSha && pr.headRefOid !== reviewedHeadSha) {
    return `PR #${pr.number} has new commits since it was reviewed. Re-run the review before merging.`;
  }
  if (String(pr.mergeable).toUpperCase() === 'CONFLICTING') {
    return `PR #${pr.number} has merge conflicts with "${pr.baseRefName}".`;
  }
  const checks = summarizeChecks(pr.statusCheckRollup);
  if (checks.failing.length > 0) return `CI checks failing: ${checks.failing.join(', ')}.`;
  if (checks.pending.length > 0) return `CI checks still running: ${checks.pending.join(', ')}. Merge again once they finish.`;
  return null;
}

/** One PR to merge. `repo` null/omitted = the selected project's repo. */
type MergeRequest = { prNumber: number; repo?: string | null; reviewedHeadSha?: string };

type MergeOutcome = {
  prNumber: number;
  repo: string | null;
  merged: boolean;
  /** The success message when merged, otherwise why not. */
  message: string;
  baseBranch?: string;
};

/** PRs with a merge in flight, so a double click or a scheduler cycle racing
 *  the button can't merge (or comment) twice. */
const mergesInFlight = new Set<string>();

/**
 * Approve and merge a task's PRs after the pre-merge checks. Approving first
 * covers branch protection that requires an approving review — the step that
 * used to mean opening the PR in a browser.
 *
 * All or nothing: every PR is checked before any is merged, and if one can't
 * merge none are. A task fixed in wp and customerweb must not ship half its
 * fix because one PR was still on CI. (Pass a single PR to merge just that
 * one, as the Merge button on a PR does.)
 *
 * `auto` marks a merge nobody clicked: a refusal is then reported on the
 * ClickUp task, since nobody is watching the UI.
 *
 * Never throws; every outcome is also pushed to the renderer as a `merge` event.
 */
async function mergeTaskPullRequests(
  getWindow: () => BrowserWindow | null,
  projectPath: string,
  taskId: string,
  requests: MergeRequest[],
  options: { auto?: boolean } = {},
): Promise<MergeOutcome[]> {
  const settings = getSettings();
  const method: CodeReviewMergeMethod = settings.codeReviewMergeMethod || 'squash';

  type Entry = { req: MergeRequest; target: RepoTarget; key: string; pr: any; claimed: boolean; outcome?: MergeOutcome };
  const entries: Entry[] = [];
  for (const req of requests) {
    const target = await resolveTarget(projectPath, req.repo);
    entries.push({ req, target, key: `${(target.repo ?? target.cwd).toLowerCase()}#${req.prNumber}`, pr: null, claimed: false });
  }
  const fail = (e: Entry, message: string): MergeOutcome =>
    ({ prNumber: e.req.prNumber, repo: e.target.repo, merged: false, message });
  const label = (e: Entry) => prLabel(e.target, e.req.prNumber, e.pr?.title);

  try {
    // 1. Check every PR before touching any of them.
    for (const e of entries) {
      if (mergesInFlight.has(e.key)) {
        e.outcome = fail(e, `PR #${e.req.prNumber} is already being merged.`);
        continue;
      }
      mergesInFlight.add(e.key);
      e.claimed = true;
      sendReviewEvent(getWindow, { type: 'merge', taskId, prNumber: e.req.prNumber, prRepo: e.target.repo ?? undefined, mergeStatus: 'merging' });
      try {
        e.pr = JSON.parse(await ghRun(
          ['pr', 'view', String(e.req.prNumber), ...repoArgs(e.target), '--json', 'number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,statusCheckRollup'],
          e.target.cwd,
        ));
        const blocked = await checkMergeReadiness(projectPath, e.target, taskId, e.pr, e.req.reviewedHeadSha);
        if (blocked) e.outcome = fail(e, blocked);
      } catch (err) {
        e.outcome = fail(e, `Couldn't check ${label(e)}: ${ghErrorMessage(err)}`);
      }
    }

    // 2. Merge only if all of them may.
    const blockers = entries.filter((e) => e.outcome);
    if (blockers.length > 0) {
      for (const e of entries) {
        if (!e.outcome) {
          e.outcome = fail(e, `Held back so the task's PRs merge together — ${blockers.map(label).join(', ')} can't merge yet.`);
        }
      }
    } else {
      for (const e of entries) {
        if (e.outcome) continue;
        try {
          await ghRun(['pr', 'review', String(e.req.prNumber), ...repoArgs(e.target), '--approve', '--body', 'Approved via Agent Terminal — AI code review passed.'], e.target.cwd);
        } catch (err) {
          // Expected when the PR is your own or already approved; if branch
          // protection really needs an approval, the merge below says so.
          debugLog(`[CodeReview] Approve ${label(e)} skipped: ${ghErrorMessage(err)}`);
        }
        try {
          // --match-head-commit makes GitHub refuse the merge if the head moved
          // after the checks above, closing the gap between check and merge.
          await ghRun(['pr', 'merge', String(e.req.prNumber), ...repoArgs(e.target), `--${method}`, '--match-head-commit', e.pr.headRefOid], e.target.cwd);
          e.outcome = { prNumber: e.req.prNumber, repo: e.target.repo, merged: true, baseBranch: e.pr.baseRefName, message: `Merged into ${e.pr.baseRefName} (${method}).` };
        } catch (err) {
          e.outcome = fail(e, `Merge failed: ${ghErrorMessage(err)}`);
          // Stop here rather than ship more of a fix that is now incomplete.
          for (const rest of entries) {
            if (!rest.outcome) rest.outcome = fail(rest, `Not merged because ${label(e)} failed to merge — retry once it is fixed.`);
          }
          break;
        }
      }
    }
  } catch (err) {
    for (const e of entries) {
      if (!e.outcome) e.outcome = fail(e, `Merge failed: ${ghErrorMessage(err)}`);
    }
  } finally {
    for (const e of entries) if (e.claimed) mergesInFlight.delete(e.key);
  }

  // 3. Report.
  const blockedAuto: Entry[] = [];
  for (const e of entries) {
    const outcome = e.outcome!;
    const prRepo = e.target.repo ?? undefined;
    if (outcome.merged) {
      openPRCache.delete(openPRCacheKey(e.target));
      debugLog(`[CodeReview] ${label(e)} merged into ${outcome.baseBranch}`);
      sendReviewEvent(getWindow, { type: 'merge', taskId, prNumber: e.req.prNumber, prRepo, mergeStatus: 'merged', message: outcome.message });
      await clickUpProvider.postComment(
        settings,
        taskId,
        `🔀 ${label(e)} merged into \`${outcome.baseBranch}\` (${method})${options.auto ? ' automatically after the code review passed' : ''}.\n\n_Automated by Agent Terminal_`,
      ).catch(() => {});
      recordActivity({
        source: 'code-review',
        kind: options.auto ? 'pr-auto-merged' : 'pr-merged',
        level: 'success',
        title: `${prLabel(e.target, e.req.prNumber)} merged into ${outcome.baseBranch}`,
        message: e.pr?.title,
        clickupTaskId: taskId,
        url: e.pr?.url,
      });
    } else {
      debugLog(`[CodeReview] ${label(e)} not merged: ${outcome.message}`);
      sendReviewEvent(getWindow, { type: 'merge', taskId, prNumber: e.req.prNumber, prRepo, mergeStatus: 'blocked', message: outcome.message });
      if (options.auto) blockedAuto.push(e);
    }
  }
  // Nobody runs /dp:ship's QC step for a merge made here, so queue the AI QC
  // round now; it starts once demo has deployed the merge commit.
  const merged = entries.filter((e) => e.outcome!.merged);
  if (merged.length > 0) {
    queuePostMergeQc(taskId, projectPath, merged.map((e) => ({ repo: e.target.repo, prNumber: e.req.prNumber, baseBranch: e.outcome!.baseBranch })));
  }
  if (blockedAuto.length > 0) {
    // One comment for the task, not one per PR — the held-back PRs only make
    // sense next to the reason they were held back.
    const lines = blockedAuto.map((e) => `- ${label(e)}: ${e.outcome!.message}`);
    await clickUpProvider.postComment(
      settings,
      taskId,
      `⚠️ Auto-merge skipped:\n${lines.join('\n')}\n\n_Automated by Agent Terminal_`,
    ).catch(() => {});
    const first = blockedAuto[0];
    recordActivity({
      source: 'code-review',
      kind: 'merge-blocked',
      level: 'warn',
      title: `Auto-merge blocked: ${prLabel(first.target, first.req.prNumber)}`,
      message: first.outcome!.message,
      clickupTaskId: taskId,
      url: first.pr?.url,
    });
  }
  return entries.map((e) => e.outcome!);
}

/** Run AI code review on a PR diff using Claude CLI */
/** Fetch task context (description + all developer comments) for informed review */
async function fetchTaskContext(taskId: string): Promise<{ description: string; comments: string }> {
  const settings = getSettings();
  let description = '';
  let comments = '';

  try {
    const taskResult = await clickUpProvider.getTask(settings, taskId);
    if (taskResult.success && taskResult.data) {
      // ClickUp sometimes returns description in text_content (plain text) or description (markdown)
      description = taskResult.data.text_content || taskResult.data.description || '';
    }
  } catch { /* non-critical */ }

  try {
    const commentsResult = await clickUpProvider.getComments(settings, taskId);
    if (commentsResult.success && commentsResult.data) {
      // Include ALL developer comments — filter out only bot-posted messages by signature
      const devComments = commentsResult.data
        .map((c: any) => {
          const text = extractCommentText(c).trim();
          if (!text || isBotComment(text)) return null;
          const user = c.user?.username || 'Unknown';
          const date = c.date ? new Date(Number(c.date)).toISOString().split('T')[0] : '';
          return `[${user}${date ? ` · ${date}` : ''}]: ${text}`;
        })
        .filter(Boolean);
      comments = devComments.join('\n\n');
      debugLog(`[CodeReview] Task ${taskId} context: ${devComments.length} developer comments, ${description.length} char description`);
    }
  } catch { /* non-critical */ }

  return { description, comments };
}

const SEVERITIES: CodeReviewSeverity[] = ['critical', 'major', 'minor', 'suggestion'];

/** Keys the model has been seen to use in place of the ones the prompt asks for. */
const DESCRIPTION_KEYS = ['description', 'message', 'issue', 'problem', 'details', 'detail', 'summary', 'text'];
const SUGGESTION_KEYS = ['suggestion', 'fix', 'recommendation', 'remediation'];
const FILE_KEYS = ['file', 'path', 'filename'];

/** First non-empty string among `keys`, trimmed. */
function pickString(raw: any, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Coerce one raw finding from the model into a CodeReviewFinding.
 *
 * The prompt asks for a fixed shape but nothing guarantees it, and the result
 * goes straight into a ClickUp comment and a GitHub PR comment. An entry whose
 * `description` was missing used to be posted as the literal text "undefined",
 * and an unrecognised `severity` dropped out of every group in the formatted
 * comment while still counting toward the "N issue(s) found" header.
 *
 * Returns null for an entry with no readable description — that tells the
 * developer nothing, so it is worse than reporting no finding at all.
 */
function normalizeFinding(raw: any): CodeReviewFinding | null {
  if (!raw || typeof raw !== 'object') return null;

  const description = pickString(raw, DESCRIPTION_KEYS);
  if (!description) return null;

  const rawSeverity = String(raw.severity ?? '').toLowerCase().trim();
  const severity = (SEVERITIES as string[]).includes(rawSeverity)
    ? (rawSeverity as CodeReviewSeverity)
    : 'minor'; // unknown severity is still shown, just conservatively ranked

  const lineNumber = Number(raw.line);

  return {
    severity,
    file: pickString(raw, FILE_KEYS) ?? 'unknown',
    line: Number.isFinite(lineNumber) && lineNumber > 0 ? Math.trunc(lineNumber) : undefined,
    description,
    suggestion: pickString(raw, SUGGESTION_KEYS),
  };
}

/** Validate a parsed review payload, discarding findings we can't render. */
function toReviewResult(result: any): { passed: boolean; findings: CodeReviewFinding[] } {
  const rawFindings: any[] = Array.isArray(result.findings) ? result.findings : [];
  const findings = rawFindings
    .map(normalizeFinding)
    .filter((f): f is CodeReviewFinding => f !== null);

  const dropped = rawFindings.length - findings.length;
  if (dropped > 0) {
    debugError(`[CodeReview] Discarded ${dropped} malformed finding(s) with no readable description`);
  }

  const passed = !!result.passed;
  // Every finding was unusable but the reviewer still failed the PR. Say so
  // plainly instead of posting a failure with an empty body.
  if (!passed && findings.length === 0 && rawFindings.length > 0) {
    return {
      passed: false,
      findings: [{
        severity: 'minor',
        file: 'PR',
        description: `The reviewer flagged ${rawFindings.length} issue(s) but returned no readable description for any of them. Re-run the review.`,
      }],
    };
  }

  return { passed, findings };
}

/** Try multiple strategies to extract JSON from Claude's response */
function parseReviewJSON(stdout: string): { passed: boolean; findings: CodeReviewFinding[] } {
  const raw = stdout.trim();

  // Strategy 1: Try parsing the entire output as JSON
  try {
    const result = JSON.parse(raw);
    if (typeof result === 'object' && result !== null && 'passed' in result) {
      return toReviewResult(result);
    }
  } catch { /* continue to next strategy */ }

  // Strategy 2: Extract JSON from code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const result = JSON.parse(fenceMatch[1].trim());
      if (typeof result === 'object' && result !== null && 'passed' in result) {
        return toReviewResult(result);
      }
    } catch { /* continue to next strategy */ }
  }

  // Strategy 3: Find the last complete JSON object (greedy match can grab wrong braces)
  const jsonMatches = raw.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
  if (jsonMatches) {
    // Try each match, preferring ones that have "passed" key
    for (const match of jsonMatches) {
      try {
        const result = JSON.parse(match);
        if (typeof result === 'object' && result !== null && 'passed' in result) {
          return toReviewResult(result);
        }
      } catch { /* try next match */ }
    }
  }

  // Strategy 4: Original greedy regex as fallback
  const greedyMatch = raw.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    const result = JSON.parse(greedyMatch[0]);
    if (typeof result === 'object' && result !== null && 'passed' in result) {
      return toReviewResult(result);
    }
  }

  throw new Error('No valid review JSON found in response');
}

/** Build the full initial review prompt */
/** Where the PR lives, for the review prompts: the `-R` flag for its gh
 *  commands, and a warning when the local files are a different repo. */
function promptRepo(target: RepoTarget): { flag: string; name: string; files: string } {
  const flag = target.repo ? ` -R ${target.repo}` : '';
  const name = target.repo ? ` in ${target.repo}` : '';
  const files = target.checkout
    ? 'You have full access to the project files, so you can read any source file to understand context beyond the diff.'
    : `The local files are NOT ${target.repo} — they belong to a different repository. Judge the change from the diff and \`gh\` output only, and do not cite local files.`;
  return { flag, name, files };
}

function buildInitialReviewPrompt(
  prNumber: number,
  target: RepoTarget,
  taskSection: string,
  reviewGuidelines: string,
): string {
  const repo = promptRepo(target);
  return `You are a code review agent. Your ONLY output must be a JSON object. Do not write any other text.

Analyze Pull Request #${prNumber}${repo.name} for real bugs and issues.

First, run these commands to get the PR details:
1. \`gh pr view ${prNumber}${repo.flag} --json title,files,additions,deletions\` — to see what changed
2. \`gh pr diff ${prNumber}${repo.flag}\` — to see the actual diff

Then act as a fleet of specialized reviewers — examine the changes from multiple angles: correctness, security, performance, and error handling. For each potential issue, verify it against the actual code behavior before reporting. Only report issues you are confident are real problems. ${repo.files}
${taskSection}${reviewGuidelines}
## Review Checklist

### 1. Correctness & Task Verification
- Does the code actually fix the bug or implement the feature described in the task?
- Is the root cause addressed, not just symptoms?
- Are there edge cases from the task description that aren't handled?

### 2. Logic Errors & Regressions
- New bugs introduced by this change
- Broken control flow, off-by-one errors, null/undefined access
- Race conditions, state management issues
- Verify each suspected bug by tracing the actual code path before reporting

### 3. Security Vulnerabilities
- XSS, injection, auth bypass, data leaks
- Unsafe deserialization, path traversal, SSRF
- Secrets or credentials in code

### 4. Performance
- N+1 queries, unnecessary loops, missing indexes
- Memory leaks, unbounded growth, missing cleanup
- Blocking operations in async contexts

### 5. Error Handling (at system boundaries only)
- Unhandled promise rejections or exceptions at API/DB/external service boundaries
- Silent failures that hide bugs
- Do NOT flag missing error handling in internal code paths

## Severity Guide
- **critical**: Will break production, cause data loss, or create a security vulnerability. Must fix before merge.
- **major**: Significant bug or logic error that will cause incorrect behavior. Should fix before merge.
- **minor**: Real issue but low impact — edge case mishandled, suboptimal approach. Worth noting.
- **suggestion**: Improvement opportunity — not a bug, but would make the code better.

## Rules
- ONLY report issues you are CONFIDENT about. When in doubt, leave it out.
- Do NOT report: style preferences, naming opinions, missing comments/docs, formatting, or speculative issues.
- Each finding must reference a SPECIFIC file and line from the diff.
- For critical/major issues, explain WHY the code is wrong and provide a concrete fix in the suggestion field.
- If the code correctly solves the task with no real issues, pass the review.

## Output Format
After your analysis, respond with ONLY this JSON object as your final output — no text before or after:

{"passed": false, "findings": [{"severity": "critical", "file": "src/example.ts", "line": 42, "description": "What is wrong and why", "suggestion": "How to fix it"}]}

If no issues found:

{"passed": true, "findings": []}`;
}

/** Build a follow-up prompt for re-reviewing with session context */
function buildReReviewPrompt(
  prNumber: number,
  target: RepoTarget,
  taskSection: string,
): string {
  const repo = promptRepo(target);
  return `You are a code review agent. Your ONLY output must be a JSON object. Do not write any other text, explanation, or reasoning outside the JSON.

The developer has updated PR #${prNumber}${repo.name} after your previous review. Please re-review the changes.

1. Run \`gh pr diff ${prNumber}${repo.flag}\` to see the current diff
2. Compare against your previous findings — check which issues have been fixed
3. If a developer has commented explaining why the code is correct, consider their reasoning carefully
4. Look for any NEW issues introduced by their changes
${taskSection}
## Important
- If all previous findings are fixed and no new issues exist, PASS the review
- If the developer's explanation is valid and the code is correct as-is, PASS the review
- Only report issues that STILL exist or are NEW — do not repeat fixed findings
- You have full context from the previous review, use it

## Output Format
Respond with ONLY this JSON object — no text before or after:

{"passed": false, "findings": [{"severity": "critical", "file": "src/example.ts", "line": 42, "description": "What is wrong and why", "suggestion": "How to fix it"}]}

If all issues are resolved:

{"passed": true, "findings": []}`;
}

/** Spawn a single `claude` review invocation and resolve with its stdout. */
function runClaudeReviewProcess(
  args: string[],
  prompt: string,
  projectPath: string,
  taskId: string | undefined,
  timeoutMs: number,
): Promise<{ stdout: string; code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn('claude', args, {
      env,
      cwd: projectPath,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track for cancellation
    if (taskId) activeReviews.set(taskId, child);

    // Write prompt to stdin (avoids command line length limits)
    child.stdin?.write(prompt);
    child.stdin?.end();

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Code review timed out after 20 minutes'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code: number) => {
      if (taskId) activeReviews.delete(taskId);
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, code, stderr });
    });

    child.on('error', (err: Error) => {
      if (taskId) activeReviews.delete(taskId);
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Nudge prompt used when the first review response wasn't valid JSON. */
const JSON_ONLY_RETRY_PROMPT = `Your previous response was not valid JSON, so it could not be processed.

Do NOT redo the review. Based on the review you just completed, output ONLY a single JSON object — no prose, no explanation, no markdown code fences, nothing before or after it.

Use exactly this shape:
{"passed": false, "findings": [{"severity": "critical", "file": "src/example.ts", "line": 42, "description": "What is wrong and why", "suggestion": "How to fix it"}]}

If there are no remaining issues:
{"passed": true, "findings": []}`;

async function runAIReview(
  prNumber: number,
  target: RepoTarget,
  taskContext?: { taskName?: string; description?: string; comments?: string },
  taskId?: string,
): Promise<{ passed: boolean; findings: CodeReviewFinding[] }> {
  const agentProvider = agentRegistry.get('claude');
  if (!agentProvider || !agentProvider.isAvailable()) {
    throw new Error('Claude Code CLI is not installed. Install with: npm install -g @anthropic-ai/claude-code');
  }

  // Build task context section — give Claude the full picture (generous limits since context is critical)
  let taskSection = '';
  if (taskContext) {
    const parts: string[] = [];
    if (taskContext.taskName) parts.push(`Task: ${taskContext.taskName}`);
    if (taskContext.description) {
      const desc = taskContext.description.length > 10000
        ? taskContext.description.substring(0, 10000) + '\n...[description truncated]'
        : taskContext.description;
      parts.push(`Task Description / Bug Report:\n${desc}`);
    }
    if (taskContext.comments) {
      const comm = taskContext.comments.length > 8000
        ? taskContext.comments.substring(0, 8000) + '\n...[older comments truncated]'
        : taskContext.comments;
      parts.push(`Developer Comments (all, chronological):\n${comm}`);
    }
    if (parts.length > 0) {
      taskSection = `\n--- TASK CONTEXT ---\n${parts.join('\n\n')}\n--- END TASK CONTEXT ---\n`;
    }
  }

  // Read REVIEW.md from the PR's own repo if it exists — never another repo's
  let reviewGuidelines = '';
  try {
    if (!target.checkout) throw new Error('No local checkout of this repo');
    const reviewMdPath = path.join(target.cwd, 'REVIEW.md');
    const content = await fs.promises.readFile(reviewMdPath, 'utf-8');
    if (content.trim()) {
      const trimmed = content.length > 3000
        ? content.substring(0, 3000) + '\n...[truncated]'
        : content;
      reviewGuidelines = `\n--- PROJECT REVIEW GUIDELINES (from REVIEW.md) ---\n${trimmed}\n--- END REVIEW GUIDELINES ---\n`;
    }
  } catch { /* REVIEW.md not found — that's fine */ }

  // Check if we have an existing session for this task/PR (re-review)
  const sessionKey = taskId ? getSessionKey(taskId, prNumber, target.repo) : null;
  const existingSessionId = sessionKey ? reviewSessions.get(sessionKey) : null;
  const isReReview = !!existingSessionId;

  // Generate or reuse session ID
  const sessionId = existingSessionId || uuidv4();
  if (sessionKey && !existingSessionId) {
    reviewSessions.set(sessionKey, sessionId);
    debugLog(`[CodeReview] New session ${sessionId} for ${sessionKey}`);
  } else if (isReReview) {
    debugLog(`[CodeReview] Resuming session ${sessionId} for ${sessionKey}`);
  }

  const prompt = isReReview
    ? buildReReviewPrompt(prNumber, target, taskSection)
    : buildInitialReviewPrompt(prNumber, target, taskSection, reviewGuidelines);

  // Claude fetches diff + reads files itself, so allow generous timeout (20 min)
  const timeoutMs = 20 * 60_000;

  // Build args for a run. `resume` reuses the existing session (full prior context);
  // otherwise start a new session whose ID we can resume later.
  const buildArgs = (resume: boolean): string[] => {
    const args = ['--output-format', 'text', '--model', 'claude-sonnet-4-6', '-p'];
    if (resume) {
      args.push('--resume', sessionId);
    } else {
      args.push('--session-id', sessionId);
    }
    args.push('--add-dir', target.cwd);
    return args;
  };

  // First attempt
  const first = await runClaudeReviewProcess(buildArgs(isReReview), prompt, target.cwd, taskId, timeoutMs);
  if (first.code !== 0 && !first.stdout) {
    throw new Error(first.stderr.trim() || `Claude exited with code ${first.code}`);
  }

  try {
    return parseReviewJSON(first.stdout);
  } catch {
    // Claude did the review but emitted prose instead of JSON. Resume the same
    // session (so it keeps full context) and ask it to re-emit as JSON only.
    debugLog('[CodeReview] First response was not valid JSON — retrying with JSON-only nudge');
  }

  const retry = await runClaudeReviewProcess(buildArgs(true), JSON_ONLY_RETRY_PROMPT, target.cwd, taskId, timeoutMs);

  try {
    return parseReviewJSON(retry.stdout);
  } catch {
    // Surface the fuller raw output (retry preferred, else the original) so the
    // finding at least carries the reviewer's actual conclusion.
    const rawOutput = (retry.stdout.trim() || first.stdout.trim());
    debugError('[CodeReview] Failed to parse AI response after retry:', rawOutput.substring(0, 800));
    return {
      passed: false,
      findings: [{
        severity: 'minor',
        file: 'unknown',
        description: `Review completed but response could not be parsed. Raw output: ${rawOutput.substring(0, 800)}`,
      }],
    };
  }
}

/** Format findings into a readable comment */
function formatReviewComment(prTitle: string, findings: CodeReviewFinding[], passed: boolean): string {
  if (passed) {
    return `## ✅ Code Review Passed\n\n**PR:** ${prTitle}\n\nAll checks passed. No significant issues found.\n\n---\n_Automated review by Agent Terminal_`;
  }

  const severityEmoji: Record<string, string> = {
    critical: '🔴',
    major: '🟠',
    minor: '🟡',
    suggestion: '💡',
  };

  const lines = [`## ❌ Code Review — ${findings.length} issue(s) found\n\n**PR:** ${prTitle}\n`];

  for (const sev of ['critical', 'major', 'minor', 'suggestion'] as const) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;

    lines.push(`### ${severityEmoji[sev]} ${sev.charAt(0).toUpperCase() + sev.slice(1)} (${group.length})\n`);
    for (const f of group) {
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(`- **${loc}**: ${f.description}`);
      if (f.suggestion) lines.push(`  - 💡 Fix: ${f.suggestion}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('💬 If the code is correct and no changes are needed, add a comment with **review:approve** to override this review.');
  lines.push('\n_Automated review by Agent Terminal_');
  return lines.join('\n');
}

/**
 * Fetch ALL tasks matching the given statuses across pages.
 * `searchTasks` returns only a single page (max 100) when there's no text query,
 * so a list with >100 tasks in review statuses would silently drop the rest.
 */
async function fetchAllReviewTasks(
  settings: AppSettings,
  statuses: string[],
  listId: string,
): Promise<TaskManagerTask[]> {
  const all: TaskManagerTask[] = [];
  const PAGE_SIZE = 100; // ClickUp returns up to 100 tasks per page
  const MAX_PAGES = 30; // safety cap (3000 tasks)

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await clickUpProvider.searchTasks(settings, '', { statuses }, listId, page);
    if (!result.success) {
      // Surface the error if even the first page fails; otherwise keep what we have
      if (page === 0) throw new Error(result.error || 'Failed to fetch review tasks');
      break;
    }
    const tasks = result.data || [];
    all.push(...tasks);
    if (tasks.length < PAGE_SIZE) break; // last page reached
  }

  debugLog(`[CodeReview] Fetched ${all.length} task(s) across pages for list ${listId}`);
  return all;
}

/**
 * Fetch all review-status tasks across every selected list, de-duplicated
 * (ClickUp allows a task to live in more than one list).
 *
 * Prefers the single `list_ids[]` query, which returns the whole set 100 at a
 * time regardless of how many lists are selected. Per-list paging is kept as a
 * fallback for workspaces where the team id isn't configured.
 */
async function fetchReviewTasks(
  settings: AppSettings,
  statuses: string[],
  listIds: string[],
): Promise<TaskManagerTask[]> {
  const ids = [...new Set(listIds.map((id) => (id || '').trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  let tasks: TaskManagerTask[] | null = null;

  if (settings.clickupWorkspaceId) {
    const bulk = await clickUpProvider.searchTasksInLists(settings, statuses, ids);
    if (bulk.success) {
      tasks = bulk.data;
    } else {
      debugError('[CodeReview] Multi-list fetch failed, falling back to per-list paging:', bulk.error);
    }
  }

  if (!tasks) {
    const perList = await Promise.all(ids.map((lid) => fetchAllReviewTasks(settings, statuses, lid)));
    tasks = perList.flat();
  }

  const seen = new Set<string>();
  const unique: TaskManagerTask[] = [];
  for (const task of tasks) {
    if (!seen.has(task.id)) {
      seen.add(task.id);
      unique.push(task);
    }
  }
  return unique;
}

/** Build the renderer-facing PR list for one task from resolved PRs. */
async function toReviewPRs(prs: PRInfo[], lookup: PRLookup): Promise<CodeReviewPR[]> {
  return Promise.all(prs.map(async (pr) => {
    const meta = (await lookup.openPRs(pr.repo))?.byNumber.get(pr.prNumber);
    return {
      prNumber: pr.prNumber,
      prRepo: pr.repo ?? undefined,
      prUrl: pr.prUrl ?? meta?.url ?? undefined,
      prTitle: meta?.title,
      prBranch: meta?.branch,
      prBaseBranch: meta?.baseBranch,
      prAuthor: meta?.author,
      status: 'pending' as const,
      findings: [],
    };
  }));
}

/**
 * Phase 2 of the Code Review load: match each task to its PRs and push the
 * result to the renderer as it lands, instead of holding the task list back
 * until every task is resolved.
 *
 * Resolves all tasks together against `lookup`'s shared `gh` listings; the
 * ClickUp comment reads go through the provider's rate gate concurrently.
 *
 * Never throws: it runs detached from the IPC call, so a failure here must not
 * become an unhandled rejection. A task that fails to resolve still gets an
 * event, so the UI drops its "resolving" state instead of spinning forever.
 */
async function resolvePRsForTasks(
  tasks: Array<{ id: string; customId?: string; description?: string; name?: string }>,
  lookup: PRLookup,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  if (tasks.length === 0) return;
  try {
    await Promise.all(
      tasks.map(async (task) => {
        let prs: CodeReviewPR[] = [];
        try {
          prs = await toReviewPRs(await findPRsForTask(task, lookup), lookup);
        } catch (err) {
          debugError(`[CodeReview] Failed to resolve PRs for task ${task.id}:`, err);
        }
        sendReviewEvent(getWindow, { type: 'prs', taskId: task.id, prs });
      }),
    );
  } catch (err) {
    debugError('[CodeReview] PR resolution pass failed:', err);
    // Clear every task's resolving state so the UI does not spin forever.
    for (const task of tasks) sendReviewEvent(getWindow, { type: 'prs', taskId: task.id, prs: [] });
  }
}

// ─── Auto-review: run a full cycle ───────────────────────────
async function runAutoReviewCycle(getWindow: () => BrowserWindow | null): Promise<void> {
  if (schedulerRunning) {
    debugLog('[CodeReview] Scheduler: skipping — previous cycle still running');
    return;
  }

  const settings = getSettings();
  if (!settings.codeReviewEnabled) return;
  if (settings.taskManagerProvider !== 'clickup') return;
  if (!settings.clickupListId) return;
  if (!settings.codeReviewProjectPath) return;

  schedulerRunning = true;
  lastSchedulerRun = new Date().toISOString();
  const projectPath = settings.codeReviewProjectPath;
  const tagName = settings.codeReviewTagName || 'reviewpass';
  const statuses = (settings.codeReviewStatuses || 'ready for review, in review, review')
    .split(',').map((s) => s.trim()).filter(Boolean);

  debugLog('[CodeReview] Scheduler: starting auto-review cycle');

  // Notify UI
  sendReviewEvent(getWindow, {
    type: 'progress',
    taskId: '__scheduler__',
    message: 'Auto-review cycle started...',
  });

  try {
    // One open-PR listing per repo for the whole cycle, the selected repo's
    // started alongside the task fetch — findPRsForTask matches against it in
    // memory instead of shelling out to gh per task.
    const lookup = createPRLookup(projectPath);
    void lookup.openPRs(null);

    // 1. Fetch ALL reviewable tasks across pages (a single page caps at 100)
    let tasks: TaskManagerTask[];
    try {
      tasks = await fetchReviewTasks(settings, statuses, [settings.clickupListId]);
    } catch (err) {
      debugError('[CodeReview] Scheduler: failed to fetch tasks:', err);
      return; // `finally` resets schedulerRunning
    }
    if (!tasks.length) {
      debugLog('[CodeReview] Scheduler: no tasks found for review');
      return;
    }

    debugLog(`[CodeReview] Scheduler: found ${tasks.length} tasks`);

    // 2. Review each task
    stopAllRequested = false;
    for (const task of tasks) {
      if (stopAllRequested) {
        debugLog('[CodeReview] Scheduler: stop-all requested, aborting cycle');
        break;
      }
      // Check if already tagged with reviewpass (skip re-review)
      const hasTag = task.tags?.some((t) => t.name.toLowerCase() === tagName.toLowerCase());
      if (hasTag) {
        debugLog(`[CodeReview] Scheduler: skipping task ${task.id} — already has "${tagName}" tag`);
        continue;
      }

      // Skip tasks flagged for manual review — the reviewer will handle them by hand
      if (hasManualReviewTag(task)) {
        debugLog(`[CodeReview] Scheduler: skipping task ${task.id} — tagged "${MANUAL_REVIEW_TAG}"`);
        continue;
      }

      // Find all PRs for this task
      const prs = await findPRsForTask(task, lookup);

      // A developer approval comment (e.g. "review:approve") overrides the AI
      // findings, but not the test requirement — approved code must still be
      // tested. A task with no PR has no head to test, so it is approved as before.
      if (await hasApprovalComment(task.id)) {
        let untested: CodeReviewFinding[] = [];
        try {
          untested = await approvalTestGaps(projectPath, task.id, prs);
        } catch (err) {
          debugError(`[CodeReview] Scheduler: test evidence check failed for task ${task.id}:`, err);
          continue; // retried next cycle
        }
        if (untested.length === 0) {
          debugLog(`[CodeReview] Scheduler: task ${task.id} has developer approval comment — auto-approving`);
          await clickUpProvider.addTag(settings, task.id, tagName);
          await clickUpProvider.postComment(
            settings,
            task.id,
            `✅ Code Review Approved — Developer confirmed the code is correct via approval comment.\n\n_Automated by Agent Terminal_`,
          );
          clearAllSessionsForTask(task.id);
          sendReviewEvent(getWindow, { type: 'done', taskId: task.id, status: 'passed' });
        } else {
          debugLog(`[CodeReview] Scheduler: task ${task.id} approved but untested — failing review`);
          await clickUpProvider.postComment(settings, task.id, formatReviewComment(task.name, untested, false));
          await clickUpProvider.updateStatus(settings, task.id, 'review failed').catch(() => {});
          sendReviewEvent(getWindow, { type: 'done', taskId: task.id, status: 'failed', findings: untested });
        }
        continue;
      }

      // No PR found — ask for it via comment
      if (prs.length === 0) {
        debugLog(`[CodeReview] Scheduler: task ${task.id} has no PR — posting comment`);
        await clickUpProvider.postComment(
          settings,
          task.id,
          `⚠️ **Code Review**: This task is marked as ready for review, but no Pull Request was found.\n\nPlease either:\n- Include the PR URL in a comment (e.g. \`https://github.com/org/repo/pull/123\`)\n- Use the task ID \`${task.customId || task.id}\` in your branch name so it can be matched automatically.\n\n_Automated by Agent Terminal_`,
        );
        continue;
      }

      // Review each PR for this task
      let allPassed = true;
      let anyFailed = false;
      const allFindings: CodeReviewFinding[] = [];
      // PRs that passed in this cycle, with the head they were reviewed at.
      const passedPRs: MergeRequest[] = [];

      for (const pr of prs) {
        if (stopAllRequested) break;
        const prNumber = pr.prNumber;
        const eventTaskId = prs.length > 1 ? `${task.id}__pr${prNumber}` : task.id;

        try {
          sendReviewEvent(getWindow, { type: 'progress', taskId: eventTaskId, message: `Checking PR #${prNumber}...` });

          // Fetch PR info from the PR's own repo — check if it's still open
          const target = await resolveTarget(projectPath, pr.repo);
          const prInfo = await fetchPRInfo(target, prNumber);
          if (prInfo.state !== 'OPEN') {
            debugLog(`[CodeReview] Scheduler: skipping task ${task.id} — PR #${prNumber} is ${prInfo.state}`);
            sendReviewEvent(getWindow, {
              type: 'done',
              taskId: eventTaskId,
              status: 'skipped',
              message: `PR #${prNumber} is ${prInfo.state.toLowerCase()}, skipped.`,
            });
            continue;
          }

          sendReviewEvent(getWindow, { type: 'progress', taskId: eventTaskId, message: `Reviewing PR #${prNumber}...` });

          // Fetch task context for informed review
          const taskCtx = await fetchTaskContext(task.id);

          // Run AI review — Claude fetches the diff itself
          const result = await runAIReview(prNumber, target, {
            taskName: task.name,
            description: taskCtx.description,
            comments: taskCtx.comments,
          }, eventTaskId);

          // Check for merge conflicts after review and append as a finding
          if (prInfo.mergeable === 'CONFLICTING') {
            debugLog(`[CodeReview] Scheduler: task ${task.id} — PR #${prNumber} has merge conflicts`);
            result.findings.push({
              severity: 'critical',
              file: 'PR',
              description: `PR #${prNumber}: This Pull Request has merge conflicts and cannot be merged. Please resolve the conflicts.`,
            });
            result.passed = false;
          }

          // Checked after the AI review, not instead of it, so the developer
          // gets the code findings and the missing tests in one round.
          const tested = await checkTestEvidence(task.id, target, prNumber);
          if (tested.finding) {
            result.findings.push(tested.finding);
            result.passed = false;
          }

          const comment = formatReviewComment(prInfo.title, result.findings, result.passed);

          if (result.passed) {
            await clickUpProvider.postComment(settings, task.id, `✅ Code Review Passed — ${prLabel(target, prNumber)} reviewed automatically. No significant issues found.${testedLine(tested.evidence && describeTestEvidence(tested.evidence))}\n\n_Automated by Agent Terminal_`);
            passedPRs.push({ prNumber, repo: target.repo, reviewedHeadSha: prInfo.headSha });
            debugLog(`[CodeReview] Scheduler: task ${task.id} PR #${prNumber} PASSED`);
          } else {
            allPassed = false;
            anyFailed = true;
            allFindings.push(...result.findings);
            await clickUpProvider.postComment(settings, task.id, comment);
            // Post comment on GitHub PR
            try {
              await postPRComment(target, prNumber, comment);
            } catch {
              // Non-critical
            }
            debugLog(`[CodeReview] Scheduler: task ${task.id} PR #${prNumber} FAILED with ${result.findings.length} findings`);
            const crit = result.findings.filter((f) => f.severity === 'critical').length;
            recordActivity({
              source: 'code-review',
              kind: 'review-failed',
              level: 'error',
              title: `Code review failed: ${task.name || `PR #${prNumber}`}`,
              message: `${result.findings.length} finding(s)${crit ? `, ${crit} critical` : ''} on PR #${prNumber}.`,
              clickupTaskId: task.id,
              taskName: task.name,
              url: prInfo.url,
            });
          }

          sendReviewEvent(getWindow, {
            type: 'done',
            taskId: eventTaskId,
            status: result.passed ? 'passed' : 'failed',
            findings: result.findings,
          });
        } catch (err) {
          allPassed = false;
          debugError(`[CodeReview] Scheduler: error reviewing task ${task.id} PR #${prNumber}:`, err);
          sendReviewEvent(getWindow, {
            type: 'error',
            taskId: eventTaskId,
            message: err instanceof Error ? err.message : 'Auto-review failed',
          });
        }
      }

      // Update task status based on combined results of all PRs
      if (allPassed && prs.length > 0) {
        await clickUpProvider.addTag(settings, task.id, tagName);
        clearAllSessionsForTask(task.id);
        // Read live so flipping the toggle mid-cycle takes effect. All the
        // task's PRs go together, so a fix split across repos lands whole.
        if (getSettings().codeReviewAutoMerge && passedPRs.length > 0 && !stopAllRequested) {
          await mergeTaskPullRequests(getWindow, projectPath, task.id, passedPRs, { auto: true });
        }
      } else if (anyFailed) {
        try {
          await clickUpProvider.updateStatus(settings, task.id, 'review failed');
          debugLog(`[CodeReview] Scheduler: task ${task.id} status changed to "review failed"`);
        } catch (statusErr) {
          debugError('[CodeReview] Failed to update task status:', statusErr);
        }
      }
    }

    debugLog('[CodeReview] Scheduler: auto-review cycle complete');
  } catch (err) {
    debugError('[CodeReview] Scheduler: cycle error:', err);
  } finally {
    schedulerRunning = false;
  }
}

function startScheduler(getWindow: () => BrowserWindow | null): { success: boolean; nextRun?: string } {
  const settings = getSettings();
  const intervalMinutes = settings.codeReviewIntervalMinutes || 60;

  stopScheduler();

  const intervalMs = intervalMinutes * 60 * 1000;
  nextSchedulerRun = new Date(Date.now() + intervalMs).toISOString();

  debugLog(`[CodeReview] Scheduler: started, interval = ${intervalMinutes}m, next run at ${nextSchedulerRun}`);

  // Run immediately on first start
  runAutoReviewCycle(getWindow);

  schedulerInterval = setInterval(() => {
    nextSchedulerRun = new Date(Date.now() + intervalMs).toISOString();
    runAutoReviewCycle(getWindow);
  }, intervalMs);

  return { success: true, nextRun: nextSchedulerRun };
}

function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  nextSchedulerRun = null;
  debugLog('[CodeReview] Scheduler: stopped');
}

export function stopCodeReviewScheduler(): void {
  stopScheduler();
}

export function registerCodeReviewHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  // Auto-start scheduler if enabled in settings
  setTimeout(() => {
    // Always, not behind the scheduler toggle: a Merge-button merge queues
    // the AI QC round too, and a queued round must survive a restart.
    startPostMergeQc();
    const settings = getSettings();
    if (settings.codeReviewEnabled && settings.codeReviewProjectPath) {
      debugLog('[CodeReview] Auto-starting scheduler from settings');
      startScheduler(getWindow);
    }
  }, 5000); // Delay to let app fully initialize

  // ─── Task fetching ───────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_GET_TASKS,
    async (_event, reviewStatuses?: string[], projectPath?: string, listIds?: string[]) => {
      try {
        const settings = getSettings();
        if (settings.taskManagerProvider !== 'clickup') {
          return { success: false, error: 'Code Review requires ClickUp integration. Configure it in Settings.' };
        }

        const targetListIds = (listIds && listIds.length)
          ? listIds
          : (settings.clickupListId ? [settings.clickupListId] : []);
        if (targetListIds.length === 0) return { success: false, error: 'No ClickUp list configured' };

        const statuses = reviewStatuses || ['ready for review', 'in review', 'review'];
        const effectiveProjectPath = projectPath || settings.codeReviewProjectPath;

        // Start the open-PR listing NOW rather than after the tasks land. It's
        // an independent multi-second shell round-trip to GitHub, and running
        // it after the ClickUp fetch simply added its latency to the total.
        // fetchOpenPRMetadata resolves to null on failure, so this never
        // rejects unhandled while the task fetch is in flight.
        const lookup = createPRLookup(effectiveProjectPath || undefined);
        void lookup.openPRs(null);

        const allTasks = await fetchReviewTasks(settings, statuses, targetListIds);

        // Filter out tasks that already have the reviewpass tag, or are flagged for manual review
        const tagName = (settings.codeReviewTagName || 'reviewpass').toLowerCase();
        const filteredTasks = allTasks.filter((task) => {
          const hasTag = task.tags?.some((t) => t.name.toLowerCase() === tagName);
          if (hasTag) {
            debugLog(`[CodeReview] Skipping task ${task.id} — already has "${tagName}" tag`);
            return false;
          }
          if (hasManualReviewTag(task)) {
            debugLog(`[CodeReview] Skipping task ${task.id} — tagged "${MANUAL_REVIEW_TAG}"`);
            return false;
          }
          return true;
        });

        // Two-phase PR resolution. Resolving a task's PRs needs the `gh`
        // listing — a shell round-trip that pages GitHub 100 PRs at a time —
        // and, for tasks it can't match by branch, one ClickUp comment read
        // each. Together that used to be the larger half of the load, and the
        // whole task list sat behind a spinner waiting for it even though
        // ClickUp had already answered.
        //
        // Phase 1 (here): return every task the moment ClickUp answers, with
        // an empty PR list marked `prsResolving` so the UI shows "finding PRs"
        // rather than the "no PR found" warning. Nothing partial is shown —
        // a PR listed now that phase 2 then filtered out as closed would just
        // flicker.
        //
        // Phase 2 (below, after this returns): the real resolution, pushed to
        // the renderer per task as `prs` events.
        const items: CodeReviewItem[] = filteredTasks.map((task) => ({
          taskId: task.id,
          taskName: task.name,
          taskUrl: task.url,
          customId: task.customId,
          status: 'pending' as const,
          findings: [],
          prs: [],
          prsResolving: true,
        }));

        void resolvePRsForTasks(filteredTasks, lookup, getWindow);

        return { success: true, data: items };
      } catch (error) {
        debugError('[CodeReview] getReviewTasks error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch review tasks' };
      }
    },
  );

  // ─── PR info ─────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_GET_PR_INFO,
    async (_event, projectPath: string, prNumber: number, prRepo?: string) => {
      try {
        const info = await fetchPRInfo(await resolveTarget(projectPath, prRepo), prNumber);
        return { success: true, data: info };
      } catch (error) {
        debugError('[CodeReview] getPRInfo error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch PR info' };
      }
    },
  );

  // ─── Single review ──────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_RUN,
    async (_event, projectPath: string, taskId: string, prNumber: number, prRepo?: string) => {
      try {
        sendReviewEvent(getWindow, { type: 'progress', taskId, message: `Checking PR #${prNumber}...` });
        const target = await resolveTarget(projectPath, prRepo);

        const prInfo = await fetchPRInfo(target, prNumber);

        // Check if developer posted an approval comment — auto-pass if so. The
        // approval overrides the AI findings, not the test requirement: an
        // untested PR fails even when approved.
        if (await hasApprovalComment(taskId)) {
          const tested = prInfo.state === 'OPEN'
            ? await checkTestEvidence(taskId, target, prNumber)
            : { evidence: null, finding: null };
          if (tested.finding) {
            debugLog(`[CodeReview] Task ${taskId} has developer approval but no test evidence — failing`);
            sendReviewEvent(getWindow, { type: 'done', taskId, status: 'failed', findings: [tested.finding] });
            return {
              success: true,
              data: {
                passed: false,
                findings: [tested.finding],
                prTitle: prInfo.title,
                prUrl: prInfo.url,
                prBranch: prInfo.branch,
                prBaseBranch: prInfo.baseBranch,
                prAuthor: prInfo.author,
                prHeadSha: prInfo.headSha,
              },
            };
          }
          debugLog(`[CodeReview] Task ${taskId} has developer approval — auto-passing`);
          sendReviewEvent(getWindow, { type: 'done', taskId, status: 'passed' });
          // Submit the approval
          const settings = getSettings();
          const tagName = settings.codeReviewTagName || 'reviewpass';
          const testedBy = tested.evidence ? describeTestEvidence(tested.evidence) : undefined;
          await clickUpProvider.addTag(settings, taskId, tagName);
          await clickUpProvider.postComment(
            settings,
            taskId,
            `✅ Code Review Approved — Developer confirmed the code is correct via approval comment.${testedLine(testedBy)}\n\n_Automated by Agent Terminal_`,
          );
          clearReviewSession(taskId, prNumber, target.repo);
          return { success: true, data: { passed: true, findings: [], prTitle: '', prUrl: '', prBranch: '', approved: true, testedBy } };
        }

        // Only review open PRs
        if (prInfo.state !== 'OPEN') {
          const msg = `PR #${prNumber} is ${prInfo.state.toLowerCase()}, skipped.`;
          sendReviewEvent(getWindow, { type: 'done', taskId, status: 'skipped', message: msg });
          return { success: true, data: { passed: false, findings: [], prTitle: prInfo.title, prUrl: prInfo.url, prBranch: prInfo.branch, prBaseBranch: prInfo.baseBranch, prAuthor: prInfo.author, skipped: true } };
        }

        sendReviewEvent(getWindow, { type: 'progress', taskId, message: `Reviewing PR #${prNumber}...` });

        // Fetch task context for informed review
        const taskCtx = await fetchTaskContext(taskId);

        // Claude fetches the diff itself via gh CLI
        const result = await runAIReview(prNumber, target, {
          taskName: prInfo.title,
          description: taskCtx.description,
          comments: taskCtx.comments,
        }, taskId);

        // Check for merge conflicts after review and append as a finding
        if (prInfo.mergeable === 'CONFLICTING') {
          result.findings.push({
            severity: 'critical',
            file: 'PR',
            description: 'This Pull Request has merge conflicts and cannot be merged. Please resolve the conflicts.',
          });
          result.passed = false;
        }

        // After the AI review, so the developer gets code findings and missing
        // tests in one round.
        const tested = await checkTestEvidence(taskId, target, prNumber);
        if (tested.finding) {
          result.findings.push(tested.finding);
          result.passed = false;
        }

        for (const finding of result.findings) {
          sendReviewEvent(getWindow, { type: 'finding', taskId, finding });
        }

        sendReviewEvent(getWindow, {
          type: 'done',
          taskId,
          status: result.passed ? 'passed' : 'failed',
          findings: result.findings,
        });

        return {
          success: true,
          data: {
            passed: result.passed,
            findings: result.findings,
            prTitle: prInfo.title,
            prUrl: prInfo.url,
            prBranch: prInfo.branch,
            prBaseBranch: prInfo.baseBranch,
            prAuthor: prInfo.author,
            prHeadSha: prInfo.headSha,
            testedBy: tested.evidence ? describeTestEvidence(tested.evidence) : undefined,
          },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Review failed';
        sendReviewEvent(getWindow, { type: 'error', taskId, message: msg });
        return { success: false, error: msg };
      }
    },
  );

  // ─── Submit results ─────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_SUBMIT,
    async (_event, projectPath: string, taskId: string, prNumber: number, passed: boolean, findings: CodeReviewFinding[], prTitle: string, prRepo?: string, testedBy?: string) => {
      try {
        const settings = getSettings();
        const target = await resolveTarget(projectPath, prRepo);
        const tagName = settings.codeReviewTagName || 'reviewpass';
        const comment = formatReviewComment(prTitle, findings, passed);

        if (passed) {
          const tagResult = await clickUpProvider.addTag(settings, taskId, tagName);
          if (!tagResult.success) {
            debugError('[CodeReview] Failed to add tag:', tagResult.error);
          }
          await clickUpProvider.postComment(settings, taskId, `✅ Code Review Passed — ${prLabel(target, prNumber)} reviewed automatically. No significant issues found.${testedLine(testedBy)}\n\n_Automated by Agent Terminal_`);
          // Clear the review session — no longer needed
          clearReviewSession(taskId, prNumber, target.repo);
          debugLog('[CodeReview] Review passed, tag added for task:', taskId);
        } else {
          // Post detailed comment on ClickUp
          await clickUpProvider.postComment(settings, taskId, comment);
          // Change task status to "review failed"
          try {
            await clickUpProvider.updateStatus(settings, taskId, 'review failed');
            debugLog('[CodeReview] Task status changed to "review failed" for:', taskId);
          } catch (statusErr) {
            debugError('[CodeReview] Failed to update task status:', statusErr);
          }
          // Post comment on GitHub PR
          try {
            await postPRComment(target, prNumber, comment);
            debugLog(`[CodeReview] Posted review comment on ${prLabel(target, prNumber)}`);
          } catch (ghErr) {
            debugError('[CodeReview] Failed to post GitHub comment:', ghErr);
          }
        }

        return { success: true };
      } catch (error) {
        debugError('[CodeReview] submitReview error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to submit review' };
      }
    },
  );

  // ─── Force approve (manual override) ────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_FORCE_APPROVE,
    async (_event, projectPath: string, taskId: string, prNumber: number, prTitle: string, prRepo?: string) => {
      try {
        const settings = getSettings();
        const tagName = settings.codeReviewTagName || 'reviewpass';
        const target = await resolveTarget(projectPath, prRepo);

        // Add reviewpass tag
        const tagResult = await clickUpProvider.addTag(settings, taskId, tagName);
        if (!tagResult.success) {
          debugError('[CodeReview] Force approve — failed to add tag:', tagResult.error);
        }

        // Post approval comment on ClickUp
        await clickUpProvider.postComment(
          settings,
          taskId,
          `✅ Code Review Manually Approved — ${prLabel(target, prNumber, prTitle)} was approved by the reviewer. Previous findings were reviewed and accepted as correct.\n\n_Approved via Agent Terminal_`,
        );

        // Post approval comment on GitHub PR
        try {
          const comment = `## ✅ Code Review — Manually Approved\n\n**PR:** ${prTitle}\n\nPrevious findings were reviewed and accepted as correct. No changes required.\n\n---\n_Approved via Agent Terminal_`;
          await postPRComment(target, prNumber, comment);
        } catch (ghErr) {
          debugError('[CodeReview] Force approve — failed to post GitHub comment:', ghErr);
        }

        // Clear the review session — no longer needed
        clearReviewSession(taskId, prNumber, target.repo);
        sendReviewEvent(getWindow, { type: 'done', taskId, status: 'passed' });
        debugLog(`[CodeReview] Force approved task ${taskId} PR #${prNumber}`);
        return { success: true };
      } catch (error) {
        debugError('[CodeReview] Force approve error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to approve' };
      }
    },
  );

  // ─── Manual test note ───────────────────────────────────────
  // Posts the `test:manual` comment the test evidence gate looks for, for a
  // developer who tested by hand. It is posted as whoever is signed in, so it
  // stays their word, with their name and the time on it.
  ipcMain.handle(IPC_CHANNELS.CODE_REVIEW_MARK_TESTED, async (_event, taskId: string, note: string) => {
    try {
      const text = (note || '').trim();
      if (text.length < MIN_MANUAL_NOTE_LENGTH) {
        return { success: false, error: `Describe what you tested and the result (at least ${MIN_MANUAL_NOTE_LENGTH} characters).` };
      }
      const result = await clickUpProvider.postComment(getSettings(), taskId, `test:manual\n${text}`);
      return result.success ? { success: true } : { success: false, error: result.error };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to post the test note' };
    }
  });

  // ─── Add PR manually ────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_ADD_PR,
    async (_event, projectPath: string, prInput: string) => {
      try {
        const trimmed = (prInput || '').trim();
        if (!trimmed) return { success: false, error: 'PR URL or number is required' };
        if (!projectPath) return { success: false, error: 'Project path is required' };

        // Accept: full URL (any repo — a task can need PRs in several), #123,
        // or plain number (the selected project's repo)
        let prNumber: number | null = null;
        let prRepo: string | null = null;
        const urlMatch = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
        if (urlMatch) {
          prRepo = `${urlMatch[1]}/${urlMatch[2]}`;
          prNumber = parseInt(urlMatch[3], 10);
        } else {
          const numMatch = trimmed.match(/^#?(\d+)$/);
          if (numMatch) prNumber = parseInt(numMatch[1], 10);
        }

        if (!prNumber || Number.isNaN(prNumber)) {
          return { success: false, error: 'Invalid PR — paste a GitHub PR URL or PR number' };
        }

        // Validate the PR exists in its repo
        const target = await resolveTarget(projectPath, prRepo);
        const info = await fetchPRInfo(target, prNumber);
        return {
          success: true,
          data: {
            prNumber,
            prRepo: target.repo ?? undefined,
            prUrl: info.url,
            prBranch: info.branch,
            prBaseBranch: info.baseBranch,
            prAuthor: info.author,
            prTitle: info.title,
            state: info.state,
          },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to add PR';
        debugError('[CodeReview] addPR error:', error);
        return { success: false, error: msg };
      }
    },
  );

  // ─── Merge ──────────────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_MERGE,
    async (_event, projectPath: string, taskId: string, prNumber: number, options?: { reviewedHeadSha?: string; auto?: boolean; prRepo?: string }) => {
      if (!projectPath) return { success: false, error: 'Project path is required' };
      const [outcome] = await mergeTaskPullRequests(
        getWindow, projectPath, taskId,
        [{ prNumber, repo: options?.prRepo, reviewedHeadSha: options?.reviewedHeadSha }],
        { auto: options?.auto },
      );
      return outcome.merged
        ? { success: true, data: { message: outcome.message, baseBranch: outcome.baseBranch } }
        : { success: false, error: outcome.message };
    },
  );

  // All of a task's PRs at once, all or nothing — used by auto-merge so a fix
  // split across repos (wp + customerweb) never lands half-merged.
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_MERGE_TASK,
    async (_event, projectPath: string, taskId: string, prs: Array<{ prNumber: number; prRepo?: string; reviewedHeadSha?: string }>, auto?: boolean) => {
      if (!projectPath) return { success: false, error: 'Project path is required' };
      const outcomes = await mergeTaskPullRequests(
        getWindow, projectPath, taskId,
        prs.map((pr) => ({ prNumber: pr.prNumber, repo: pr.prRepo, reviewedHeadSha: pr.reviewedHeadSha })),
        { auto },
      );
      return {
        success: outcomes.every((o) => o.merged),
        data: outcomes.map((o) => ({ prNumber: o.prNumber, prRepo: o.repo ?? undefined, merged: o.merged, message: o.message })),
      };
    },
  );

  ipcMain.handle(IPC_CHANNELS.CODE_REVIEW_RELEASE_BRANCH, async (_event, projectPath: string, refresh?: boolean) => {
    try {
      if (!projectPath) return { success: false, error: 'Project path is required' };
      return { success: true, data: await getReleaseBranch(projectPath, !!refresh) };
    } catch (error) {
      debugError('[CodeReview] Release branch detection failed:', error);
      return { success: false, error: ghErrorMessage(error) };
    }
  });

  // ─── Stop review ────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CODE_REVIEW_STOP, async (_event, taskId: string) => {
    const killed = killReviewProcess(taskId);
    if (killed) {
      sendReviewEvent(getWindow, { type: 'error', taskId, message: 'Review stopped by user' });
    }
    return { success: true, killed };
  });

  ipcMain.handle(IPC_CHANNELS.CODE_REVIEW_STOP_ALL, async () => {
    killAllReviewProcesses();
    // Send stop events for any items that were reviewing
    return { success: true };
  });

  // ─── Scheduler controls ─────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.CODE_REVIEW_SCHEDULER_START, async () => {
    try {
      const result = startScheduler(getWindow);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start scheduler' };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CODE_REVIEW_SCHEDULER_STOP, async () => {
    stopScheduler();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.CODE_REVIEW_SCHEDULER_STATUS, async () => {
    return {
      success: true,
      data: {
        active: schedulerInterval !== null,
        running: schedulerRunning,
        lastRun: lastSchedulerRun,
        nextRun: nextSchedulerRun,
        intervalMinutes: getSettings().codeReviewIntervalMinutes || 60,
      },
    };
  });
}
