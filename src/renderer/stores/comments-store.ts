import { create } from 'zustand';
import type {
  AgentProviderId,
  CommentAssistKind,
  CommentSuggestion,
  TaskComment,
  TaskCommentCursor,
} from '../../shared/types';

/** Everything the comments panel knows about one task's thread. Keyed by the
 *  task-manager task id, so the Kanban modal and the terminal drawer share one
 *  copy — opening the same task in both costs one fetch, not two. */
export interface CommentThreadState {
  comments: TaskComment[];
  /** The account the API key belongs to — used to mark the user's own comments. */
  me: { id: string; username: string } | null;
  /** Cursor for the next older page, when one exists. */
  older: TaskCommentCursor | null;
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  posting: boolean;
  error: string | null;
  lastLoadedAt: number;
  /** Threaded replies, keyed by the comment they hang off. */
  replies: Record<string, TaskComment[]>;
  repliesLoading: Record<string, boolean>;
}

export interface AssistState {
  running: boolean;
  kind: CommentAssistKind | null;
  suggestions: CommentSuggestion[];
  summary: string | null;
  /** Model output that wasn't JSON — shown as-is rather than thrown away. */
  raw: string | null;
  error: string | null;
}

const EMPTY_THREAD: CommentThreadState = {
  comments: [],
  me: null,
  older: null,
  hasMore: false,
  loading: false,
  loadingOlder: false,
  posting: false,
  error: null,
  lastLoadedAt: 0,
  replies: {},
  repliesLoading: {},
};

const EMPTY_ASSIST: AssistState = {
  running: false,
  kind: null,
  suggestions: [],
  summary: null,
  raw: null,
  error: null,
};

/** A thread read this recent is reused instead of re-fetched, so re-opening the
 *  panel (or opening it in a second surface) doesn't spend ClickUp budget. */
const FRESH_MS = 20_000;

/** At most one read per task in flight; later callers await the same promise. */
const inflight = new Map<string, Promise<void>>();

interface CommentsState {
  threads: Record<string, CommentThreadState>;
  assist: Record<string, AssistState>;

  /** Load the newest page(s) of a thread. `force` ignores the freshness window;
   *  `background` marks it as a poll so it can't outbid a click for API budget. */
  load: (taskId: string, opts?: { force?: boolean; background?: boolean }) => Promise<void>;
  loadOlder: (taskId: string) => Promise<void>;
  loadReplies: (taskId: string, commentId: string, force?: boolean) => Promise<void>;

  /** Post a new top-level comment. Resolves true when ClickUp accepted it. */
  post: (taskId: string, text: string) => Promise<boolean>;
  /** Reply inside an existing comment's thread. */
  postReply: (taskId: string, commentId: string, text: string) => Promise<boolean>;

  runAssist: (
    taskId: string,
    kind: CommentAssistKind,
    opts?: { draft?: string; projectPath?: string; provider?: AgentProviderId; model?: string },
  ) => Promise<void>;
  clearAssist: (taskId: string) => void;
  clearError: (taskId: string) => void;
  /** Drop a task's cached thread (used when a task is unlinked or deleted). */
  reset: (taskId: string) => void;
}

