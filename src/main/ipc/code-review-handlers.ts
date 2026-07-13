import type { BrowserWindow, IpcMain } from 'electron';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AppSettings, CodeReviewEvent, CodeReviewFinding, CodeReviewItem, TaskManagerTask } from '../../shared/types';
import { getSettings } from './settings-handlers';
import { recordActivity } from '../activity/activity-store';
import { ClickUpProvider } from './providers/clickup';
import { debugLog, debugError } from '../../shared/utils';
import { agentRegistry } from './providers/agent-registry';

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
// Key: `${taskId}__pr${prNumber}`, Value: session UUID
const reviewSessions = new Map<string, string>();

function getSessionKey(taskId: string, prNumber: number): string {
  return `${taskId}__pr${prNumber}`;
}

function clearReviewSession(taskId: string, prNumber: number): void {
  const key = getSessionKey(taskId, prNumber);
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

function ghExec(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, encoding: 'utf-8', timeout: GH_TIMEOUT, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
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


function sendReviewEvent(getWindow: () => BrowserWindow | null, event: CodeReviewEvent) {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.CODE_REVIEW_EVENT, event);
  }
}

type PRInfo = { prNumber: number; prUrl: string | null };

/** Extract all PR numbers from any text */
function extractAllPRsFromText(text: string): PRInfo[] {
  const prs: PRInfo[] = [];
  const seen = new Set<number>();

  // Match GitHub PR URLs: github.com/owner/repo/pull/123
  const urlRegex = /https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    const prNumber = parseInt(match[1], 10);
    if (!seen.has(prNumber)) {
      seen.add(prNumber);
      prs.push({ prNumber, prUrl: match[0] });
    }
  }

  // Match PR #123 or PR: #123 patterns (only if not already found via URL)
  const hashRegex = /PR[:\s]*#(\d+)/gi;
  while ((match = hashRegex.exec(text)) !== null) {
    const prNumber = parseInt(match[1], 10);
    if (!seen.has(prNumber)) {
      seen.add(prNumber);
      prs.push({ prNumber, prUrl: null });
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

    const allText = result.data
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

/** Try all methods to find PRs: task fields first, then comments, then branch matching */
async function findPRsForTask(task: { id: string; customId?: string; description?: string; name?: string }, projectPath?: string): Promise<PRInfo[]> {
  const seen = new Set<number>();
  const results: PRInfo[] = [];

  function addPRs(prs: PRInfo[]) {
    for (const pr of prs) {
      if (!seen.has(pr.prNumber)) {
        seen.add(pr.prNumber);
        results.push(pr);
      }
    }
  }

  // 1. Check task name + description
  addPRs(extractPRsFromTask(task));

  // 2. Check task comments
  addPRs(await extractPRsFromComments(task.id));

  // 3. Try gh CLI search — match task custom ID in PR title or branch name
  if (projectPath && task.customId) {
    try {
      try {
        const searchResult = await ghExec(
          `gh pr list --search "${task.customId}" --state open --json number,url,headRefName,title --limit 10`,
          projectPath,
        );
        const searchPrs = JSON.parse(searchResult);
        const taskIdLower = task.customId.toLowerCase();
        for (const pr of searchPrs) {
          if (
            (pr.title || '').toLowerCase().includes(taskIdLower) ||
            (pr.headRefName || '').toLowerCase().includes(taskIdLower)
          ) {
            addPRs([{ prNumber: pr.number, prUrl: pr.url }]);
          }
        }
      } catch {
        // search flag might fail, fall through to full list scan
      }

      // Fallback: scan all open PRs by branch name pattern
      const prList = await ghExec(
        `gh pr list --state open --json number,url,headRefName,title --limit 100`,
        projectPath,
      );
      const prs = JSON.parse(prList);
      const taskIdLower = task.customId.toLowerCase();
      const sanitizedId = task.customId.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      for (const pr of prs) {
        const branch = (pr.headRefName || '').toLowerCase();
        const title = (pr.title || '').toLowerCase();
        if (
          branch.includes(taskIdLower) || branch.includes(sanitizedId) ||
          title.includes(taskIdLower) || title.includes(sanitizedId)
        ) {
          addPRs([{ prNumber: pr.number, prUrl: pr.url }]);
        }
      }
    } catch {
      // gh CLI not available or not in a repo — skip
    }
  }

  // 4. Try matching by task internal ID in branch (e.g. task/86d28ttjq)
  if (projectPath) {
    try {
      const prList = await ghExec(
        `gh pr list --state open --json number,url,headRefName --limit 100`,
        projectPath,
      );
      const prs = JSON.parse(prList);
      const taskIdLower = task.id.toLowerCase();
      for (const pr of prs) {
        const branch = (pr.headRefName || '').toLowerCase();
        if (branch.includes(taskIdLower)) {
          addPRs([{ prNumber: pr.number, prUrl: pr.url }]);
        }
      }
    } catch {
      // skip
    }
  }

  // Filter to only open PRs by checking against gh pr list
  if (results.length > 0 && projectPath) {
    try {
      const openPrList = await ghExec(
        `gh pr list --state open --json number --limit 200`,
        projectPath,
      );
      const openNumbers = new Set<number>(JSON.parse(openPrList).map((p: any) => p.number));
      const filtered = results.filter((pr) => openNumbers.has(pr.prNumber));
      debugLog(`[CodeReview] Found ${results.length} PR(s) for task ${task.customId || task.id}, ${filtered.length} open: ${filtered.map((p) => `#${p.prNumber}`).join(', ')}`);
      return filtered;
    } catch {
      // gh CLI not available — return all and let the review handler skip closed ones
    }
  }

  if (results.length > 0) {
    debugLog(`[CodeReview] Found ${results.length} PR(s) for task ${task.customId || task.id}: ${results.map((p) => `#${p.prNumber}`).join(', ')}`);
  }
  return results;
}

/** Fetch PR metadata using gh CLI (no diff — Claude fetches that itself) */
async function fetchPRInfo(projectPath: string, prNumber: number): Promise<{
  title: string;
  url: string;
  branch: string;
  baseBranch: string;
  author: string;
  state: string;
  mergeable: string;
}> {
  const infoJson = await ghExec(
    `gh pr view ${prNumber} --json title,url,headRefName,baseRefName,author,state,mergeable`,
    projectPath,
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
  };
}

/** PR metadata shown in the review list (branch, base branch, author, title) */
type PRMetadata = { url?: string; branch?: string; baseBranch?: string; author?: string; title?: string };

/** Fetch metadata for all open PRs in one gh call, keyed by PR number */
async function fetchOpenPRMetadata(projectPath: string): Promise<Map<number, PRMetadata>> {
  const map = new Map<number, PRMetadata>();
  try {
    const json = await ghExec(
      `gh pr list --state open --json number,url,headRefName,baseRefName,title,author --limit 200`,
      projectPath,
    );
    for (const pr of JSON.parse(json)) {
      map.set(pr.number, {
        url: pr.url,
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        author: pr.author?.login,
        title: pr.title,
      });
    }
  } catch {
    // gh CLI not available or not in a repo — list will just lack metadata
  }
  return map;
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

/** Try multiple strategies to extract JSON from Claude's response */
function parseReviewJSON(stdout: string): { passed: boolean; findings: CodeReviewFinding[] } {
  const raw = stdout.trim();

  // Strategy 1: Try parsing the entire output as JSON
  try {
    const result = JSON.parse(raw);
    if (typeof result === 'object' && result !== null && 'passed' in result) {
      return { passed: !!result.passed, findings: Array.isArray(result.findings) ? result.findings : [] };
    }
  } catch { /* continue to next strategy */ }

  // Strategy 2: Extract JSON from code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const result = JSON.parse(fenceMatch[1].trim());
      if (typeof result === 'object' && result !== null && 'passed' in result) {
        return { passed: !!result.passed, findings: Array.isArray(result.findings) ? result.findings : [] };
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
          return { passed: !!result.passed, findings: Array.isArray(result.findings) ? result.findings : [] };
        }
      } catch { /* try next match */ }
    }
  }

  // Strategy 4: Original greedy regex as fallback
  const greedyMatch = raw.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    const result = JSON.parse(greedyMatch[0]);
    if (typeof result === 'object' && result !== null && 'passed' in result) {
      return { passed: !!result.passed, findings: Array.isArray(result.findings) ? result.findings : [] };
    }
  }

  throw new Error('No valid review JSON found in response');
}

/** Build the full initial review prompt */
function buildInitialReviewPrompt(
  prNumber: number,
  taskSection: string,
  reviewGuidelines: string,
): string {
  return `You are a code review agent. Your ONLY output must be a JSON object. Do not write any other text.

Analyze Pull Request #${prNumber} for real bugs and issues.

First, run these commands to get the PR details:
1. \`gh pr view ${prNumber} --json title,files,additions,deletions\` — to see what changed
2. \`gh pr diff ${prNumber}\` — to see the actual diff

Then act as a fleet of specialized reviewers — examine the changes from multiple angles: correctness, security, performance, and error handling. For each potential issue, verify it against the actual code behavior before reporting. Only report issues you are confident are real problems. You have full access to the project files, so you can read any source file to understand context beyond the diff.
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
  taskSection: string,
): string {
  return `You are a code review agent. Your ONLY output must be a JSON object. Do not write any other text, explanation, or reasoning outside the JSON.

The developer has updated PR #${prNumber} after your previous review. Please re-review the changes.

1. Run \`gh pr diff ${prNumber}\` to see the current diff
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
      shell: true,
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
  projectPath: string,
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

  // Read REVIEW.md from the project if it exists
  let reviewGuidelines = '';
  try {
    const reviewMdPath = path.join(projectPath, 'REVIEW.md');
    const content = await fs.promises.readFile(reviewMdPath, 'utf-8');
    if (content.trim()) {
      const trimmed = content.length > 3000
        ? content.substring(0, 3000) + '\n...[truncated]'
        : content;
      reviewGuidelines = `\n--- PROJECT REVIEW GUIDELINES (from REVIEW.md) ---\n${trimmed}\n--- END REVIEW GUIDELINES ---\n`;
    }
  } catch { /* REVIEW.md not found — that's fine */ }

  // Check if we have an existing session for this task/PR (re-review)
  const sessionKey = taskId ? getSessionKey(taskId, prNumber) : null;
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
    ? buildReReviewPrompt(prNumber, taskSection)
    : buildInitialReviewPrompt(prNumber, taskSection, reviewGuidelines);

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
    args.push('--add-dir', projectPath);
    return args;
  };

  // First attempt
  const first = await runClaudeReviewProcess(buildArgs(isReReview), prompt, projectPath, taskId, timeoutMs);
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

  const retry = await runClaudeReviewProcess(buildArgs(true), JSON_ONLY_RETRY_PROMPT, projectPath, taskId, timeoutMs);

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
    // 1. Fetch ALL reviewable tasks across pages (a single page caps at 100)
    let tasks: TaskManagerTask[];
    try {
      tasks = await fetchAllReviewTasks(settings, statuses, settings.clickupListId);
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

      // Check if a developer posted an approval comment (e.g. "review:approve")
      const approved = await hasApprovalComment(task.id);
      if (approved) {
        debugLog(`[CodeReview] Scheduler: task ${task.id} has developer approval comment — auto-approving`);
        await clickUpProvider.addTag(settings, task.id, tagName);
        await clickUpProvider.postComment(
          settings,
          task.id,
          `✅ Code Review Approved — Developer confirmed the code is correct via approval comment.\n\n_Automated by Agent Terminal_`,
        );
        clearAllSessionsForTask(task.id);
        sendReviewEvent(getWindow, { type: 'done', taskId: task.id, status: 'passed' });
        continue;
      }

      // Find all PRs for this task
      const prs = await findPRsForTask(task, projectPath);

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

      for (const pr of prs) {
        if (stopAllRequested) break;
        const prNumber = pr.prNumber;
        const eventTaskId = prs.length > 1 ? `${task.id}__pr${prNumber}` : task.id;

        try {
          sendReviewEvent(getWindow, { type: 'progress', taskId: eventTaskId, message: `Checking PR #${prNumber}...` });

          // Fetch PR info — check if it's still open
          const prInfo = await fetchPRInfo(projectPath, prNumber);
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
          const result = await runAIReview(prNumber, projectPath, {
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

          const comment = formatReviewComment(prInfo.title, result.findings, result.passed);

          if (result.passed) {
            await clickUpProvider.postComment(settings, task.id, `✅ Code Review Passed — PR #${prNumber} reviewed automatically. No significant issues found.\n\n_Automated by Agent Terminal_`);
            debugLog(`[CodeReview] Scheduler: task ${task.id} PR #${prNumber} PASSED`);
          } else {
            allPassed = false;
            anyFailed = true;
            allFindings.push(...result.findings);
            await clickUpProvider.postComment(settings, task.id, comment);
            // Post comment on GitHub PR
            try {
              const tmpFile = path.join(os.tmpdir(), `cr-comment-${Date.now()}.md`);
              fs.writeFileSync(tmpFile, comment, 'utf-8');
              try {
                await ghExec(`gh pr comment ${prNumber} --body-file "${tmpFile}"`, projectPath);
              } finally {
                fs.unlinkSync(tmpFile);
              }
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

        // Fetch tasks across every selected list, de-duplicating by task id
        // (ClickUp allows a task to live in multiple lists).
        const seen = new Set<string>();
        const allTasks: TaskManagerTask[] = [];
        for (const lid of targetListIds) {
          const listTasks = await fetchAllReviewTasks(settings, statuses, lid);
          for (const task of listTasks) {
            if (!seen.has(task.id)) {
              seen.add(task.id);
              allTasks.push(task);
            }
          }
        }

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

        // Resolve PR info for each task (checks description, comments, and branch matching)
        // Each task contains a prs array with all its open PRs
        const effectiveProjectPath = projectPath || settings.codeReviewProjectPath;

        // Fetch metadata (branch, base branch, author) for all open PRs in one gh call
        const prMeta = effectiveProjectPath
          ? await fetchOpenPRMetadata(effectiveProjectPath)
          : new Map();

        const items: CodeReviewItem[] = [];
        for (const task of filteredTasks) {
          const foundPRs = await findPRsForTask(task, effectiveProjectPath);
          items.push({
            taskId: task.id,
            taskName: task.name,
            taskUrl: task.url,
            customId: task.customId,
            prNumber: foundPRs.length === 1 ? foundPRs[0].prNumber : undefined,
            prUrl: foundPRs.length === 1 ? (foundPRs[0].prUrl ?? undefined) : undefined,
            status: 'pending' as const,
            findings: [],
            prs: foundPRs.map((pr) => {
              const meta = prMeta.get(pr.prNumber);
              return {
                prNumber: pr.prNumber,
                prUrl: pr.prUrl ?? meta?.url ?? undefined,
                prTitle: meta?.title,
                prBranch: meta?.branch,
                prBaseBranch: meta?.baseBranch,
                prAuthor: meta?.author,
                status: 'pending' as const,
                findings: [],
              };
            }),
          });
        }

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
    async (_event, projectPath: string, prNumber: number) => {
      try {
        const info = await fetchPRInfo(projectPath, prNumber);
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
    async (_event, projectPath: string, taskId: string, prNumber: number) => {
      try {
        sendReviewEvent(getWindow, { type: 'progress', taskId, message: `Checking PR #${prNumber}...` });

        // Check if developer posted an approval comment — auto-pass if so
        const approved = await hasApprovalComment(taskId);
        if (approved) {
          debugLog(`[CodeReview] Task ${taskId} has developer approval — auto-passing`);
          sendReviewEvent(getWindow, { type: 'done', taskId, status: 'passed' });
          // Submit the approval
          const settings = getSettings();
          const tagName = settings.codeReviewTagName || 'reviewpass';
          await clickUpProvider.addTag(settings, taskId, tagName);
          await clickUpProvider.postComment(
            settings,
            taskId,
            `✅ Code Review Approved — Developer confirmed the code is correct via approval comment.\n\n_Automated by Agent Terminal_`,
          );
          clearReviewSession(taskId, prNumber);
          return { success: true, data: { passed: true, findings: [], prTitle: '', prUrl: '', prBranch: '', approved: true } };
        }

        const prInfo = await fetchPRInfo(projectPath, prNumber);

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
        const result = await runAIReview(prNumber, projectPath, {
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
    async (_event, projectPath: string, taskId: string, prNumber: number, passed: boolean, findings: CodeReviewFinding[], prTitle: string) => {
      try {
        const settings = getSettings();
        const tagName = settings.codeReviewTagName || 'reviewpass';
        const comment = formatReviewComment(prTitle, findings, passed);

        if (passed) {
          const tagResult = await clickUpProvider.addTag(settings, taskId, tagName);
          if (!tagResult.success) {
            debugError('[CodeReview] Failed to add tag:', tagResult.error);
          }
          await clickUpProvider.postComment(settings, taskId, `✅ Code Review Passed — PR #${prNumber} reviewed automatically. No significant issues found.\n\n_Automated by Agent Terminal_`);
          // Clear the review session — no longer needed
          clearReviewSession(taskId, prNumber);
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
            const tmpFile = path.join(os.tmpdir(), `cr-comment-${Date.now()}.md`);
            fs.writeFileSync(tmpFile, comment, 'utf-8');
            try {
              await ghExec(`gh pr comment ${prNumber} --body-file "${tmpFile}"`, projectPath);
            } finally {
              fs.unlinkSync(tmpFile);
            }
            debugLog('[CodeReview] Posted review comment on PR #', prNumber);
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
    async (_event, projectPath: string, taskId: string, prNumber: number, prTitle: string) => {
      try {
        const settings = getSettings();
        const tagName = settings.codeReviewTagName || 'reviewpass';

        // Add reviewpass tag
        const tagResult = await clickUpProvider.addTag(settings, taskId, tagName);
        if (!tagResult.success) {
          debugError('[CodeReview] Force approve — failed to add tag:', tagResult.error);
        }

        // Post approval comment on ClickUp
        await clickUpProvider.postComment(
          settings,
          taskId,
          `✅ Code Review Manually Approved — PR #${prNumber} (${prTitle}) was approved by the reviewer. Previous findings were reviewed and accepted as correct.\n\n_Approved via Agent Terminal_`,
        );

        // Post approval comment on GitHub PR
        try {
          const comment = `## ✅ Code Review — Manually Approved\n\n**PR:** ${prTitle}\n\nPrevious findings were reviewed and accepted as correct. No changes required.\n\n---\n_Approved via Agent Terminal_`;
          const tmpFile = path.join(os.tmpdir(), `cr-approve-${Date.now()}.md`);
          fs.writeFileSync(tmpFile, comment, 'utf-8');
          try {
            await ghExec(`gh pr comment ${prNumber} --body-file "${tmpFile}"`, projectPath);
          } finally {
            fs.unlinkSync(tmpFile);
          }
        } catch (ghErr) {
          debugError('[CodeReview] Force approve — failed to post GitHub comment:', ghErr);
        }

        // Clear the review session — no longer needed
        clearReviewSession(taskId, prNumber);
        sendReviewEvent(getWindow, { type: 'done', taskId, status: 'passed' });
        debugLog(`[CodeReview] Force approved task ${taskId} PR #${prNumber}`);
        return { success: true };
      } catch (error) {
        debugError('[CodeReview] Force approve error:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Failed to approve' };
      }
    },
  );

  // ─── Add PR manually ────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.CODE_REVIEW_ADD_PR,
    async (_event, projectPath: string, prInput: string) => {
      try {
        const trimmed = (prInput || '').trim();
        if (!trimmed) return { success: false, error: 'PR URL or number is required' };
        if (!projectPath) return { success: false, error: 'Project path is required' };

        // Accept: full URL, #123, or plain number
        let prNumber: number | null = null;
        const urlMatch = trimmed.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
        if (urlMatch) {
          prNumber = parseInt(urlMatch[1], 10);
        } else {
          const numMatch = trimmed.match(/^#?(\d+)$/);
          if (numMatch) prNumber = parseInt(numMatch[1], 10);
        }

        if (!prNumber || Number.isNaN(prNumber)) {
          return { success: false, error: 'Invalid PR — paste a GitHub PR URL or PR number' };
        }

        // Validate PR exists in the selected project repo
        const info = await fetchPRInfo(projectPath, prNumber);
        return {
          success: true,
          data: {
            prNumber,
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
