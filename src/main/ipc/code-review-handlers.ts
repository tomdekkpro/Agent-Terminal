import type { BrowserWindow, IpcMain } from 'electron';
import { exec, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS } from '../../shared/constants';
import type { CodeReviewEvent, CodeReviewFinding, CodeReviewItem } from '../../shared/types';
import { getSettings } from './settings-handlers';
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
const activeReviews = new Map<string, ChildProcess>();
let stopAllRequested = false;

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

/** Fetch PR info using gh CLI */
async function fetchPRInfo(projectPath: string, prNumber: number): Promise<{
  title: string;
  url: string;
  branch: string;
  state: string;
  mergeable: string;
  diff: string;
  additions: number;
  deletions: number;
  files: string[];
}> {
  const infoJson = await ghExec(
    `gh pr view ${prNumber} --json title,url,headRefName,additions,deletions,files,state,mergeable`,
    projectPath,
  );
  const info = JSON.parse(infoJson);
  const state = (info.state || '').toUpperCase();
  const mergeable = (info.mergeable || '').toUpperCase();

  // Only fetch diff for open PRs
  let diff = '';
  if (state === 'OPEN') {
    diff = await ghExec(`gh pr diff ${prNumber}`, projectPath);
  }

  return {
    title: info.title,
    url: info.url,
    branch: info.headRefName,
    state,
    mergeable,
    diff,
    additions: info.additions || 0,
    deletions: info.deletions || 0,
    files: (info.files || []).map((f: any) => f.path),
  };
}

