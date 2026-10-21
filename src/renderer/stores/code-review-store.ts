import { create } from 'zustand';
import { TEST_EVIDENCE_FINDING_FILE } from '../../shared/test-evidence';
import type { CodeReviewEvent, CodeReviewFinding, CodeReviewItem, CodeReviewPR, CodeReviewStatus } from '../../shared/types';
import { useSettingsStore } from './settings-store';

interface CodeReviewState {
  items: CodeReviewItem[];
  loading: boolean;
  error: string | null;
  reviewingAll: boolean;
  // Actions. `prRepo` is the PR's `owner/name` — a task can have PRs in
  // several repos, and PR numbers are only unique within one.
  loadTasks: (statuses?: string[], projectPath?: string, listIds?: string[]) => Promise<void>;
  runReview: (projectPath: string, taskId: string, prNumber: number, prRepo?: string) => Promise<void>;
  runAllReviews: (projectPath: string) => Promise<void>;
  stopReview: (taskId: string, prNumber?: number, prRepo?: string) => Promise<void>;
  stopAllReviews: () => Promise<void>;
  submitResult: (projectPath: string, taskId: string, prNumber: number, passed: boolean, findings: CodeReviewFinding[], prTitle: string, prRepo?: string, testedBy?: string) => Promise<void>;
  forceApprove: (projectPath: string, taskId: string, prNumber: number, prTitle: string, prRepo?: string) => Promise<void>;
  /** Post a `test:manual` note for a developer who tested by hand. PRs that
   *  failed only for missing tests go back to pending, ready to re-review. */
  markTested: (taskId: string, note: string) => Promise<{ success: boolean; error?: string }>;
  addPR: (projectPath: string, taskId: string, prInput: string) => Promise<{ success: boolean; error?: string }>;
  /** Approve + merge one PR on GitHub after the release-branch checks. */
  mergePR: (projectPath: string, taskId: string, prNumber: number, prRepo?: string) => Promise<void>;
  /** Merge every passed, unmerged PR of a task together — all or nothing, so
   *  a fix split across repos never lands half-merged. `auto` = triggered by
   *  a passing review, not a click. */
  mergeTask: (projectPath: string, taskId: string, auto?: boolean) => Promise<void>;
  handleEvent: (event: CodeReviewEvent) => void;
  updateItem: (taskId: string, updates: Partial<CodeReviewItem>) => void;
  updatePR: (taskId: string, prNumber: number, updates: Partial<CodeReviewPR>, prRepo?: string) => void;
  clearItems: () => void;
}

/** Same PR? Numbers repeat across repos, so the repo decides when both sides know it. */
export function isSamePR(pr: CodeReviewPR, prNumber: number, prRepo?: string): boolean {
  return pr.prNumber === prNumber && (!prRepo || !pr.prRepo || pr.prRepo.toLowerCase() === prRepo.toLowerCase());
}

/** Derive task-level status from its PRs */
function deriveTaskStatus(prs: CodeReviewPR[]): CodeReviewStatus {
  if (prs.length === 0) return 'pending';
  if (prs.some((p) => p.status === 'reviewing')) return 'reviewing';
  if (prs.some((p) => p.status === 'failed')) return 'failed';
  if (prs.some((p) => p.status === 'error')) return 'error';
  if (prs.every((p) => p.status === 'passed')) return 'passed';
  if (prs.every((p) => p.status === 'skipped')) return 'skipped';
  return 'pending';
}

/** PRs of a task that still need merging — skipped ones are already closed or merged on GitHub. */
function unmergedPRs(item: CodeReviewItem): CodeReviewPR[] {
  return item.prs.filter((p) => p.status !== 'skipped' && p.mergeStatus !== 'merged');
}