export const useCommentsStore = create<CommentsState>((set, get) => {
  /** Merge a patch into one task's thread without disturbing the others. */
  const patchThread = (taskId: string, patch: Partial<CommentThreadState>) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [taskId]: { ...(state.threads[taskId] || EMPTY_THREAD), ...patch },
      },
    }));

  const patchAssist = (taskId: string, patch: Partial<AssistState>) =>
    set((state) => ({
      assist: {
        ...state.assist,
        [taskId]: { ...(state.assist[taskId] || EMPTY_ASSIST), ...patch },
      },
    }));

  return {
    threads: {},
    assist: {},

    load: async (taskId, opts) => {
      if (!taskId) return;
      const existing = inflight.get(taskId);
      if (existing) return existing;

      const thread = get().threads[taskId];
      const fresh = thread && Date.now() - thread.lastLoadedAt < FRESH_MS;
      if (fresh && !opts?.force) return;

      // A background poll must not blank the thread that is on screen.
      patchThread(taskId, { loading: !opts?.background || !thread, error: null });

      const run = (async () => {
        try {
          const result = await window.electronAPI.getTaskComments(taskId, {
            background: opts?.background,
          });
          if (result?.success && result.data) {
            patchThread(taskId, {
              comments: result.data.comments || [],
              me: result.data.me ?? null,
              older: result.data.older ?? null,
              hasMore: !!result.data.hasMore,
              loading: false,
              error: null,
              lastLoadedAt: Date.now(),
            });
          } else {
            patchThread(taskId, {
              loading: false,
              error: result?.error || 'Failed to load comments',
            });
          }
        } catch (err) {
          patchThread(taskId, {
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load comments',
          });
        } finally {
          inflight.delete(taskId);
        }
      })();

      inflight.set(taskId, run);
      return run;
    },

    loadOlder: async (taskId) => {
      const thread = get().threads[taskId];
      if (!thread?.older || thread.loadingOlder) return;
      patchThread(taskId, { loadingOlder: true, error: null });
      try {
        const result = await window.electronAPI.getTaskComments(taskId, { before: thread.older });
        if (result?.success && result.data) {
          const known = new Set(thread.comments.map((c) => c.id));
          const merged = [
            ...(result.data.comments || []).filter((c: TaskComment) => !known.has(c.id)),
            ...thread.comments,
          ].sort((a, b) => a.createdAtMs - b.createdAtMs);
          patchThread(taskId, {
            comments: merged,
            older: result.data.older ?? null,
            hasMore: !!result.data.hasMore,
            loadingOlder: false,
          });
        } else {
          patchThread(taskId, {
            loadingOlder: false,
            error: result?.error || 'Failed to load older comments',
          });
        }
      } catch (err) {
        patchThread(taskId, {
          loadingOlder: false,
          error: err instanceof Error ? err.message : 'Failed to load older comments',
        });
      }
    },

    loadReplies: async (taskId, commentId, force) => {
      const thread = get().threads[taskId] || EMPTY_THREAD;
      if (thread.repliesLoading[commentId]) return;
      if (thread.replies[commentId] && !force) return;

      patchThread(taskId, {
        repliesLoading: { ...thread.repliesLoading, [commentId]: true },
      });
      try {
        const result = await window.electronAPI.getTaskCommentReplies(commentId);
        const current = get().threads[taskId] || EMPTY_THREAD;
        if (result?.success && Array.isArray(result.data)) {
          patchThread(taskId, {
            replies: { ...current.replies, [commentId]: result.data },
            repliesLoading: { ...current.repliesLoading, [commentId]: false },
          });
        } else {
          patchThread(taskId, {
            repliesLoading: { ...current.repliesLoading, [commentId]: false },
            error: result?.error || 'Failed to load replies',
          });
        }
      } catch (err) {
        const current = get().threads[taskId] || EMPTY_THREAD;
        patchThread(taskId, {
          repliesLoading: { ...current.repliesLoading, [commentId]: false },
          error: err instanceof Error ? err.message : 'Failed to load replies',
        });
      }
    },

    post: async (taskId, text) => {
      const body = text.trim();
      if (!body) return false;
      patchThread(taskId, { posting: true, error: null });
      try {
        const result = await window.electronAPI.postTaskComment(taskId, body);
        if (!result?.success) {
          patchThread(taskId, {
            posting: false,
            error: result?.error || 'Failed to post comment',
          });
          return false;
        }

        // Show the comment immediately from the POST response, then re-read the
        // thread for the authoritative copy. ClickUp can take a moment before a
        // fresh comment shows up in the list, and an empty gap after pressing
        // Post reads as "it didn't work".
        const before = get().threads[taskId] || EMPTY_THREAD;
        const postedId = result.data?.id ? String(result.data.id) : '';
        const echo: TaskComment | null = postedId
          ? {
              id: postedId,
              text: body,
              blocks: [],
              user: {
                id: before.me?.id || '',
                username: before.me?.username || 'You',
              },
              createdAtMs: Number(result.data?.date) || Date.now(),
              replyCount: 0,
            }
          : null;
        patchThread(taskId, {
          posting: false,
          comments: echo ? [...before.comments, echo] : before.comments,
        });

        await get().load(taskId, { force: true });

        // If the re-read raced ahead of ClickUp's own indexing, keep the echo so
        // the comment doesn't vanish until the next poll picks it up.
        if (echo) {
          const after = get().threads[taskId] || EMPTY_THREAD;
          if (!after.comments.some((c) => c.id === echo.id)) {
            patchThread(taskId, {
              comments: [...after.comments, echo].sort((a, b) => a.createdAtMs - b.createdAtMs),
            });
          }
        }
        return true;
      } catch (err) {
        patchThread(taskId, {
          posting: false,
          error: err instanceof Error ? err.message : 'Failed to post comment',
        });
        return false;
      }
    },

    postReply: async (taskId, commentId, text) => {
      const body = text.trim();
      if (!body) return false;
      patchThread(taskId, { posting: true, error: null });
      try {
        const result = await window.electronAPI.postTaskCommentReply(commentId, body, taskId);
        if (!result?.success) {
          patchThread(taskId, {
            posting: false,
            error: result?.error || 'Failed to post reply',
          });
          return false;
        }
        patchThread(taskId, { posting: false });
        await get().loadReplies(taskId, commentId, true);
        await get().load(taskId, { force: true });
        return true;
      } catch (err) {
        patchThread(taskId, {
          posting: false,
          error: err instanceof Error ? err.message : 'Failed to post reply',
        });
        return false;
      }
    },

    runAssist: async (taskId, kind, opts) => {
      if (get().assist[taskId]?.running) return;
      patchAssist(taskId, {
        running: true,
        kind,
        error: null,
        // Keep the other mode's output; replace this one's.
        ...(kind === 'suggest' ? { suggestions: [], raw: null } : { summary: null, raw: null }),
      });
      try {
        const result = await window.electronAPI.taskCommentAssist({
          taskId,
          kind,
          draft: opts?.draft,
          projectPath: opts?.projectPath,
          provider: opts?.provider,
          model: opts?.model,
        });
        if (result?.success && result.data) {
          patchAssist(taskId, {
            running: false,
            kind,
            suggestions: result.data.suggestions || [],
            summary: result.data.summary || null,
            raw: result.data.raw || null,
            error: null,
          });
        } else {
          patchAssist(taskId, {
            running: false,
            error: result?.error || 'The agent could not draft a reply',
          });
        }
      } catch (err) {
        patchAssist(taskId, {
          running: false,
          error: err instanceof Error ? err.message : 'The agent could not draft a reply',
        });
      }
    },

    clearAssist: (taskId) =>
      set((state) => ({ assist: { ...state.assist, [taskId]: { ...EMPTY_ASSIST } } })),

    clearError: (taskId) => patchThread(taskId, { error: null }),

    reset: (taskId) =>
      set((state) => {
        const threads = { ...state.threads };
        const assist = { ...state.assist };
        delete threads[taskId];
        delete assist[taskId];
        return { threads, assist };
      }),
  };
});