/** Run AI code review on a PR diff using Claude CLI */
/** Fetch task context (description + developer comments) for informed review */
async function fetchTaskContext(taskId: string): Promise<{ description: string; comments: string }> {
  const settings = getSettings();
  let description = '';
  let comments = '';

  try {
    const taskResult = await clickUpProvider.getTask(settings, taskId);
    if (taskResult.success && taskResult.data) {
      description = taskResult.data.description || '';
    }
  } catch { /* non-critical */ }

  try {
    const commentsResult = await clickUpProvider.getComments(settings, taskId);
    if (commentsResult.success && commentsResult.data) {
      // Collect developer comments (skip automated bot messages, keep last 10)
      const devComments = commentsResult.data
        .filter((c: any) => c.user?.id !== -1) // skip ClickBot
        .slice(-10)
        .map((c: any) => `[${c.user?.username || 'Unknown'}]: ${c.comment_text || ''}`.trim())
        .filter(Boolean);
      comments = devComments.join('\n\n');
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

async function runAIReview(
  diff: string,
  prTitle: string,
  files: string[],
  projectPath: string | undefined,
  taskContext?: { taskName?: string; description?: string; comments?: string },
  taskId?: string,
): Promise<{ passed: boolean; findings: CodeReviewFinding[] }> {
  const agentProvider = agentRegistry.get('claude');
  if (!agentProvider || !agentProvider.isAvailable()) {
    throw new Error('Claude Code CLI is not installed. Install with: npm install -g @anthropic-ai/claude-code');
  }

  const maxDiff = 50000;
  const truncatedDiff = diff.length > maxDiff
    ? diff.substring(0, maxDiff) + '\n\n[... diff truncated for review ...]'
    : diff;

  // Build task context section
  let taskSection = '';
  if (taskContext) {
    const parts: string[] = [];
    if (taskContext.taskName) parts.push(`Task: ${taskContext.taskName}`);
    if (taskContext.description) {
      const desc = taskContext.description.length > 3000
        ? taskContext.description.substring(0, 3000) + '...'
        : taskContext.description;
      parts.push(`Task Description / Bug Report:\n${desc}`);
    }
    if (taskContext.comments) {
      const comm = taskContext.comments.length > 2000
        ? taskContext.comments.substring(0, 2000) + '...'
        : taskContext.comments;
      parts.push(`Developer Comments:\n${comm}`);
    }
    if (parts.length > 0) {
      taskSection = `\n--- TASK CONTEXT ---\n${parts.join('\n\n')}\n--- END TASK CONTEXT ---\n`;
    }
  }

  // Read REVIEW.md from the project if it exists
  let reviewGuidelines = '';
  if (projectPath) {
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
  }

  const prompt = `You are a code review agent. Your ONLY output must be a JSON object. Do not write any other text.

Analyze this Pull Request for real bugs and issues. You act as a fleet of specialized reviewers — examine the changes from multiple angles: correctness, security, performance, and error handling. For each potential issue, verify it against the actual code behavior before reporting. Only report issues you are confident are real problems.
${taskSection}${reviewGuidelines}
## Pull Request
Title: ${prTitle}
Files changed: ${files.join(', ')}

## Diff
\`\`\`diff
${truncatedDiff}
\`\`\`

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
Respond with ONLY this JSON object — no text before or after:

{"passed": false, "findings": [{"severity": "critical", "file": "src/example.ts", "line": 42, "description": "What is wrong and why", "suggestion": "How to fix it"}]}

If no issues found:

{"passed": true, "findings": []}`;

  return new Promise((resolve, reject) => {
    // Use stdin piping instead of -p flag to avoid Windows command line length limits
    const args = ['--output-format', 'text', '--model', 'claude-sonnet-4-6', '-p', '-'];
    if (projectPath) args.push('--add-dir', projectPath);

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn('claude', args, {
      env,
      cwd: projectPath || undefined,
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
      reject(new Error('Code review timed out after 10 minutes'));
    }, 10 * 60_000);

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

      if (code !== 0 && !stdout) {
        reject(new Error(stderr.trim() || `Claude exited with code ${code}`));
        return;
      }

      try {
        const parsed = parseReviewJSON(stdout);
        resolve(parsed);
      } catch (parseErr: unknown) {
        debugError('[CodeReview] Failed to parse AI response:', stdout.substring(0, 500));
        resolve({
          passed: false,
          findings: [{
            severity: 'minor',
            file: 'unknown',
            description: `Review completed but response could not be parsed. Raw output: ${stdout.substring(0, 300)}`,
          }],
        });
      }
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

  lines.push('---\n_Automated review by Agent Terminal_');
  return lines.join('\n');
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
    // 1. Fetch reviewable tasks
    const taskResult = await clickUpProvider.searchTasks(settings, '', { statuses }, settings.clickupListId);
    if (!taskResult.success || !taskResult.data?.length) {
      debugLog('[CodeReview] Scheduler: no tasks found for review');
      schedulerRunning = false;
      return;
    }

    const tasks = taskResult.data;
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

          // Fail immediately if PR has merge conflicts
          if (prInfo.mergeable === 'CONFLICTING') {
            debugLog(`[CodeReview] Scheduler: task ${task.id} — PR #${prNumber} has merge conflicts`);
            const conflictFinding: CodeReviewFinding = {
              severity: 'critical',
              file: 'PR',
              description: `PR #${prNumber}: This Pull Request has merge conflicts and cannot be merged. Please resolve the conflicts before requesting a review.`,
            };
            allFindings.push(conflictFinding);
            anyFailed = true;
            allPassed = false;
            await clickUpProvider.postComment(settings, task.id, `## ❌ Code Review Failed — Merge Conflict\n\n**PR:** #${prNumber} — ${prInfo.title}\n\n🔴 **Critical**: This PR has merge conflicts and cannot be merged. Please resolve the conflicts and request a new review.\n\n---\n_Automated review by Agent Terminal_`);
            sendReviewEvent(getWindow, { type: 'done', taskId: eventTaskId, status: 'failed', findings: [conflictFinding] });
            continue;
          }

          sendReviewEvent(getWindow, { type: 'progress', taskId: eventTaskId, message: `Reviewing PR #${prNumber} (${prInfo.files.length} files, ${prInfo.additions}+ / ${prInfo.deletions}-)...` });

          // Fetch task context for informed review
          const taskCtx = await fetchTaskContext(task.id);

          // Run AI review with task context
          const result = await runAIReview(prInfo.diff, prInfo.title, prInfo.files, projectPath, {
            taskName: task.name,
            description: taskCtx.description,
            comments: taskCtx.comments,
          }, eventTaskId);
          const comment = formatReviewComment(prInfo.title, result.findings, result.passed);

          if (result.passed) {
            await clickUpProvider.postComment(settings, task.id, `✅ Code Review Passed — PR #${prNumber} reviewed automatically. No significant issues found.`);
            debugLog(`[CodeReview] Scheduler: task ${task.id} PR #${prNumber} PASSED`);
          } else {
            allPassed = false;
            anyFailed = true;
            allFindings.push(...result.findings);
            await clickUpProvider.postComment(settings, task.id, comment);
            // Post comment on GitHub PR
            try {
              const escapedComment = comment.replace(/"/g, '\\"').replace(/`/g, '\\`');
              await ghExec(`gh pr comment ${prNumber} --body "${escapedComment}"`, projectPath);
            } catch {
              // Non-critical
            }
            debugLog(`[CodeReview] Scheduler: task ${task.id} PR #${prNumber} FAILED with ${result.findings.length} findings`);
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
    async (_event, reviewStatuses?: string[], projectPath?: string, listId?: string) => {
      try {
        const settings = getSettings();
        if (settings.taskManagerProvider !== 'clickup') {
          return { success: false, error: 'Code Review requires ClickUp integration. Configure it in Settings.' };
        }

        const targetListId = listId || settings.clickupListId;
        if (!targetListId) return { success: false, error: 'No ClickUp list configured' };

        const statuses = reviewStatuses || ['ready for review', 'in review', 'review'];
        const result = await clickUpProvider.searchTasks(settings, '', { statuses }, targetListId);

        if (!result.success) return result;

        // Filter out tasks that already have the reviewpass tag
        const tagName = (settings.codeReviewTagName || 'reviewpass').toLowerCase();
        const filteredTasks = (result.data || []).filter((task) => {
          const hasTag = task.tags?.some((t) => t.name.toLowerCase() === tagName);
          if (hasTag) debugLog(`[CodeReview] Skipping task ${task.id} — already has "${tagName}" tag`);
          return !hasTag;
        });

        // Resolve PR info for each task (checks description, comments, and branch matching)
        // Tasks with multiple PRs are expanded into separate items
        const effectiveProjectPath = projectPath || settings.codeReviewProjectPath;
        const items: CodeReviewItem[] = [];
        for (const task of filteredTasks) {
          const prs = await findPRsForTask(task, effectiveProjectPath);
          if (prs.length === 0) {
            // No PRs found — still show the task so user can see it needs a PR
            items.push({
              taskId: task.id,
              taskName: task.name,
              taskUrl: task.url,
              customId: task.customId,
              status: 'pending' as const,
              findings: [],
            });
          } else {
            for (const pr of prs) {
              items.push({
                taskId: prs.length > 1 ? `${task.id}__pr${pr.prNumber}` : task.id,
                taskName: prs.length > 1 ? `${task.name} (PR #${pr.prNumber})` : task.name,
                taskUrl: task.url,
                customId: task.customId,
                prNumber: pr.prNumber,
                prUrl: pr.prUrl ?? undefined,
                status: 'pending' as const,
                findings: [],
              });
            }
          }
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
        sendReviewEvent(getWindow, { type: 'progress', taskId, message: 'Fetching PR info...' });

        const prInfo = await fetchPRInfo(projectPath, prNumber);

        // Only review open PRs
        if (prInfo.state !== 'OPEN') {
          const msg = `PR #${prNumber} is ${prInfo.state.toLowerCase()}, skipped.`;
          sendReviewEvent(getWindow, { type: 'done', taskId, status: 'skipped', message: msg });
          return { success: true, data: { passed: false, findings: [], prTitle: prInfo.title, prUrl: prInfo.url, prBranch: prInfo.branch, skipped: true } };
        }

        // Fail immediately if PR has merge conflicts
        if (prInfo.mergeable === 'CONFLICTING') {
          const conflictFinding: CodeReviewFinding = {
            severity: 'critical',
            file: 'PR',
            description: 'This Pull Request has merge conflicts and cannot be merged. Please resolve the conflicts before requesting a review.',
          };
          sendReviewEvent(getWindow, { type: 'finding', taskId, finding: conflictFinding });
          sendReviewEvent(getWindow, { type: 'done', taskId, status: 'failed', findings: [conflictFinding] });
          return {
            success: true,
            data: {
              passed: false,
              findings: [conflictFinding],
              prTitle: prInfo.title,
              prUrl: prInfo.url,
              prBranch: prInfo.branch,
            },
          };
        }

        sendReviewEvent(getWindow, { type: 'progress', taskId, message: `Reviewing ${prInfo.files.length} files (${prInfo.additions}+ / ${prInfo.deletions}-)...` });

        // Fetch task context for informed review
        const taskCtx = await fetchTaskContext(taskId);

        const result = await runAIReview(prInfo.diff, prInfo.title, prInfo.files, projectPath, {
          taskName: prInfo.title,
          description: taskCtx.description,
          comments: taskCtx.comments,
        }, taskId);

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
          await clickUpProvider.postComment(settings, taskId, `✅ Code Review Passed — PR #${prNumber} reviewed automatically. No significant issues found.`);
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
            const escapedComment = comment.replace(/"/g, '\\"').replace(/`/g, '\\`');
            await ghExec(`gh pr comment ${prNumber} --body "${escapedComment}"`, projectPath);
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
