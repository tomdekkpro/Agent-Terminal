import { useState, useEffect, useRef } from 'react';
import {
  GitBranch, ChevronDown, MessageSquare, CheckCircle2, Trash2, Loader2,
  GitCommitVertical, GitMerge, GitBranchPlus, GitPullRequest, Zap,
} from 'lucide-react';
import type { TerminalTask } from '../../../shared/types';
import { cn } from '../../../shared/utils';

export interface TaskCompleteOptions {
  postComment?: boolean;
  comment?: string;
  setReadyForReview?: boolean;
  taskId?: string;
}

const PRIORITY_BRANCHES = ['main', 'master', 'develop', 'dev'];

/** Complete Task Modal — single-step dialog with auto-selected base branch. */
export function CompleteTaskModal({
  taskBranch,
  taskName,
  task,
  terminalId,
  isAgentRunning,
  projectPath,
  isWorktree,
  hasTaskManager,
  defaultBaseBranch,
  onMerge: onMergeAction,
  onCreatePR,
  onCreateBranchPR,
  onCommit,
  onCancel,
}: {
  taskBranch: string;
  taskName?: string;
  task?: TerminalTask;
  terminalId: string;
  isAgentRunning: boolean;
  projectPath: string;
  isWorktree: boolean;
  hasTaskManager: boolean;
  defaultBaseBranch?: string;
  onMerge: (targetBranch: string) => void;
  onCreatePR: (targetBranch: string, title: string, body: string, autoMerge: boolean, cleanupWorktree: boolean, taskOptions?: TaskCompleteOptions) => void;
  onCreateBranchPR: (newBranch: string, targetBranch: string, title: string, body: string, cleanupWorktree: boolean, taskOptions?: TaskCompleteOptions) => void;
  onCommit: (message: string) => void;
  onCancel: () => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBranch, setSelectedBranch] = useState(defaultBaseBranch || '');
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [branchSearch, setBranchSearch] = useState('');
  // Only prefix the PR title with the task ID when the task is linked to a
  // task manager (ClickUp / Jira). Local tasks have no external ID worth
  // including. Prefer customId (e.g., "DEV-123") over the raw provider id.
  const isLinkedTask = !!task && task.provider !== 'none';
  const taskIdPrefix = isLinkedTask ? (task!.customId ? `${task!.customId} ` : `${task!.id} `) : '';
  const [prTitle, setPrTitle] = useState(taskName ? `${taskIdPrefix}[${taskBranch}] ${taskName}` : taskBranch);
  const [prBody, setPrBody] = useState('');
  const [postComment, setPostComment] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commentLoading, setCommentLoading] = useState(false);
  const [setReadyForReview, setSetReadyForReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Worktree cleanup toggle — defaults ON for worktrees, ignored otherwise.
  // Applies to PR paths only; merge always cleans up (IPC removes the
  // worktree before merging — required so the target branch can be checked
  // out at the project root).
  const [cleanupWorktreeOpt, setCleanupWorktreeOpt] = useState(true);
  const [showPrMenu, setShowPrMenu] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const prMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.electronAPI
      .listBranches(projectPath)
      .then((result: any) => {
        if (result.success && result.branches) {
          const others = result.branches as string[];
          others.sort((a, b) => {
            const ai = PRIORITY_BRANCHES.indexOf(a);
            const bi = PRIORITY_BRANCHES.indexOf(b);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return a.localeCompare(b);
          });
          setBranches(others);
          const trimmedDefault = defaultBaseBranch?.trim();
          if (trimmedDefault && others.includes(trimmedDefault)) {
            setSelectedBranch(trimmedDefault);
          } else {
            const auto = others.find((b) => PRIORITY_BRANCHES.includes(b));
            setSelectedBranch(auto || others[0] || '');
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectPath, taskBranch]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    };
    if (showBranchDropdown) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showBranchDropdown]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (prMenuRef.current && !prMenuRef.current.contains(e.target as Node)) {
        setShowPrMenu(false);
      }
    };
    if (showPrMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPrMenu]);

  // Fetch root cause summary when checkbox is enabled
  useEffect(() => {
    if (!postComment || commentText || !terminalId) return;
    setCommentLoading(true);
    const baseBranch = selectedBranch && selectedBranch !== taskBranch ? selectedBranch : '';
    window.electronAPI.getTaskSummary(projectPath, taskBranch, baseBranch)
      .then((r: any) => {
        if (r.success) {
          const commits = (r.commits || '').trim();
          const diffStat = (r.diffStat || '').trim();
          if (!commits && !diffStat) {
            setCommentText('Root cause:\n\n\nSolution:\n');
            return;
          }
          const lines: string[] = ['Root cause:\n'];
          lines.push('\nSolution:');
          if (diffStat) lines.push('\n\nFiles changed:\n' + diffStat);
          if (commits) {
            lines.push('\n\nRecent commits:');
            lines.push(commits.split('\n').map((c: string) => `- ${c}`).join('\n'));
          }
          setCommentText(lines.join('\n'));
        } else {
          setCommentText('Root cause:\n\n\nSolution:\n');
        }
      })
      .catch(() => setCommentText('Root cause:\n\n\nSolution:\n'))
      .finally(() => setCommentLoading(false));
  }, [postComment]);

  const filteredBranches = branches.filter((b) => {
    if (!branchSearch) return true;
    return b.toLowerCase().includes(branchSearch.toLowerCase());
  });

  const taskSlug = task?.customId || task?.id || '';
  const defaultNewBranch = taskSlug ? `task/${taskSlug}` : '';

  const handleAction = async (action: 'merge' | 'pr' | 'pr-auto' | 'commit' | 'branch-pr') => {
    if (!selectedBranch && action !== 'commit') return;
    setSubmitting(true);

    const isPRAction = action === 'pr' || action === 'pr-auto' || action === 'branch-pr';
    const hasTaskOptions = (postComment && task) || (setReadyForReview && task);
    const deferTaskActions = isPRAction && isAgentRunning && hasTaskOptions;

    const taskOptions: TaskCompleteOptions | undefined = deferTaskActions
      ? {
          postComment: postComment || undefined,
          comment: postComment && commentText.trim() ? commentText.trim() : undefined,
          setReadyForReview: setReadyForReview || undefined,
          taskId: task?.id,
        }
      : undefined;

    try {
      if (!deferTaskActions) {
        if (postComment && task && commentText.trim()) {
          try { await window.electronAPI.postTaskComment(task.id, commentText.trim()); } catch { /* non-critical */ }
        }
        if (setReadyForReview && task) {
          try { await window.electronAPI.updateTaskStatus(task.id, 'ready for review'); } catch { /* non-critical */ }
        }
      }

      if (action === 'merge') {
        onMergeAction(selectedBranch);
      } else if (action === 'pr' || action === 'pr-auto') {
        onCreatePR(selectedBranch, prTitle, prBody, action === 'pr-auto', isWorktree && cleanupWorktreeOpt, taskOptions);
      } else if (action === 'branch-pr') {
        onCreateBranchPR(defaultNewBranch, selectedBranch, prTitle, prBody, isWorktree && cleanupWorktreeOpt, taskOptions);
      } else {
        onCommit(prTitle);
      }
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[520px] max-h-[85vh] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col overflow-hidden">
        <div className="p-4 border-b border-[var(--border)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Complete Task</h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            <span className="font-mono text-[var(--accent)]">{taskBranch}</span>
            {selectedBranch && (
              <>{' → '}<span className="font-mono text-emerald-400">{selectedBranch}</span></>
            )}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Base branch selector */}
          <div>
            <label className="text-[11px] text-[var(--text-muted)] mb-1.5 block">Base Branch</label>
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowBranchDropdown(!showBranchDropdown)}
                disabled={loading}
                className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
              >
                <GitBranch className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                <span className="font-mono flex-1 text-left truncate">
                  {loading ? 'Loading...' : selectedBranch || 'Select branch'}
                </span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-[var(--text-muted)] transition-transform', showBranchDropdown && 'rotate-180')} />
              </button>
              {showBranchDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-10 max-h-[200px] flex flex-col overflow-hidden">
                  <div className="p-2 border-b border-[var(--border)]">
                    <input
                      autoFocus
                      type="text"
                      value={branchSearch}
                      onChange={(e) => setBranchSearch(e.target.value)}
                      placeholder="Search branches..."
                      className="w-full px-2 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  <div className="overflow-y-auto p-1">
                    {filteredBranches.map((branch) => (
                      <button
                        key={branch}
                        onClick={() => { setSelectedBranch(branch); setShowBranchDropdown(false); setBranchSearch(''); }}
                        className={cn(
                          'w-full text-left px-3 py-2 rounded-md text-xs font-mono transition-colors flex items-center gap-2',
                          branch === selectedBranch
                            ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                            : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                        )}
                      >
                        <GitBranch className="w-3 h-3 shrink-0 text-[var(--text-muted)]" />
                        <span className="truncate flex-1">{branch}</span>
                        {PRIORITY_BRANCHES.slice(0, 2).includes(branch) && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 shrink-0">default</span>
                        )}
                      </button>
                    ))}
                    {filteredBranches.length === 0 && (
                      <div className="text-xs text-[var(--text-muted)] text-center py-3">No branches found</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="text-[11px] text-[var(--text-muted)] mb-1.5 block">PR Title</label>
            <input
              type="text"
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div>
            <label className="text-[11px] text-[var(--text-muted)] mb-1.5 block">Description <span className="opacity-50">(optional)</span></label>
            <textarea
              value={prBody}
              onChange={(e) => setPrBody(e.target.value)}
              rows={3}
              placeholder="PR description..."
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none"
            />
          </div>

          {hasTaskManager && task && (
            <div className="border border-[var(--border)] rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border)]">
                <span className="text-[11px] font-medium text-[var(--text-secondary)]">Task Options</span>
              </div>
              <div className="p-3 space-y-3">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={postComment}
                    onChange={(e) => setPostComment(e.target.checked)}
                    className="mt-0.5 accent-[var(--accent)]"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]">
                      <MessageSquare className="w-3 h-3 text-[var(--text-muted)]" />
                      Post root cause & solution as comment
                    </div>
                    {postComment && isAgentRunning && (
                      <p className="mt-1 text-[10px] text-[var(--text-muted)]">Agent will generate and post the comment</p>
                    )}
                    {postComment && !isAgentRunning && (
                      commentLoading ? (
                        <div className="flex items-center gap-2 mt-2 text-xs text-[var(--text-muted)]">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Loading commit summary...
                        </div>
                      ) : (
                        <textarea
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          rows={8}
                          placeholder="Describe what caused the issue and how it was fixed..."
                          className="w-full mt-2 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-y font-mono leading-relaxed"
                        />
                      )
                    )}
                  </div>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={setReadyForReview}
                    onChange={(e) => setSetReadyForReview(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <div className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]">
                    <CheckCircle2 className="w-3 h-3 text-[var(--text-muted)]" />
                    Change status to <span className="font-medium text-amber-400">Ready for Review</span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {isWorktree && (
            <label className="flex items-start gap-2.5 cursor-pointer px-1">
              <input
                type="checkbox"
                checked={cleanupWorktreeOpt}
                onChange={(e) => setCleanupWorktreeOpt(e.target.checked)}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-xs text-[var(--text-primary)]">
                  <Trash2 className="w-3 h-3 text-[var(--text-muted)]" />
                  Remove worktree when done
                </div>
                <p className="mt-0.5 text-[10px] text-[var(--text-muted)] leading-relaxed">
                  Applies after Create PR. Merge Locally always removes the worktree.
                  {isAgentRunning && cleanupWorktreeOpt && ' Agent is running — cleanup runs when the terminal closes.'}
                </p>
              </div>
            </label>
          )}
        </div>

        <div className="p-4 border-t border-[var(--border)] flex items-center gap-2 justify-between">
          <button
            onClick={() => handleAction('commit')}
            disabled={submitting}
            className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
            title="Stage all changes and commit with the PR title as message — does not complete the task"
          >
            <GitCommitVertical className="w-3 h-3" />
            Commit only
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              Cancel
            </button>
            {isWorktree && (
              <button
                onClick={() => handleAction('merge')}
                disabled={!selectedBranch || submitting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
                title={`Merge ${taskBranch} into ${selectedBranch} locally and remove the worktree`}
              >
                <GitMerge className="w-3.5 h-3.5" />
                Merge Locally
              </button>
            )}
            {!isWorktree && defaultNewBranch && (
              <button
                onClick={() => handleAction('branch-pr')}
                disabled={!selectedBranch || submitting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs bg-sky-500/20 text-sky-400 hover:bg-sky-500/30 transition-colors disabled:opacity-40"
                title={`Create branch "${defaultNewBranch}" from current commits and PR to ${selectedBranch}`}
              >
                <GitBranchPlus className="w-3.5 h-3.5" />
                Branch & PR
              </button>
            )}
            {selectedBranch !== taskBranch && (
              <div className="relative flex items-stretch" ref={prMenuRef}>
                <button
                  onClick={() => handleAction('pr')}
                  disabled={!selectedBranch || submitting}
                  className="flex items-center gap-2 px-4 py-2 rounded-l-lg text-xs bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-40"
                >
                  <GitPullRequest className="w-3.5 h-3.5" />
                  Create PR
                </button>
                <button
                  onClick={() => setShowPrMenu(!showPrMenu)}
                  disabled={!selectedBranch || submitting}
                  className="flex items-center px-2 rounded-r-lg text-xs bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors disabled:opacity-40 border-l border-[var(--accent)]/30"
                  title="More PR options"
                >
                  <ChevronDown className={cn('w-3 h-3 transition-transform', showPrMenu && 'rotate-180')} />
                </button>
                {showPrMenu && (
                  <div className="absolute right-0 bottom-full mb-1 w-56 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-20 py-1 overflow-hidden">
                    <button
                      onClick={() => { setShowPrMenu(false); handleAction('pr'); }}
                      disabled={submitting}
                      className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
                    >
                      <GitPullRequest className="w-3.5 h-3.5 mt-0.5 text-[var(--accent)]" />
                      <div className="min-w-0">
                        <div className="text-xs text-[var(--text-primary)]">Create PR</div>
                        <div className="text-[10px] text-[var(--text-muted)]">Open a pull request — review before merge</div>
                      </div>
                    </button>
                    <button
                      onClick={() => { setShowPrMenu(false); handleAction('pr-auto'); }}
                      disabled={submitting}
                      className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--bg-tertiary)] transition-colors"
                    >
                      <Zap className="w-3.5 h-3.5 mt-0.5 text-purple-400" />
                      <div className="min-w-0">
                        <div className="text-xs text-[var(--text-primary)]">PR + Auto-Merge</div>
                        <div className="text-[10px] text-[var(--text-muted)]">Open PR and auto-merge once checks pass</div>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
