/**
 * Find which cwd holds a Claude session file.
 *
 * Claude scopes `--resume <id>` lookups by encoded cwd. If the agent was
 * started in cwd A but we resume from cwd B, the CLI emits "No conversation
 * found with session id". Sessions can live anywhere depending on whether
 * the user originally worked in the project root, a task worktree, or
 * another path — so we probe candidates in priority order and resume from
 * whichever location actually holds the conversation file.
 */
export interface SessionCwdCandidate {
  cwd: string;
  isWorktree: boolean;
}

export interface ResolvedSessionCwd {
  cwd: string;
  isWorktree: boolean;
}

const normalizePath = (p: string): string =>
  p.replace(/[/\\]+/g, '/').replace(/\/$/, '').toLowerCase();

export async function resolveSessionCwd(
  sessionId: string | undefined,
  candidates: Array<SessionCwdCandidate | null | undefined>,
): Promise<ResolvedSessionCwd | null> {
  if (!sessionId) return null;
  const seen = new Set<string>();
  const deduped = candidates.filter((c): c is SessionCwdCandidate => {
    if (!c?.cwd) return false;
    const key = normalizePath(c.cwd);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const candidate of deduped) {
    try {
      const result = await window.electronAPI.claudeSessionExists(candidate.cwd, sessionId);
      if (result?.data) {
        return { cwd: candidate.cwd, isWorktree: candidate.isWorktree };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Build the standard candidate list given a task / terminal context. */
export function buildSessionCandidates(opts: {
  agentCwd?: string;
  worktreePath?: string;
  projectPath?: string;
  /** Computed worktree path (project + .task-worktrees + sanitized id) — optional */
  computedWorktreePath?: string;
  /** Current terminal cwd — included for app-restart restore where we don't know
   *  whether the saved cwd is project root or worktree. */
  currentCwd?: string;
}): SessionCwdCandidate[] {
  const norm = (p: string) => normalizePath(p);
  const wt = opts.worktreePath;
  const isWtMatch = (p?: string): boolean =>
    !!p && !!wt && norm(p) === norm(wt);

  const list: Array<SessionCwdCandidate | null> = [
    opts.agentCwd ? { cwd: opts.agentCwd, isWorktree: isWtMatch(opts.agentCwd) } : null,
    opts.currentCwd ? { cwd: opts.currentCwd, isWorktree: isWtMatch(opts.currentCwd) } : null,
    opts.worktreePath ? { cwd: opts.worktreePath, isWorktree: true } : null,
    opts.computedWorktreePath ? { cwd: opts.computedWorktreePath, isWorktree: true } : null,
    opts.projectPath ? { cwd: opts.projectPath, isWorktree: false } : null,
  ];
  return list.filter((c): c is SessionCwdCandidate => !!c);
}
