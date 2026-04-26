import { type IpcMain } from 'electron';
import { exec, execSync } from 'child_process';
import { existsSync, readFileSync, statSync, appendFileSync, cpSync, mkdirSync } from 'fs';
import { join } from 'path';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog, debugError } from '../../shared/utils';

const GIT_TIMEOUT = 30000; // 30 seconds for most git operations
const NETWORK_TIMEOUT = 60000; // 60 seconds for network operations (push, pull, fetch)

/** Cap for untracked-file preview to keep the renderer responsive. */
const UNTRACKED_MAX_BYTES = 1_000_000;
const UNTRACKED_MAX_LINES = 10_000;

/** Build a unified-diff representation of a new (untracked) file by showing
 *  every line as an addition. Mirrors the format `git diff` produces for a
 *  fresh add so the renderer's existing diff parser/highlighter just works. */
function buildUntrackedDiff(cwd: string, relPath: string): string {
  const fullPath = join(cwd, relPath);
  const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${relPath}\n`;
  let stat;
  try {
    stat = statSync(fullPath);
  } catch {
    return '';
  }
  if (stat.size === 0) {
    return header + '@@ -0,0 +0,0 @@\n';
  }
  if (stat.size > UNTRACKED_MAX_BYTES) {
    return (
      header +
      `@@ -0,0 +1,1 @@\n+(file too large to preview — ${(stat.size / 1024).toFixed(1)} KB)\n`
    );
  }
  let buf: Buffer;
  try {
    buf = readFileSync(fullPath);
  } catch {
    return '';
  }
  // Binary heuristic: any null byte in the first 8KB → treat as binary.
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0)) {
    return (
      header +
      `@@ -0,0 +1,1 @@\n+(binary file — ${(stat.size / 1024).toFixed(1)} KB)\n`
    );
  }
  const text = buf.toString('utf-8');
  // split('\n') leaves a trailing '' when the file ends with '\n' — drop it.
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const truncated = lines.length > UNTRACKED_MAX_LINES;
  const shown = truncated ? lines.slice(0, UNTRACKED_MAX_LINES) : lines;
  const body = shown.map((l) => '+' + l).join('\n');
  const trailer = truncated
    ? `\n+(...truncated — ${lines.length - UNTRACKED_MAX_LINES} more lines)`
    : '';
  return `${header}@@ -0,0 +1,${shown.length} @@\n${body}${trailer}\n`;
}

/** Run a git command asynchronously with timeout (non-blocking) */
function gitExec(command: string, cwd: string, timeout = GIT_TIMEOUT): Promise<string> {
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

/** Copy .claude/ directory from parent project to worktree so Claude Code CLI has project settings */
function copyClaudeConfig(projectPath: string, worktreeDir: string): void {
  try {
    const srcDir = join(projectPath, '.claude');
    if (!existsSync(srcDir)) return;

    const destDir = join(worktreeDir, '.claude');
    mkdirSync(destDir, { recursive: true });
    // Exclude .claude/worktrees/ — the new worktree convention places
    // the worktree dir INSIDE this path, so a recursive copy would
    // nest it inside itself.
    cpSync(srcDir, destDir, {
      recursive: true,
      filter: (s) => !s.replace(/\\/g, '/').includes('/.claude/worktrees'),
    });
    debugLog('[Git] Copied .claude/ config to worktree');
  } catch (err) {
    debugError('[Git] Failed to copy .claude/ config:', err);
    // Non-critical — Claude will work without it
  }
}

/** Sanitize a string to be safe for git branch names and directory names */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function ensureGitignore(projectPath: string, entry: string): void {
  const gitignorePath = join(projectPath, '.gitignore');
  try {
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.includes(entry)) {
        appendFileSync(gitignorePath, `\n${entry}\n`);
      }
    } else {
      appendFileSync(gitignorePath, `${entry}\n`);
    }
  } catch {
    // Non-critical, ignore
  }
}

export function registerGitHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.GIT_CREATE_WORKTREE,
    async (_event, projectPath: string, taskId: string, _taskName?: string) => {
      try {
        if (!isGitRepo(projectPath)) {
          return { success: false, error: 'Not a git repository' };
        }

        const safeName = sanitize(taskId);
        // Use Claude's native worktree convention so `claude --worktree <name>`
        // reuses the same dir + branch we create. See:
        //   <repo>/.claude/worktrees/<name>  with branch  worktree-<name>
        const worktreeDir = join(projectPath, '.claude', 'worktrees', safeName);
        const branch = `worktree-${safeName}`;

        // Already exists — reuse
        if (existsSync(worktreeDir)) {
          debugLog('[Git] Reusing existing worktree:', worktreeDir);
          return { success: true, data: worktreeDir, branch };
        }

        // Prune stale worktree references (e.g. directory deleted but git still tracks it)
        try {
          await gitExec('git worktree prune', projectPath, 5000);
        } catch { /* non-critical */ }

        // .claude/ is already gitignored in most projects, but ensure it
        ensureGitignore(projectPath, '.claude/');

        // Try creating with new branch
        try {
          await gitExec(`git worktree add "${worktreeDir}" -b "${branch}"`, projectPath);
        } catch {
          // Branch might already exist (previous worktree was removed but branch kept)
          // Force-delete the old branch first, then try with existing branch
          try {
            await gitExec(`git branch -D "${branch}"`, projectPath, 5000);
            debugLog('[Git] Deleted stale branch:', branch);
          } catch { /* branch may not exist, ignore */ }

          try {
            await gitExec(`git worktree add "${worktreeDir}" -b "${branch}"`, projectPath);
          } catch (err: any) {
            return { success: false, error: err.message || 'Failed to create worktree' };
          }
        }

        // Copy .claude/ config so Claude Code CLI has project settings & permissions
        copyClaudeConfig(projectPath, worktreeDir);

        debugLog('[Git] Created worktree:', worktreeDir, 'branch:', branch);
        return { success: true, data: worktreeDir, branch };
      } catch (error: any) {
        debugError('[Git] createWorktree error:', error);
        return { success: false, error: error.message || 'Failed to create worktree' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_REMOVE_WORKTREE,
    async (_event, projectPath: string, worktreePath: string) => {
      try {
        await gitExec(`git worktree remove "${worktreePath}" --force`, projectPath);
        debugLog('[Git] Removed worktree:', worktreePath);
        return { success: true };
      } catch (error: any) {
        debugError('[Git] removeWorktree error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_LIST_BRANCHES,
    async (_event, projectPath: string) => {
      try {
        if (!isGitRepo(projectPath)) {
          return { success: false, error: 'Not a git repository' };
        }

        const output = await gitExec('git branch --format="%(refname:short)"', projectPath);

        const branches = output
          .split('\n')
          .map((b) => b.trim())
          .filter(Boolean);

        // Detect current branch
        let current = '';
        try {
          current = (await gitExec('git rev-parse --abbrev-ref HEAD', projectPath, 5000)).trim();
        } catch { /* ignore */ }

        return { success: true, branches, current };
      } catch (error: any) {
        debugError('[Git] listBranches error:', error);
        return { success: false, error: error.message };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_MERGE_TASK,
    async (_event, projectPath: string, worktreePath: string, taskBranch: string, targetBranch: string) => {
      try {
        if (!isGitRepo(projectPath)) {
          return { success: false, error: 'Not a git repository' };
        }

        // Ensure task branch has commits ahead of target
        try {
          const aheadCount = await gitExec(
            `git rev-list --count ${targetBranch}..${taskBranch}`,
            projectPath,
          );
          if (aheadCount === '0') {
            return { success: false, error: `No commits to merge — task branch is up to date with ${targetBranch}` };
          }
        } catch {
          // Could not determine ahead count, proceed anyway
        }

        // Remove the worktree first (must be done before merging to avoid lock issues)
        try {
          await gitExec(`git worktree remove "${worktreePath}" --force`, projectPath);
          debugLog('[Git] Removed worktree before merge:', worktreePath);
        } catch {
          // Worktree might already be gone
        }

        // Switch to target branch in the project root
        await gitExec(`git checkout ${targetBranch}`, projectPath);

        // Merge the task branch
        try {
          await gitExec(
            `git merge ${taskBranch} --no-ff -m "Merge ${taskBranch} into ${targetBranch}"`,
            projectPath,
          );
        } catch (mergeErr: any) {
          // Merge conflict — abort and report
          try {
            await gitExec('git merge --abort', projectPath, 5000);
          } catch { /* ignore */ }
          return { success: false, error: 'Merge conflict detected. Please resolve manually.' };
        }

        // Delete the task branch
        try {
          await gitExec(`git branch -d ${taskBranch}`, projectPath);
          debugLog('[Git] Deleted task branch:', taskBranch);
        } catch {
          // Non-critical — branch may have other references
        }

        // Prune worktree list
        try {
          await gitExec('git worktree prune', projectPath, 5000);
        } catch { /* ignore */ }

        debugLog('[Git] Merged task branch into', targetBranch);
        return { success: true, targetBranch };
      } catch (error: any) {
        debugError('[Git] mergeTask error:', error);
        return { success: false, error: error.message || 'Failed to merge task branch' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_PUSH_BRANCH,
    async (_event, cwd: string, branch?: string) => {
      try {
        if (!isGitRepo(cwd)) {
          return { success: false, error: 'Not a git repository' };
        }

        // Detect current branch if not specified
        const branchName = branch || await gitExec('git rev-parse --abbrev-ref HEAD', cwd, 5000);

        await gitExec(`git push -u origin ${branchName}`, cwd, NETWORK_TIMEOUT);

        debugLog('[Git] Pushed branch:', branchName);
        return { success: true, branch: branchName };
      } catch (error: any) {
        const msg = error.stderr?.toString() || error.message || '';
        if (msg.includes('up-to-date') || msg.includes('up to date')) {
          return { success: true, branch: branch || 'current', alreadyUpToDate: true };
        }
        debugError('[Git] pushBranch error:', error);
        return { success: false, error: msg || 'Failed to push branch' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_COMMIT,
    async (_event, cwd: string, message: string) => {
      try {
        if (!isGitRepo(cwd)) {
          return { success: false, error: 'Not a git repository' };
        }

        // Check if there are changes to commit
        const status = await gitExec('git status --porcelain', cwd, 5000);
        if (!status.trim()) {
          return { success: false, error: 'Nothing to commit — working tree clean' };
        }

        // Stage all changes and commit
        await gitExec('git add -A', cwd);
        await gitExec(`git commit -m "${message.replace(/"/g, '\\"')}"`, cwd);

        debugLog('[Git] Committed:', message);
        return { success: true, message };
      } catch (error: any) {
        const msg = error.stderr?.toString() || error.message || '';
        debugError('[Git] commit error:', msg);
        return { success: false, error: msg || 'Failed to commit' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_FETCH,
    async (_event, cwd: string) => {
      try {
        if (!isGitRepo(cwd)) {
          return { success: false, error: 'Not a git repository' };
        }

        await gitExec('git fetch --all --prune', cwd, NETWORK_TIMEOUT);

        let behindCount = 0;
        try {
          const count = await gitExec('git rev-list HEAD..@{u} --count', cwd, 5000);
          behindCount = parseInt(count, 10) || 0;
        } catch {
          // No upstream configured — ignore
        }

        debugLog('[Git] Fetched all remotes, behind by', behindCount);
        return { success: true, behindCount };
      } catch (error: any) {
        const msg = error.stderr?.toString() || error.message || '';
        debugError('[Git] fetch error:', msg);
        return { success: false, error: msg || 'Failed to fetch' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_PULL,
    async (_event, cwd: string) => {
      try {
        if (!isGitRepo(cwd)) {
          return { success: false, error: 'Not a git repository' };
        }

        const oldHead = await gitExec('git rev-parse HEAD', cwd, 5000);

        const output = await gitExec('git pull', cwd, NETWORK_TIMEOUT);

        const alreadyUpToDate = output.includes('Already up to date') || output.includes('up-to-date');

        let commitsPulled = 0;
        if (!alreadyUpToDate) {
          try {
            const count = await gitExec(`git rev-list ${oldHead}..HEAD --count`, cwd, 5000);
            commitsPulled = parseInt(count, 10) || 0;
          } catch {
            // ignore
          }
        }

        debugLog('[Git] Pull result:', output, 'commits pulled:', commitsPulled);
        return { success: true, alreadyUpToDate, output, commitsPulled };
      } catch (error: any) {
        const msg = error.stderr?.toString() || error.message || '';
        debugError('[Git] pull error:', msg);
        return { success: false, error: msg || 'Failed to pull' };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.GIT_CREATE_PR,
    async (
      _event,
      projectPath: string,
      worktreePath: string,
      taskBranch: string,
      targetBranch: string,
      title: string,
      body: string,
    ) => {
      try {
        if (!isGitRepo(projectPath)) {
          return { success: false, error: 'Not a git repository' };
        }

        // Check if gh CLI is available
        try {
          await gitExec('gh --version', projectPath, 10000);
        } catch {
          return { success: false, error: 'GitHub CLI (gh) is not installed. Install from https://cli.github.com' };
        }

        // Push the task branch to remote from worktree (or project root if worktree gone)
        const pushCwd = existsSync(worktreePath) ? worktreePath : projectPath;
        try {
          await gitExec(`git push -u origin ${taskBranch}`, pushCwd, NETWORK_TIMEOUT);
          debugLog('[Git] Pushed branch to remote:', taskBranch);
        } catch (pushErr: any) {
          const msg = pushErr.stderr?.toString() || pushErr.message || '';
          // "Everything up-to-date" is fine
          if (!msg.includes('up-to-date') && !msg.includes('up to date')) {
            return { success: false, error: `Failed to push branch: ${msg}` };
          }
        }

        // Create PR using gh CLI
        const escapedTitle = title.replace(/"/g, '\\"');
        const escapedBody = body.replace(/"/g, '\\"');
        try {
          const prOutput = await gitExec(
            `gh pr create --base "${targetBranch}" --head "${taskBranch}" --title "${escapedTitle}" --body "${escapedBody}"`,
            projectPath,
            NETWORK_TIMEOUT,
          );

          // gh pr create outputs the PR URL
          debugLog('[Git] Created PR:', prOutput);
          return { success: true, prUrl: prOutput };
        } catch (prErr: any) {
          const stderr = prErr.stderr?.toString() || prErr.message || '';
          // If PR already exists, try to get its URL
          if (stderr.includes('already exists')) {
            try {
              const existing = await gitExec(
                `gh pr view ${taskBranch} --json url --jq .url`,
                projectPath,
                NETWORK_TIMEOUT,
              );
              return { success: true, prUrl: existing, existing: true };
            } catch {
              return { success: false, error: 'A PR already exists for this branch' };
            }
          }
          return { success: false, error: stderr || 'Failed to create PR' };
        }
      } catch (error: any) {
        debugError('[Git] createPR error:', error);
        return { success: false, error: error.message || 'Failed to create PR' };
      }
    }
  );

  // ─── Create Branch & PR ────────────────────────────────────────
  // Creates a new branch from the current branch, commits all changes
  // (staged + unstaged), pushes, creates a PR, then switches back to the
  // target branch and resets it to its remote state.
  ipcMain.handle(
    IPC_CHANNELS.GIT_CREATE_BRANCH_PR,
    async (
      _event,
      cwd: string,
      newBranch: string,
      targetBranch: string,
      title: string,
      body: string,
    ) => {
      try {
        if (!isGitRepo(cwd)) {
          return { success: false, error: 'Not a git repository' };
        }

        // 1. Create and switch to new branch (uncommitted changes carry over)
        try {
          await gitExec(`git checkout -b "${newBranch}"`, cwd);
          debugLog('[Git] Created branch:', newBranch);
        } catch (err: any) {
          const msg = err.stderr?.toString() || err.message || '';
          if (msg.includes('already exists')) {
            return { success: false, error: `Branch "${newBranch}" already exists` };
          }
          return { success: false, error: `Failed to create branch: ${msg}` };
        }

        // 2. Stage and commit all file changes on the new branch
        try {
          await gitExec('git add -A', cwd);
          const escapedCommitMsg = title.replace(/"/g, '\\"');
          await gitExec(`git commit -m "${escapedCommitMsg}"`, cwd);
          debugLog('[Git] Committed changes on:', newBranch);
        } catch (commitErr: any) {
          const msg = commitErr.stderr?.toString() || commitErr.message || '';
          // "nothing to commit" is fine — changes may already be committed
          if (!msg.includes('nothing to commit') && !msg.includes('no changes added')) {
            debugLog('[Git] Commit note:', msg);
          }
        }

        // 3. Push new branch to remote
        try {
          await gitExec(`git push -u origin "${newBranch}"`, cwd, NETWORK_TIMEOUT);
          debugLog('[Git] Pushed branch:', newBranch);
        } catch (pushErr: any) {
          const msg = pushErr.stderr?.toString() || pushErr.message || '';
          if (!msg.includes('up-to-date') && !msg.includes('up to date')) {
            try { await gitExec(`git checkout "${targetBranch}"`, cwd); } catch { /* best effort */ }
            return { success: false, error: `Failed to push branch: ${msg}` };
          }
        }

        // 4. Create PR via gh CLI
        try {
          await gitExec('gh --version', cwd, 10000);
        } catch {
          try { await gitExec(`git checkout "${targetBranch}"`, cwd); } catch { /* best effort */ }
          return { success: false, error: 'GitHub CLI (gh) is not installed. Branch was pushed but PR could not be created.' };
        }

        let prUrl = '';
        let existing = false;
        const escapedTitle = title.replace(/"/g, '\\"');
        const escapedBody = body.replace(/"/g, '\\"');
        try {
          prUrl = await gitExec(
            `gh pr create --base "${targetBranch}" --head "${newBranch}" --title "${escapedTitle}" --body "${escapedBody}"`,
            cwd,
            NETWORK_TIMEOUT,
          );
          debugLog('[Git] Created PR:', prUrl);
        } catch (prErr: any) {
          const stderr = prErr.stderr?.toString() || prErr.message || '';
          if (stderr.includes('already exists')) {
            try {
              prUrl = await gitExec(`gh pr view "${newBranch}" --json url --jq .url`, cwd, NETWORK_TIMEOUT);
              existing = true;
            } catch {
              try { await gitExec(`git checkout "${targetBranch}"`, cwd); } catch { /* best effort */ }
              return { success: false, error: 'A PR already exists for this branch' };
            }
          } else {
            try { await gitExec(`git checkout "${targetBranch}"`, cwd); } catch { /* best effort */ }
            return { success: false, error: stderr || 'Failed to create PR' };
          }
        }

        // 5. Switch back to target branch and reset to remote state
        //    so local target branch is clean (changes only exist on task branch)
        try {
          await gitExec(`git checkout "${targetBranch}"`, cwd);
          debugLog('[Git] Switched back to:', targetBranch);
          try {
            await gitExec(`git reset --hard origin/${targetBranch}`, cwd);
            debugLog('[Git] Reset', targetBranch, 'to origin');
          } catch {
            try {
              await gitExec('git fetch origin', cwd, NETWORK_TIMEOUT);
              await gitExec(`git reset --hard origin/${targetBranch}`, cwd);
            } catch { /* best effort — PR is already created */ }
          }
        } catch { /* non-critical */ }

        return { success: true, prUrl, branch: newBranch, existing };
      } catch (error: any) {
        debugError('[Git] createBranchPR error:', error);
        return { success: false, error: error.message || 'Failed to create branch & PR' };
      }
    }
  );

  // ─── Task Summary (commits + diff stats between branches) ────
  ipcMain.handle(
    IPC_CHANNELS.GIT_TASK_SUMMARY,
    async (_event, cwd: string, taskBranch: string, baseBranch: string) => {
      try {
        if (!isGitRepo(cwd)) {
          return { success: false, error: 'Not a git repository' };
        }

        let commits = '';
        let diffStat = '';
        let uncommittedDiff = '';

        // 1. Always check for uncommitted changes first (staged + unstaged)
        try {
          const staged = await gitExec('git diff --stat --cached', cwd);
          const unstaged = await gitExec('git diff --stat', cwd);
          // Also include untracked files
          const untracked = await gitExec('git ls-files --others --exclude-standard', cwd);
          const parts: string[] = [];
          if (staged) parts.push(staged);
          if (unstaged) parts.push(unstaged);
          if (untracked) {
            const untrackedLines = untracked.split('\n').filter(Boolean).map((f) => ` ${f} (new file)`);
            if (untrackedLines.length > 0) parts.push(untrackedLines.join('\n'));
          }
          uncommittedDiff = parts.join('\n');
        } catch { /* ignore */ }

        // 2. Branch diff if different branches
        if (baseBranch && baseBranch !== taskBranch) {
          try {
            commits = await gitExec(
              `git log --pretty=format:"%s" ${baseBranch}..${taskBranch}`,
              cwd,
            );
          } catch { /* branch may not exist on remote */ }

          try {
            diffStat = await gitExec(
              `git diff --stat ${baseBranch}..${taskBranch}`,
              cwd,
            );
          } catch { /* ignore */ }
        }

        // 3. Fallback to recent commits if no branch diff
        if (!commits) {
          try {
            commits = await gitExec(
              `git log --pretty=format:"%s" -10 HEAD`,
              cwd,
            );
          } catch { /* ignore */ }
        }

        // Prefer uncommitted changes over branch diff for diffStat
        if (uncommittedDiff) {
          diffStat = uncommittedDiff;
        }

        return { success: true, commits, diffStat };
      } catch (error: any) {
        return { success: false, error: error.message || 'Failed to get task summary' };
      }
    }
  );

  // ─── Diff Files — per-file diffs for Changes panel ────────────
  ipcMain.handle(
    IPC_CHANNELS.GIT_DIFF_FILES,
    async (_event, cwd: string, baseBranch?: string) => {
      try {
        if (!isGitRepo(cwd)) {
          return { success: false, error: 'Not a git repository' };
        }

        interface DiffFile { path: string; status: string; diff: string }
        const files: DiffFile[] = [];

        // Get current branch
        let currentBranch = '';
        try { currentBranch = await gitExec('git rev-parse --abbrev-ref HEAD', cwd); } catch { /* ignore */ }

        // Uncommitted changes (staged + unstaged combined)
        try {
          const diff = await gitExec('git diff HEAD --unified=3 --no-color', cwd);
          if (diff) {
            // Parse into per-file diffs
            const fileDiffs = diff.split(/^diff --git /m).filter(Boolean);
            for (const chunk of fileDiffs) {
              const pathMatch = chunk.match(/^a\/(.*?) b\//);
              const path = pathMatch ? pathMatch[1] : 'unknown';
              // Determine status from diff header
              let status = 'modified';
              if (chunk.includes('new file mode')) status = 'added';
              else if (chunk.includes('deleted file mode')) status = 'deleted';
              files.push({ path, status, diff: 'diff --git ' + chunk });
            }
          }
        } catch { /* ignore */ }

        // Untracked new files — synthesize an "all added" diff so the panel
        // can preview the content (capped at 1MB / 10k lines, binary detected).
        try {
          const untracked = await gitExec('git ls-files --others --exclude-standard', cwd);
          if (untracked) {
            for (const filePath of untracked.split('\n').filter(Boolean)) {
              const diff = buildUntrackedDiff(cwd, filePath);
              files.push({ path: filePath, status: 'untracked', diff });
            }
          }
        } catch { /* ignore */ }

        // Staged changes not in HEAD (for files that are only staged)
        try {
          const staged = await gitExec('git diff --cached --unified=3 --no-color', cwd);
          if (staged) {
            const fileDiffs = staged.split(/^diff --git /m).filter(Boolean);
            for (const chunk of fileDiffs) {
              const pathMatch = chunk.match(/^a\/(.*?) b\//);
              const path = pathMatch ? pathMatch[1] : 'unknown';
              // Skip if already in the list from HEAD diff
              if (files.some((f) => f.path === path)) continue;
              let status = 'staged';
              if (chunk.includes('new file mode')) status = 'added';
              files.push({ path, status, diff: 'diff --git ' + chunk });
            }
          }
        } catch { /* ignore */ }

        // Branch diff (committed changes vs base)
        let branchFiles: DiffFile[] = [];
        if (baseBranch && baseBranch !== currentBranch) {
          try {
            const branchDiff = await gitExec(
              `git diff ${baseBranch}...${currentBranch} --unified=3 --no-color`,
              cwd,
            );
            if (branchDiff) {
              const fileDiffs = branchDiff.split(/^diff --git /m).filter(Boolean);
              for (const chunk of fileDiffs) {
                const pathMatch = chunk.match(/^a\/(.*?) b\//);
                const path = pathMatch ? pathMatch[1] : 'unknown';
                let status = 'modified';
                if (chunk.includes('new file mode')) status = 'added';
                else if (chunk.includes('deleted file mode')) status = 'deleted';
                branchFiles.push({ path, status, diff: 'diff --git ' + chunk });
              }
            }
          } catch { /* ignore */ }
        }

        // Commit log
        let commits: string[] = [];
        if (baseBranch && baseBranch !== currentBranch) {
          try {
            const log = await gitExec(
              `git log --pretty=format:"%h %s" ${baseBranch}..${currentBranch}`,
              cwd,
            );
            if (log) commits = log.split('\n').filter(Boolean);
          } catch { /* ignore */ }
        }

        return {
          success: true,
          data: {
            uncommitted: files,
            branch: branchFiles,
            commits,
            currentBranch,
            baseBranch: baseBranch || '',
          },
        };
      } catch (error: any) {
        return { success: false, error: error.message || 'Failed to get diff' };
      }
    },
  );

  // ─── Enable Auto-Merge on PR ─────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.GIT_ENABLE_PR_AUTO_MERGE,
    async (_event, projectPath: string, branch: string) => {
      try {
        await gitExec(
          `gh pr merge "${branch}" --auto --squash`,
          projectPath,
          NETWORK_TIMEOUT,
        );
        debugLog('[Git] Auto-merge enabled for:', branch);
        return { success: true };
      } catch (error: any) {
        const msg = error.stderr?.toString() || error.message || '';
        debugError('[Git] enableAutoMerge error:', msg);
        return { success: false, error: msg || 'Failed to enable auto-merge' };
      }
    }
  );
}