export const useCodeReviewStore = create<CodeReviewState>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  reviewingAll: false,

  loadTasks: async (statuses, projectPath, listIds) => {
    set({ loading: true, error: null });
    try {
      const result = await window.electronAPI.codeReviewGetTasks(statuses, projectPath, listIds);
      if (result.success) {
        set({ items: result.data, loading: false });
      } else {
        set({ error: result.error, loading: false });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load tasks', loading: false });
    }
  },

  runReview: async (projectPath, taskId, prNumber, prRepo) => {
    get().updatePR(taskId, prNumber, { status: 'reviewing', findings: [], error: undefined, overridden: undefined }, prRepo);
    try {
      const result = await window.electronAPI.codeReviewRun(projectPath, taskId, prNumber, prRepo);
      if (result.success) {
        const { passed, findings, prTitle, prUrl, prBranch, prBaseBranch, prAuthor, prHeadSha, skipped, approved, testedBy } = result.data;
        if (skipped) {
          get().updatePR(taskId, prNumber, { status: 'skipped', prUrl, prBranch, prBaseBranch, prAuthor, prTitle }, prRepo);
          return;
        }
        get().updatePR(taskId, prNumber, {
          status: passed ? 'passed' : 'failed',
          findings,
          prUrl,
          prBranch,
          prBaseBranch,
          prAuthor,
          prTitle,
          reviewedAt: new Date().toISOString(),
          reviewedHeadSha: prHeadSha,
          mergeStatus: undefined,
          mergeError: undefined,
        }, prRepo);
        // Auto-submit result
        await get().submitResult(projectPath, taskId, prNumber, passed, findings, prTitle, prRepo, testedBy);
        // Not after a `review:approve` override — the AI never passed that
        // code, so it waits for someone to press Merge. And only once EVERY
        // PR of the task has passed: a fix in wp and customerweb merges as a
        // whole or not at all, so the first PR to pass waits for the others.
        if (passed && !approved && useSettingsStore.getState().settings.codeReviewAutoMerge) {
          const item = get().items.find((i) => i.taskId === taskId);
          const pending = item ? unmergedPRs(item) : [];
          if (pending.length > 0 && pending.every((p) => p.status === 'passed' && !p.overridden)) {
            await get().mergeTask(projectPath, taskId, true);
          }
        }
      } else {
        get().updatePR(taskId, prNumber, { status: 'error', error: result.error }, prRepo);
      }
    } catch (err) {
      get().updatePR(taskId, prNumber, { status: 'error', error: err instanceof Error ? err.message : 'Review failed' }, prRepo);
    }
  },

  runAllReviews: async (projectPath) => {
    set({ reviewingAll: true });
    const items = get().items;
    for (const item of items) {
      if (!get().reviewingAll) break;
      const pendingPRs = item.prs.filter((pr) => pr.status === 'pending');
      for (const pr of pendingPRs) {
        if (!get().reviewingAll) break;
        await get().runReview(projectPath, item.taskId, pr.prNumber, pr.prRepo);
      }
    }
    set({ reviewingAll: false });
  },

  stopReview: async (taskId, prNumber, prRepo) => {
    await window.electronAPI.codeReviewStop?.(taskId);
    if (prNumber) {
      get().updatePR(taskId, prNumber, { status: 'pending', error: undefined }, prRepo);
    } else {
      get().updateItem(taskId, { status: 'pending', error: undefined });
    }
  },

  stopAllReviews: async () => {
    set({ reviewingAll: false });
    await window.electronAPI.codeReviewStopAll?.();
    const items = get().items;
    for (const item of items) {
      const updated = item.prs.map((pr) =>
        pr.status === 'reviewing' ? { ...pr, status: 'pending' as const, error: undefined } : pr,
      );
      get().updateItem(item.taskId, { prs: updated, status: deriveTaskStatus(updated) });
    }
  },

  submitResult: async (projectPath, taskId, prNumber, passed, findings, prTitle, prRepo, testedBy) => {
    try {
      await window.electronAPI.codeReviewSubmit(projectPath, taskId, prNumber, passed, findings, prTitle, prRepo, testedBy);
    } catch (err) {
      // Non-critical — review result is already shown in UI
      console.error('[CodeReview] Failed to submit result:', err);
    }
  },

  forceApprove: async (projectPath, taskId, prNumber, prTitle, prRepo) => {
    // Optimistically update UI
    get().updatePR(taskId, prNumber, { status: 'passed', findings: [], overridden: true }, prRepo);
    try {
      await window.electronAPI.codeReviewForceApprove(projectPath, taskId, prNumber, prTitle, prRepo);
    } catch (err) {
      // Revert on failure
      get().updatePR(taskId, prNumber, { status: 'failed', overridden: undefined }, prRepo);
      console.error('[CodeReview] Failed to force approve:', err);
    }
  },

  markTested: async (taskId, note) => {
    try {
      const result = await window.electronAPI.codeReviewMarkTested(taskId, note);
      if (!result.success) return { success: false, error: result.error };
      const item = get().items.find((i) => i.taskId === taskId);
      for (const pr of item?.prs ?? []) {
        const onlyUntested = pr.status === 'failed'
          && pr.findings.length > 0
          && pr.findings.every((f) => f.file === TEST_EVIDENCE_FINDING_FILE);
        if (onlyUntested) get().updatePR(taskId, pr.prNumber, { status: 'pending', findings: [] }, pr.prRepo);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to post the test note' };
    }
  },

  addPR: async (projectPath, taskId, prInput) => {
    try {
      const result = await window.electronAPI.codeReviewAddPR(projectPath, prInput);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      const { prNumber, prRepo, prUrl, prBranch, prBaseBranch, prAuthor, prTitle } = result.data;
      const item = get().items.find((i) => i.taskId === taskId);
      if (!item) return { success: false, error: 'Task not found' };
      if (item.prs.some((p) => isSamePR(p, prNumber, prRepo))) {
        return { success: false, error: `PR #${prNumber} already attached` };
      }
      const newPR: CodeReviewPR = {
        prNumber,
        prRepo,
        prUrl,
        prBranch,
        prBaseBranch,
        prAuthor,
        prTitle,
        status: 'pending',
        findings: [],
      };
      const updatedPRs = [...item.prs, newPR];
      get().updateItem(taskId, { prs: updatedPRs, status: deriveTaskStatus(updatedPRs) });
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to add PR' };
    }
  },

  mergePR: async (projectPath, taskId, prNumber, prRepo) => {
    const pr = get().items.find((i) => i.taskId === taskId)?.prs.find((p) => isSamePR(p, prNumber, prRepo));
    if (!pr || pr.mergeStatus === 'merging' || pr.mergeStatus === 'merged') return;
    get().updatePR(taskId, prNumber, { mergeStatus: 'merging', mergeError: undefined }, prRepo);
    try {
      const result = await window.electronAPI.codeReviewMerge(projectPath, taskId, prNumber, {
        reviewedHeadSha: pr.reviewedHeadSha,
        prRepo: pr.prRepo,
      });
      get().updatePR(taskId, prNumber, result.success
        ? { mergeStatus: 'merged', mergeError: undefined }
        : { mergeStatus: 'blocked', mergeError: result.error }, prRepo);
    } catch (err) {
      get().updatePR(taskId, prNumber, { mergeStatus: 'blocked', mergeError: err instanceof Error ? err.message : 'Merge failed' }, prRepo);
    }
  },

  mergeTask: async (projectPath, taskId, auto) => {
    const item = get().items.find((i) => i.taskId === taskId);
    if (!item) return;
    const prs = unmergedPRs(item).filter((p) => p.status === 'passed' && p.mergeStatus !== 'merging');
    if (prs.length === 0) return;
    for (const pr of prs) get().updatePR(taskId, pr.prNumber, { mergeStatus: 'merging', mergeError: undefined }, pr.prRepo);
    const blockAll = (message: string) => {
      for (const pr of prs) get().updatePR(taskId, pr.prNumber, { mergeStatus: 'blocked', mergeError: message }, pr.prRepo);
    };
    try {
      const result = await window.electronAPI.codeReviewMergeTask(
        projectPath,
        taskId,
        prs.map((p) => ({ prNumber: p.prNumber, prRepo: p.prRepo, reviewedHeadSha: p.reviewedHeadSha })),
        auto,
      );
      if (!result.data) {
        blockAll(result.error || 'Merge failed');
        return;
      }
      for (const outcome of result.data as Array<{ prNumber: number; prRepo?: string; merged: boolean; message: string }>) {
        get().updatePR(taskId, outcome.prNumber, outcome.merged
          ? { mergeStatus: 'merged', mergeError: undefined }
          : { mergeStatus: 'blocked', mergeError: outcome.message }, outcome.prRepo);
      }
    } catch (err) {
      blockAll(err instanceof Error ? err.message : 'Merge failed');
    }
  },

  handleEvent: (event) => {
    const { taskId } = event;
    const TERMINAL: string[] = ['passed', 'failed', 'error', 'skipped'];
    const item = get().items.find((i) => i.taskId === taskId);

    switch (event.type) {
      case 'progress':
        if (item && TERMINAL.includes(item.status)) break;
        set((state) => ({
          items: state.items.map((i) =>
            i.taskId === taskId ? { ...i, status: 'reviewing' as const } : i,
          ),
        }));
        break;
      case 'finding':
        if (event.finding && item) {
          set((state) => ({
            items: state.items.map((i) =>
              i.taskId === taskId ? { ...i, findings: [...i.findings, event.finding!] } : i,
            ),
          }));
        }
        break;
      case 'done':
        set((state) => ({
          items: state.items.map((i) =>
            i.taskId === taskId
              ? { ...i, status: event.status || 'passed', findings: event.findings || i.findings, reviewedAt: new Date().toISOString() }
              : i,
          ),
        }));
        break;
      case 'error':
        set((state) => ({
          items: state.items.map((i) =>
            i.taskId === taskId ? { ...i, status: 'error' as const, error: event.message } : i,
          ),
        }));
        break;
      case 'merge':
        // Scheduler-driven merges report here; button merges also get the
        // IPC result, and both carry the same outcome.
        if (item && event.prNumber && event.mergeStatus) {
          get().updatePR(taskId, event.prNumber, {
            mergeStatus: event.mergeStatus,
            mergeError: event.mergeStatus === 'blocked' ? event.message : undefined,
          }, event.prRepo);
        }
        break;
      case 'prs':
        // Phase 2 of the load: the task list arrives first, its PRs follow as
        // each task is matched. Only applies while the task is still pending —
        // once a review is under way it owns its own PR statuses, and a late
        // event must not reset them.
        if (!item || item.status !== 'pending') break;
        set((state) => ({
          items: state.items.map((i) => {
            if (i.taskId !== taskId) return i;
            const prs = event.prs ?? [];
            const only = prs.length === 1 ? prs[0] : undefined;
            return {
              ...i,
              prs,
              prsResolving: false,
              // Deprecated single-PR fields, kept in step for any consumer
              // still reading them.
              prNumber: only?.prNumber,
              prUrl: only?.prUrl,
            };
          }),
        }));
        break;
    }
  },

  updateItem: (taskId, updates) => {
    set((state) => ({
      items: state.items.map((item) =>
        item.taskId === taskId ? { ...item, ...updates } : item,
      ),
    }));
  },

  updatePR: (taskId, prNumber, updates, prRepo) => {
    set((state) => ({
      items: state.items.map((item) => {
        if (item.taskId !== taskId) return item;
        const updatedPRs = item.prs.map((pr) =>
          isSamePR(pr, prNumber, prRepo) ? { ...pr, ...updates } : pr,
        );
        return {
          ...item,
          prs: updatedPRs,
          status: deriveTaskStatus(updatedPRs),
          // Aggregate findings from all PRs
          findings: updatedPRs.flatMap((pr) => pr.findings),
        };
      }),
    }));
  },

  clearItems: () => set({ items: [], error: null }),
}));
