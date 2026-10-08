import { create } from 'zustand';
import type { CodeReviewEvent, CodeReviewFinding, CodeReviewItem, CodeReviewPR, CodeReviewStatus } from '../../shared/types';
import { useSettingsStore } from './settings-store';

interface CodeReviewState {
  items: CodeReviewItem[];
  loading: boolean;
  error: string | null;
  reviewingAll: boolean;
  // Actions
  loadTasks: (statuses?: string[], projectPath?: string, listIds?: string[]) => Promise<void>;
  runReview: (projectPath: string, taskId: string, prNumber: number) => Promise<void>;
  runAllReviews: (projectPath: string) => Promise<void>;
  stopReview: (taskId: string, prNumber?: number) => Promise<void>;
  stopAllReviews: () => Promise<void>;
  submitResult: (projectPath: string, taskId: string, prNumber: number, passed: boolean, findings: CodeReviewFinding[], prTitle: string) => Promise<void>;
  forceApprove: (projectPath: string, taskId: string, prNumber: number, prTitle: string) => Promise<void>;
  addPR: (projectPath: string, taskId: string, prInput: string) => Promise<{ success: boolean; error?: string }>;
  /** Approve + merge on GitHub after the release-branch checks. `auto` = triggered by a passing review, not a click. */
  mergePR: (projectPath: string, taskId: string, prNumber: number, auto?: boolean) => Promise<void>;
  handleEvent: (event: CodeReviewEvent) => void;
  updateItem: (taskId: string, updates: Partial<CodeReviewItem>) => void;
  updatePR: (taskId: string, prNumber: number, updates: Partial<CodeReviewPR>) => void;
  clearItems: () => void;
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

  runReview: async (projectPath, taskId, prNumber) => {
    get().updatePR(taskId, prNumber, { status: 'reviewing', findings: [], error: undefined });
    try {
      const result = await window.electronAPI.codeReviewRun(projectPath, taskId, prNumber);
      if (result.success) {
        const { passed, findings, prTitle, prUrl, prBranch, prBaseBranch, prAuthor, prHeadSha, skipped, approved } = result.data;
        if (skipped) {
          get().updatePR(taskId, prNumber, { status: 'skipped', prUrl, prBranch, prBaseBranch, prAuthor, prTitle });
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
        });
        // Auto-submit result
        await get().submitResult(projectPath, taskId, prNumber, passed, findings, prTitle);
        // Not after a `review:approve` override — the AI never passed that
        // code, so it waits for someone to press Merge.
        if (passed && !approved && useSettingsStore.getState().settings.codeReviewAutoMerge) {
          await get().mergePR(projectPath, taskId, prNumber, true);
        }
      } else {
        get().updatePR(taskId, prNumber, { status: 'error', error: result.error });
      }
    } catch (err) {
      get().updatePR(taskId, prNumber, { status: 'error', error: err instanceof Error ? err.message : 'Review failed' });
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
        await get().runReview(projectPath, item.taskId, pr.prNumber);
      }
    }
    set({ reviewingAll: false });
  },

  stopReview: async (taskId, prNumber) => {
    await window.electronAPI.codeReviewStop?.(taskId);
    if (prNumber) {
      get().updatePR(taskId, prNumber, { status: 'pending', error: undefined });
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

  submitResult: async (projectPath, taskId, prNumber, passed, findings, prTitle) => {
    try {
      await window.electronAPI.codeReviewSubmit(projectPath, taskId, prNumber, passed, findings, prTitle);
    } catch (err) {
      // Non-critical — review result is already shown in UI
      console.error('[CodeReview] Failed to submit result:', err);
    }
  },

  forceApprove: async (projectPath, taskId, prNumber, prTitle) => {
    // Optimistically update UI
    get().updatePR(taskId, prNumber, { status: 'passed', findings: [] });
    try {
      await window.electronAPI.codeReviewForceApprove(projectPath, taskId, prNumber, prTitle);
    } catch (err) {
      // Revert on failure
      get().updatePR(taskId, prNumber, { status: 'failed' });
      console.error('[CodeReview] Failed to force approve:', err);
    }
  },

  addPR: async (projectPath, taskId, prInput) => {
    try {
      const result = await window.electronAPI.codeReviewAddPR(projectPath, prInput);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      const { prNumber, prUrl, prBranch, prBaseBranch, prAuthor, prTitle } = result.data;
      const item = get().items.find((i) => i.taskId === taskId);
      if (!item) return { success: false, error: 'Task not found' };
      if (item.prs.some((p) => p.prNumber === prNumber)) {
        return { success: false, error: `PR #${prNumber} already attached` };
      }
      const newPR: CodeReviewPR = {
        prNumber,
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

  mergePR: async (projectPath, taskId, prNumber, auto) => {
    const pr = get().items.find((i) => i.taskId === taskId)?.prs.find((p) => p.prNumber === prNumber);
    if (!pr || pr.mergeStatus === 'merging' || pr.mergeStatus === 'merged') return;
    get().updatePR(taskId, prNumber, { mergeStatus: 'merging', mergeError: undefined });
    try {
      const result = await window.electronAPI.codeReviewMerge(projectPath, taskId, prNumber, {
        reviewedHeadSha: pr.reviewedHeadSha,
        auto,
      });
      get().updatePR(taskId, prNumber, result.success
        ? { mergeStatus: 'merged', mergeError: undefined }
        : { mergeStatus: 'blocked', mergeError: result.error });
    } catch (err) {
      get().updatePR(taskId, prNumber, { mergeStatus: 'blocked', mergeError: err instanceof Error ? err.message : 'Merge failed' });
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
          });
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

  updatePR: (taskId, prNumber, updates) => {
    set((state) => ({
      items: state.items.map((item) => {
        if (item.taskId !== taskId) return item;
        const updatedPRs = item.prs.map((pr) =>
          pr.prNumber === prNumber ? { ...pr, ...updates } : pr,
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
