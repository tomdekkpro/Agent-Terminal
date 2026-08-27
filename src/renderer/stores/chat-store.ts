import { create } from 'zustand';
import type {
  AgentProviderId,
  ChatAssistKind,
  ChatAssistResult,
  ChatChannel,
  ChatLanguage,
  ChatMessage,
  ChatPendingAttachment,
  ChatSuggestion,
  ChatUploadedFile,
  ChatUser,
} from '../../shared/types';

/** Where a conversation can be on screen: the full Chat page, or the dock that
 *  rides along beside every other page. */
export type ChatSurface = 'page' | 'dock';

/** Everything the page knows about one Channel's messages. Kept per channel so
 *  switching back to a conversation is instant and doesn't re-fetch. */
export interface ConversationState {
  messages: ChatMessage[];
  /** Cursor for the next older page, when one exists. */
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  sending: boolean;
  error: string | null;
  loadedAt: number;
}

export interface ThreadState {
  messages: ChatMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
}

/** One AI request at a time — the assist panel is a single surface, and two
 *  concurrent CLI runs would just fight for the same terminal budget. */
export interface ChatAssistState {
  running: boolean;
  kind: ChatAssistKind | null;
  suggestions: ChatSuggestion[];
  /** Markdown answer for summarize / explain / action-items. */
  summary: string | null;
  /** Single body for translate / rewrite, ready to drop into the composer. */
  text: string | null;
  raw: string | null;
  error: string | null;
  /** The excerpt the request was about, echoed back so the panel can show it. */
  selection: string | null;
}

const EMPTY_CONVO: ConversationState = {
  messages: [],
  cursor: null,
  hasMore: false,
  loading: false,
  loadingOlder: false,
  sending: false,
  error: null,
  loadedAt: 0,
};

const EMPTY_THREAD: ThreadState = { messages: [], loading: false, sending: false, error: null };

const EMPTY_ASSIST: ChatAssistState = {
  running: false,
  kind: null,
  suggestions: [],
  summary: null,
  text: null,
  raw: null,
  error: null,
  selection: null,
};

/** A conversation read this recently is reused instead of re-fetched, so
 *  clicking back and forth between two Channels costs nothing. */
const FRESH_MS = 10_000;

/** At most one read per channel in flight; later callers await the same one. */
const inflight = new Map<string, Promise<void>>();

/** Optimistic messages get a client id so the real one can replace them. */
let pendingSeq = 0;

/** The upload currently in flight per channel, so the user can cancel it.
 *  Deliberately outside the store: it is a handle for aborting, not state
 *  anything renders. */
const uploadIds = new Map<string, string>();

/**
 * Unread is tracked here, not by ClickUp.
 *
 * The Chat API documents a per-account `counts.has_unread` on each Channel,
 * but it comes back null for personal API tokens, and there is no endpoint to
 * mark a Channel read. So the page remembers when the user last looked at each
 * conversation and compares that against the Channel's newest message.
 */
const SEEN_STORAGE_KEY = 'chat-last-seen';
/** Muted conversations. Local, because ClickUp exposes no mute API — and a
 *  mute is a personal preference about noise, not shared workspace state. */
const MUTED_STORAGE_KEY = 'chat-muted';

function loadMuted(): Record<string, true> {
  try {
    const raw = localStorage.getItem(MUTED_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistMuted(muted: Record<string, true>): void {
  try {
    localStorage.setItem(MUTED_STORAGE_KEY, JSON.stringify(muted));
  } catch {
    // Preference only — losing it is not worth failing over.
  }
}

/**
 * A person picked from the composer's @ autocomplete.
 *
 * The composer is a plain textarea, so the draft holds the readable `@Name`
 * and the id is remembered here. On send, each remembered name is rewritten to
 * ClickUp's wire form — `[@Name](#user_mention#<id>)` — which is exactly what
 * its own client emits and what it resolves back into a real mention.
 */
export interface PendingMention {
  /** Literally what sits in the draft, including the leading @. */
  display: string;
  userId: string;
}

/** Escape a display name so it can go into a RegExp alternation verbatim. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite remembered @names into ClickUp's mention markup.
 *
 * One pass, not one pass per name. Replacing them one at a time corrupts
 * overlapping names: with "@Tom" and "@Tom Hansen" both registered, rewriting
 * "@Tom Hansen" first produces `[@Tom Hansen](...)`, and the next pass then
 * matches the "@Tom" *inside* that markup. A single global replace never
 * rescans what it just emitted, and ordering the alternation longest-first
 * makes the regex prefer the fuller name at each position.
 */
export function applyMentions(text: string, mentions: PendingMention[]): string {
  if (mentions.length === 0) return text;

  const byDisplay = new Map<string, string>();
  for (const mention of mentions) {
    if (!byDisplay.has(mention.display)) byDisplay.set(mention.display, mention.userId);
  }

  const displays = [...byDisplay.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(displays.map(escapeForRegExp).join('|'), 'g');
  return text.replace(pattern, (match) => `[${match}](#user_mention#${byDisplay.get(match)})`);
}

function loadSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function persistSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // Private mode or a full quota — unread badges degrade, nothing breaks.
  }
}

/** The dock's open/closed state outlives a reload — it is a workspace layout
 *  choice, not transient UI state. */
const DOCK_STORAGE_KEY = 'chat-dock-open';

function loadDockOpen(): boolean {
  try {
    return localStorage.getItem(DOCK_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Newest messages whose reactions are worth pre-loading. ClickUp returns no
 *  reaction data with the message list, so each one costs a request. */
const REACTION_PREFETCH = 12;

/**
 * What the sidebar shows for a conversation with something new in it.
 *
 * The channel list carries a timestamp but not the newest message, so "who
 * just messaged me" costs one read per changed conversation. That is only
 * affordable because it is scoped to conversations whose timestamp actually
 * moved since the last check — usually none, sometimes one or two.
 */
export interface ChannelUnread {
  /** Messages newer than the last visit, excluding the user's own. */
  count: number;
  /** Who wrote the newest of them. */
  sender: ChatUser | null;
  /** One-line preview of that message. */
  preview: string;
  atMs: number;
}

/** Conversations whose newest message is read per pass. The sidebar sorts by
 *  recency, so this covers everything a person could plausibly care about. */
const UNREAD_SCAN_LIMIT = 15;
/** Messages read per conversation when counting unread. Past this the count is
 *  shown as "9+" anyway, so a bigger page would buy nothing. */
const UNREAD_PAGE = 20;

/** Flatten a message body into something that fits on one sidebar line. */
function previewOf(content: string): string {
  return (content || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '🖼 image')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * DMs arrive from ClickUp with no name — the main process resolves them from
 * each conversation's member list, which takes a few seconds for a workspace
 * with dozens of them. These re-reads pick the names up as they land.
 *
 * They cost nothing: inside the main process's channel-list cache window a
 * re-read issues no request at all, it just re-overlays the names resolved so
 * far. Without them the sidebar would say "Direct message" until the next poll.
 */
const NAME_SETTLE_DELAYS_MS = [1_500, 3_500, 6_000, 10_000];

interface ChatState {
  // Bootstrap
  me: ChatUser | null;
  people: ChatUser[];
  ready: boolean;
  bootstrapError: string | null;

  // Channels
  channels: ChatChannel[];
  channelsLoading: boolean;
  channelsError: string | null;
  /** false = only Channels this account follows (the default). */
  showAll: boolean;

  activeChannelId: string | null;
  /** Which surfaces are currently showing the transcript. The open conversation
   *  is exempt from unread counting because the user is looking at it — but
   *  only while some surface actually is. Two surfaces can show it (the full
   *  page and the dock), so one closing must not cancel the other. */
  viewing: Record<ChatSurface, boolean>;
  /** Is the right-hand dock open? Persisted across restarts. */
  dockOpen: boolean;
  conversations: Record<string, ConversationState>;
  /** Composer text per channel, so switching away doesn't lose a draft. */
  drafts: Record<string, string>;
  /** People picked from the composer's @ autocomplete, per channel. */
  mentions: Record<string, PendingMention[]>;
  /** Conversations excluded from unread counts and badges. Persisted. */
  muted: Record<string, true>;
  /** Files staged in the composer, per channel — pasted, dropped or picked,
   *  not yet uploaded. */
  attachments: Record<string, ChatPendingAttachment[]>;
  /** Per-channel upload progress, so the composer can show what is happening
   *  and offer a way out of it. */
  uploading: Record<string, { fileName: string; index: number; total: number } | undefined>;

  /** Message whose reply thread is open in the right-hand panel. */
  activeThreadId: string | null;
  threads: Record<string, ThreadState>;

  assist: ChatAssistState;
  /** Text the user highlighted in the transcript, for the AI actions. */
  selection: string | null;
  /** Image open in the full-screen viewer, if any. */
  lightbox: { src: string; alt?: string } | null;

  /** When the user last looked at each conversation. Persisted, because
   *  ClickUp exposes no read state of its own — see loadSeen above. */
  lastSeenAt: Record<string, number>;
  /** True once the first channel list has been reconciled against lastSeenAt,
   *  so a fresh install doesn't open with everything marked unread. */
  seenSeeded: boolean;

  /** When each workspace member was last active in ClickUp, keyed by user id.
   *  Drives the presence dots — see getPresence in the main process. */
  presence: Record<string, number>;

  /** Per-conversation unread summary for the sidebar. */
  unread: Record<string, ChannelUnread>;
  /** `lastSeenAt` as it was when the conversation was opened, so the transcript
   *  can draw a "new messages" line where reading left off — the live value is
   *  bumped to now the moment the conversation is shown. */
  openedSeenAt: Record<string, number>;
  /** The `latestCommentAtMs` each conversation's unread summary was built from,
   *  so an unchanged conversation is never re-read. */
  unreadBuiltFor: Record<string, number>;

  bootstrap: () => Promise<void>;
  loadChannels: (opts?: { force?: boolean; background?: boolean }) => Promise<void>;
  setShowAll: (showAll: boolean) => void;
  setViewing: (surface: ChatSurface, viewing: boolean) => void;
  setDockOpen: (open: boolean) => void;
  toggleDock: () => void;

  selectChannel: (channelId: string | null) => Promise<void>;
  loadMessages: (channelId: string, opts?: { force?: boolean; background?: boolean }) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  send: (channelId: string, text: string) => Promise<boolean>;

  /** Reactions for a set of messages, merged into the open conversation. */
  loadReactions: (messageIds: string[], opts?: { force?: boolean }) => Promise<void>;

  /** Refresh who is around. Cheap and cached in the main process. */
  loadPresence: () => Promise<void>;
  /** Build the sidebar's unread summaries for conversations that changed. */
  refreshUnread: () => Promise<void>;
  /** Drop a conversation's unread state — it has been read. */
  markRead: (channelId: string) => void;
  /** Clear every unread marker at once, for digging out of a backlog. */
  markAllRead: () => void;

  openThread: (messageId: string) => Promise<void>;
  closeThread: () => void;
  sendThreadReply: (messageId: string, text: string) => Promise<boolean>;

  startDm: (userIds: string[]) => Promise<string | null>;
  toggleReaction: (messageId: string, reaction: string) => Promise<void>;

  setDraft: (channelId: string, text: string) => void;
  /** Remember that this @name in the draft refers to this person. */
  addMention: (channelId: string, mention: PendingMention) => void;
  /** Silence a conversation, or bring it back. */
  toggleMute: (channelId: string) => void;
  /** Stage files on a channel's composer. Duplicates are allowed — the same
   *  screenshot twice is a legitimate thing to want. */
  addAttachments: (channelId: string, files: ChatPendingAttachment[]) => void;
  removeAttachment: (channelId: string, id: string) => void;
  /** Abort the upload in flight for this channel; the files stay staged. */
  cancelUpload: (channelId: string) => void;
  setSelection: (text: string | null) => void;
  openLightbox: (src: string, alt?: string) => void;
  closeLightbox: () => void;

  runAssist: (
    kind: ChatAssistKind,
    opts?: {
      selection?: string;
      draft?: string;
      language?: ChatLanguage;
      tone?: 'polite' | 'shorter' | 'direct' | 'formal';
      projectPath?: string;
      provider?: AgentProviderId;
      model?: string;
    },
  ) => Promise<void>;
  clearAssist: () => void;
  clearError: (channelId?: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => {
  const patchConvo = (channelId: string, patch: Partial<ConversationState>) =>
    set((state) => ({
      conversations: {
        ...state.conversations,
        [channelId]: { ...(state.conversations[channelId] || EMPTY_CONVO), ...patch },
      },
    }));

  const patchThread = (messageId: string, patch: Partial<ThreadState>) =>
    set((state) => ({
      threads: {
        ...state.threads,
        [messageId]: { ...(state.threads[messageId] || EMPTY_THREAD), ...patch },
      },
    }));

  /** Re-read the channel list a few times while DM names settle. Idempotent:
   *  a second call while one is already scheduled does nothing. */
  let nameSettleTimers: ReturnType<typeof setTimeout>[] = [];
  const scheduleNameSettle = () => {
    for (const timer of nameSettleTimers) clearTimeout(timer);
    nameSettleTimers = NAME_SETTLE_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        const { channels } = get();
        // Everything has a name now — stop asking.
        if (!channels.some((c) => c.kind !== 'CHANNEL' && !c.name)) return;
        void get().loadChannels({ background: true });
      }, delay),
    );
  };

  /** Merge a freshly-fetched page into what's already on screen, keeping one
   *  copy of each message and dropping any optimistic stand-in it replaces. */
  const mergeMessages = (existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] => {
    const byId = new Map<string, ChatMessage>();
    for (const message of existing) {
      // Optimistic entries are keyed by a client id the server never returns.
      if (message.id.startsWith('pending:')) {
        const superseded = incoming.some(
          (m) => m.content.trim() === message.content.trim() && Math.abs(m.createdAtMs - message.createdAtMs) < 120_000,
        );
        if (superseded) continue;
      }
      byId.set(message.id, message);
    }
    for (const message of incoming) {
      // ClickUp never returns reactions with the message list, so a poll would
      // otherwise wipe the counts that were loaded separately.
      const previous = byId.get(message.id);
      byId.set(
        message.id,
        previous?.reactions !== undefined && message.reactions === undefined
          ? { ...message, reactions: previous.reactions }
          : message,
      );
    }
    return [...byId.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  };

  return {
    me: null,
    people: [],
    ready: false,
    bootstrapError: null,

    channels: [],
    channelsLoading: false,
    channelsError: null,
    showAll: false,

    activeChannelId: null,
    viewing: { page: false, dock: false },
    dockOpen: loadDockOpen(),
    conversations: {},
    drafts: {},
    mentions: {},
    muted: loadMuted(),
    attachments: {},
    uploading: {},

    activeThreadId: null,
    threads: {},

    assist: EMPTY_ASSIST,
    selection: null,
    lightbox: null,
    lastSeenAt: loadSeen(),
    seenSeeded: false,
    presence: {},
    unread: {},
    openedSeenAt: {},
    unreadBuiltFor: {},

    bootstrap: async () => {
      if (get().ready) return;
      const result = await window.electronAPI.chatMe();
      if (!result?.success) {
        set({ bootstrapError: result?.error || 'Could not reach ClickUp Chat', ready: true });
        return;
      }
      set({ me: result.data.me, people: result.data.people || [], ready: true, bootstrapError: null });
      await get().loadChannels();
    },

    loadChannels: async (opts) => {
      const { showAll } = get();
      if (!opts?.background) set({ channelsLoading: true, channelsError: null });
      const result = await window.electronAPI.chatGetChannels({
        followingOnly: !showAll,
        background: opts?.background,
        force: opts?.force,
      });
      if (!result?.success) {
        set({ channelsLoading: false, channelsError: result?.error || 'Failed to load channels' });
        return;
      }
      // DMs whose names are still resolving in the main process — come back
      // for them shortly rather than leaving the sidebar unlabelled.
      if (!opts?.background && result.data.some((c: ChatChannel) => c.kind !== 'CHANNEL' && !c.name)) {
        scheduleNameSettle();
      }

      // First list of the session on a machine that has never run Chat: treat
      // everything as already read. Opening the page to 70 unread badges is
      // noise, not information.
      const { seenSeeded, lastSeenAt } = get();
      if (!seenSeeded) {
        const seeded = { ...lastSeenAt };
        let changed = false;
        for (const channel of result.data) {
          if (seeded[channel.id] === undefined) {
            seeded[channel.id] = channel.latestCommentAtMs || Date.now();
            changed = true;
          }
        }
        if (changed) persistSeen(seeded);
        set({ channels: result.data, channelsLoading: false, channelsError: null, lastSeenAt: seeded, seenSeeded: true });
        return;
      }

      set({ channels: result.data, channelsLoading: false, channelsError: null });
      void get().refreshUnread();
      void get().loadPresence();
    },

    setViewing: (surface, viewing) =>
      set((state) => ({ viewing: { ...state.viewing, [surface]: viewing } })),

    setDockOpen: (open) => {
      try {
        localStorage.setItem(DOCK_STORAGE_KEY, open ? '1' : '0');
      } catch {
        // Layout preference only — losing it is not worth failing over.
      }
      set({ dockOpen: open });
    },

    toggleDock: () => get().setDockOpen(!get().dockOpen),

    setShowAll: (showAll) => {
      set({ showAll });
      void get().loadChannels({ force: true });
    },

    selectChannel: async (channelId) => {
      set((state) => {
        if (!channelId) {
          return { activeChannelId: null, activeThreadId: null, selection: null, assist: EMPTY_ASSIST };
        }
        const previousSeen = state.lastSeenAt[channelId];
        const lastSeenAt = { ...state.lastSeenAt, [channelId]: Date.now() };
        persistSeen(lastSeenAt);
        const { [channelId]: _read, ...unread } = state.unread;
        return {
          activeChannelId: channelId,
          activeThreadId: null,
          selection: null,
          assist: EMPTY_ASSIST,
          lastSeenAt,
          // Captured before the bump above, so the transcript can mark where
          // this visit's new messages begin.
          openedSeenAt: { ...state.openedSeenAt, [channelId]: previousSeen ?? Date.now() },
          unread,
        };
      });
      if (channelId) await get().loadMessages(channelId);
    },

    loadMessages: async (channelId, opts) => {
      if (!channelId) return;
      const existing = inflight.get(channelId);
      if (existing) return existing;

      const convo = get().conversations[channelId];
      if (!opts?.force && convo && Date.now() - convo.loadedAt < FRESH_MS) return;

      const run = (async () => {
        // A poll must not blank the transcript the user is reading.
        if (!opts?.background) patchConvo(channelId, { loading: !convo?.messages.length, error: null });
        const result = await window.electronAPI.chatGetMessages(channelId, {
          background: opts?.background,
        });
        if (!result?.success) {
          patchConvo(channelId, { loading: false, error: result?.error || 'Failed to load messages' });
          return;
        }
        const current = get().conversations[channelId] || EMPTY_CONVO;
        const merged = mergeMessages(current.messages, result.data.messages);
        patchConvo(channelId, {
          messages: merged,
          // Only the first (newest) page owns the "older" cursor; a poll must
          // not overwrite a cursor the user already paged past.
          cursor: current.messages.length === 0 ? result.data.cursor : current.cursor,
          hasMore: current.messages.length === 0 ? result.data.hasMore : current.hasMore,
          loading: false,
          error: null,
          loadedAt: Date.now(),
        });

        // Reading a conversation is what marks it read.
        if (get().activeChannelId === channelId) {
          const lastSeenAt = { ...get().lastSeenAt, [channelId]: Date.now() };
          persistSeen(lastSeenAt);
          set({ lastSeenAt });
        }

        // Reactions come one request per message, so only the newest few, and
        // only for messages we haven't already resolved.
        const needReactions = merged
          .slice(-REACTION_PREFETCH)
          .filter((m) => m.reactions === undefined && !m.id.startsWith('pending:'))
          .map((m) => m.id);
        if (needReactions.length > 0) void get().loadReactions(needReactions);
      })().finally(() => inflight.delete(channelId));

      inflight.set(channelId, run);
      return run;
    },

    loadOlder: async (channelId) => {
      const convo = get().conversations[channelId];
      if (!convo || !convo.cursor || convo.loadingOlder) return;
      patchConvo(channelId, { loadingOlder: true });
      const result = await window.electronAPI.chatGetMessages(channelId, { cursor: convo.cursor });
      if (!result?.success) {
        patchConvo(channelId, { loadingOlder: false, error: result?.error || 'Failed to load older messages' });
        return;
      }
      const current = get().conversations[channelId] || EMPTY_CONVO;
      patchConvo(channelId, {
        messages: mergeMessages(current.messages, result.data.messages),
        cursor: result.data.cursor,
        hasMore: result.data.hasMore,
        loadingOlder: false,
      });
    },

    send: async (channelId, text) => {
      const body = (text || '').trim();
      const staged = get().attachments[channelId] || [];
      if ((!body && staged.length === 0) || !channelId) return false;
      const me = get().me;

      // Files first: a message that references an upload must not be posted
      // before the upload succeeds, or it links to nothing.
      let attachmentMarkdown = '';
      if (staged.length > 0) {
        const uploaded: ChatUploadedFile[] = [];
        for (let i = 0; i < staged.length; i++) {
          const file = staged[i];
          const uploadId = `${channelId}:${file.id}:${Date.now()}`;
          uploadIds.set(channelId, uploadId);
          set((state) => ({
            uploading: {
              ...state.uploading,
              [channelId]: { fileName: file.name, index: i + 1, total: staged.length },
            },
          }));

          const result = await window.electronAPI.chatUploadFile(
            { name: file.name, mime: file.mime, data: file.data },
            uploadId,
          );
          uploadIds.delete(channelId);

          if (!result?.success) {
            set((state) => ({ uploading: { ...state.uploading, [channelId]: undefined } }));
            patchConvo(channelId, { error: result?.error || `Failed to upload ${file.name}` });
            // Everything stays staged, so the send can be retried as-is.
            return false;
          }
          uploaded.push(result.data);
        }
        set((state) => ({ uploading: { ...state.uploading, [channelId]: undefined } }));
        attachmentMarkdown = uploaded
          .map((f) => (f.isImage ? `![${f.name}](${f.url})` : `[📎 ${f.name}](${f.url})`))
          .join('\n');
      }

      // @names picked from the autocomplete become real mentions on the wire.
      const mentioned = applyMentions(body, get().mentions[channelId] || []);
      const content = [mentioned, attachmentMarkdown].filter(Boolean).join('\n\n');

      // Optimistic: the message appears the instant Enter is pressed, and is
      // replaced (or removed on failure) once ClickUp answers.
      const pendingId = `pending:${++pendingSeq}`;
      const optimistic: ChatMessage = {
        id: pendingId,
        channelId,
        content,
        user: me || { id: '', username: 'Me' },
        createdAtMs: Date.now(),
        replyCount: 0,
      };
      const before = get().conversations[channelId] || EMPTY_CONVO;
      patchConvo(channelId, { messages: [...before.messages, optimistic], sending: true, error: null });
      set((state) => ({
        drafts: { ...state.drafts, [channelId]: '' },
        attachments: { ...state.attachments, [channelId]: [] },
        mentions: { ...state.mentions, [channelId]: [] },
      }));

      const result = await window.electronAPI.chatSendMessage(channelId, content);
      const current = get().conversations[channelId] || EMPTY_CONVO;

      if (!result?.success) {
        patchConvo(channelId, {
          messages: current.messages.filter((m) => m.id !== pendingId),
          sending: false,
          error: result?.error || 'Failed to send',
        });
        // Give the text back rather than losing what they typed. The files are
        // already uploaded, so their links go back into the draft.
        set((state) => ({ drafts: { ...state.drafts, [channelId]: content } }));
        return false;
      }

      patchConvo(channelId, {
        messages: mergeMessages(
          current.messages.filter((m) => m.id !== pendingId),
          [{ ...result.data, channelId }],
        ),
        sending: false,
      });
      void get().loadChannels({ force: true, background: true });
      return true;
    },

    loadReactions: async (messageIds, opts) => {
      const ids = [...new Set(messageIds.filter(Boolean))];
      if (ids.length === 0) return;
      const result = await window.electronAPI.chatGetReactions(ids, {
        background: true,
        force: opts?.force,
      });
      if (!result?.success) return;

      // Merge into whichever conversation the messages belong to. An empty
      // array is a real answer ("no reactions") and must be stored, or the
      // prefetch would ask again on every poll.
      const map: Record<string, ChatMessage['reactions']> = result.data;
      set((state) => {
        const conversations = { ...state.conversations };
        let touched = false;
        for (const [channelId, convo] of Object.entries(conversations)) {
          if (!convo.messages.some((m) => map[m.id] !== undefined)) continue;
          conversations[channelId] = {
            ...convo,
            messages: convo.messages.map((m) =>
              map[m.id] !== undefined ? { ...m, reactions: map[m.id] || [] } : m,
            ),
          };
          touched = true;
        }
        return touched ? { conversations } : {};
      });
    },

    loadPresence: async () => {
      const result = await window.electronAPI.chatGetPresence();
      if (result?.success) set({ presence: result.data });
    },

    refreshUnread: async () => {
      const { channels, lastSeenAt, activeChannelId, viewing, me, unreadBuiltFor, muted } = get();
      // Only skip the open conversation while some surface is actually showing it.
      const reading = viewing.page || viewing.dock ? activeChannelId : null;

      // Only conversations whose newest message moved past the last visit, and
      // only if that exact timestamp hasn't already been accounted for. On a
      // quiet poll this list is empty and the whole pass costs nothing.
      const candidates = channels
        .filter((c) => {
          // Muted conversations are skipped entirely — not counted, and not
          // even read, so silencing one also stops it costing requests.
          if (c.id === reading || c.archived || muted[c.id]) return false;
          const newest = c.latestCommentAtMs || 0;
          if (!newest) return false;
          const seen = lastSeenAt[c.id];
          if (seen === undefined || newest <= seen) return false;
          return unreadBuiltFor[c.id] !== newest;
        })
        .sort((a, b) => (b.latestCommentAtMs || 0) - (a.latestCommentAtMs || 0))
        .slice(0, UNREAD_SCAN_LIMIT);

      if (candidates.length === 0) return;

      for (const channel of candidates) {
        const result = await window.electronAPI.chatGetMessages(channel.id, {
          limit: UNREAD_PAGE,
          background: true,
        });
        if (!result?.success) continue;

        const seen = get().lastSeenAt[channel.id] ?? 0;
        // The user's own messages move the channel timestamp but are not news.
        const fresh = (result.data.messages as ChatMessage[])
          .filter((m) => m.createdAtMs > seen && (!me || m.user.id !== me.id));
        const newest = fresh[fresh.length - 1];

        set((state) => {
          const unreadBuilt = { ...state.unreadBuiltFor, [channel.id]: channel.latestCommentAtMs || 0 };
          if (!newest) {
            // Nothing but the user's own messages — quietly catch the marker up
            // so this conversation stops being re-read on every poll.
            const lastSeen = { ...state.lastSeenAt, [channel.id]: channel.latestCommentAtMs || Date.now() };
            persistSeen(lastSeen);
            const { [channel.id]: _none, ...rest } = state.unread;
            return { unread: rest, lastSeenAt: lastSeen, unreadBuiltFor: unreadBuilt };
          }
          return {
            unread: {
              ...state.unread,
              [channel.id]: {
                count: fresh.length,
                sender: newest.user,
                preview: previewOf(newest.content),
                atMs: newest.createdAtMs,
              },
            },
            unreadBuiltFor: unreadBuilt,
          };
        });
      }
    },

    markRead: (channelId) => {
      set((state) => {
        const channel = state.channels.find((c) => c.id === channelId);
        const lastSeenAt = {
          ...state.lastSeenAt,
          [channelId]: Math.max(Date.now(), channel?.latestCommentAtMs || 0),
        };
        persistSeen(lastSeenAt);
        const { [channelId]: _read, ...unread } = state.unread;
        return { lastSeenAt, unread };
      });
    },

    markAllRead: () => {
      set((state) => {
        const now = Date.now();
        const lastSeenAt = { ...state.lastSeenAt };
        for (const channel of state.channels) {
          lastSeenAt[channel.id] = Math.max(now, channel.latestCommentAtMs || 0);
        }
        persistSeen(lastSeenAt);
        return { lastSeenAt, unread: {} };
      });
    },

    openThread: async (messageId) => {
      set({ activeThreadId: messageId });
      patchThread(messageId, { loading: true, error: null });
      const result = await window.electronAPI.chatGetReplies(messageId);
      if (!result?.success) {
        patchThread(messageId, { loading: false, error: result?.error || 'Failed to load the thread' });
        return;
      }
      patchThread(messageId, { messages: result.data.messages, loading: false, error: null });
    },

    closeThread: () => set({ activeThreadId: null }),

    sendThreadReply: async (messageId, text) => {
      const body = (text || '').trim();
      if (!body) return false;
      patchThread(messageId, { sending: true, error: null });
      const result = await window.electronAPI.chatSendReply(messageId, body);
      if (!result?.success) {
        patchThread(messageId, { sending: false, error: result?.error || 'Failed to reply' });
        return false;
      }
      const thread = get().threads[messageId] || EMPTY_THREAD;
      patchThread(messageId, { messages: [...thread.messages, result.data], sending: false });

      // Bump the parent's reply count so the transcript matches the thread.
      const { activeChannelId, conversations } = get();
      if (activeChannelId) {
        const convo = conversations[activeChannelId];
        if (convo) {
          patchConvo(activeChannelId, {
            messages: convo.messages.map((m) =>
              m.id === messageId ? { ...m, replyCount: m.replyCount + 1 } : m,
            ),
          });
        }
      }
      return true;
    },

    startDm: async (userIds) => {
      const result = await window.electronAPI.chatCreateDm(userIds);
      if (!result?.success) {
        set({ channelsError: result?.error || 'Failed to open a direct message' });
        return null;
      }
      const channel: ChatChannel = result.data;
      set((state) => ({
        channels: state.channels.some((c) => c.id === channel.id)
          ? state.channels.map((c) => (c.id === channel.id ? { ...c, ...channel } : c))
          : [channel, ...state.channels],
        channelsError: null,
      }));
      await get().selectChannel(channel.id);
      return channel.id;
    },

    toggleReaction: async (messageId, reaction) => {
      const { activeChannelId, conversations } = get();
      if (!activeChannelId) return;
      const convo = conversations[activeChannelId];
      const message = convo?.messages.find((m) => m.id === messageId);
      if (!message) return;

      const before = message.reactions;
      const existing = (before || []).find((r) => r.reaction === reaction);
      const mine = !!existing?.mine;

      // Optimistic — a reaction that lags behind the click feels broken. The
      // authoritative counts are re-read below, so a wrong guess self-corrects.
      const optimistic = mine
        ? (before || [])
            .map((r) => (r.reaction === reaction ? { ...r, count: r.count - 1, mine: false } : r))
            .filter((r) => r.count > 0)
        : existing
          ? (before || []).map((r) =>
              r.reaction === reaction ? { ...r, count: r.count + 1, mine: true } : r,
            )
          : [...(before || []), { reaction, count: 1, mine: true }];

      patchConvo(activeChannelId, {
        messages: convo.messages.map((m) => (m.id === messageId ? { ...m, reactions: optimistic } : m)),
      });

      const result = mine
        ? await window.electronAPI.chatUnreact(messageId, reaction)
        : await window.electronAPI.chatReact(messageId, reaction);

      if (!result?.success) {
        // Put it back the way it was and say why.
        const now = get().conversations[activeChannelId];
        if (now) {
          patchConvo(activeChannelId, {
            messages: now.messages.map((m) => (m.id === messageId ? { ...m, reactions: before } : m)),
            error: result?.error || 'Reaction failed',
          });
        }
        return;
      }

      // Re-read the one message so the counts include everyone else's clicks,
      // not just this one.
      await get().loadReactions([messageId], { force: true });
    },

    setDraft: (channelId, text) =>
      set((state) => ({ drafts: { ...state.drafts, [channelId]: text } })),

    addMention: (channelId, mention) =>
      set((state) => {
        const current = state.mentions[channelId] || [];
        if (current.some((m) => m.display === mention.display && m.userId === mention.userId)) {
          return {};
        }
        return { mentions: { ...state.mentions, [channelId]: [...current, mention] } };
      }),

    toggleMute: (channelId) =>
      set((state) => {
        const muted = { ...state.muted };
        if (muted[channelId]) delete muted[channelId];
        else muted[channelId] = true;
        persistMuted(muted);
        // A newly muted conversation should stop contributing to badges at once.
        const unread = { ...state.unread };
        if (muted[channelId]) delete unread[channelId];
        return { muted, unread };
      }),

    addAttachments: (channelId, files) =>
      set((state) => ({
        attachments: {
          ...state.attachments,
          [channelId]: [...(state.attachments[channelId] || []), ...files],
        },
      })),

    cancelUpload: (channelId) => {
      const uploadId = uploadIds.get(channelId);
      if (!uploadId) return;
      void window.electronAPI.chatCancelUpload(uploadId);
      // The in-flight call rejects on its own and clears the progress state;
      // this only asks the main process to stop.
    },

    removeAttachment: (channelId, id) =>
      set((state) => ({
        attachments: {
          ...state.attachments,
          [channelId]: (state.attachments[channelId] || []).filter((a) => a.id !== id),
        },
      })),

    setSelection: (text) => set({ selection: text && text.trim() ? text.trim() : null }),

    openLightbox: (src, alt) => set({ lightbox: { src, alt } }),
    closeLightbox: () => set({ lightbox: null }),

    runAssist: async (kind, opts) => {
      const { activeChannelId, channels, conversations, drafts } = get();
      if (!activeChannelId) return;
      const channel = channels.find((c) => c.id === activeChannelId);
      const convo = conversations[activeChannelId];
      if (!channel || !convo) return;

      const selection = opts?.selection ?? get().selection ?? undefined;
      set({
        assist: {
          ...EMPTY_ASSIST,
          running: true,
          kind,
          selection: selection || null,
        },
      });

      const result = await window.electronAPI.chatAssist({
        kind,
        channel: { name: channel.name || 'Direct message', kind: channel.kind, topic: channel.topic },
        // Drop optimistic stand-ins — they have no server identity and would
        // just duplicate text the real message already carries.
        messages: convo.messages.filter((m) => !m.id.startsWith('pending:')),
        selection,
        draft: opts?.draft ?? drafts[activeChannelId] ?? undefined,
        language: opts?.language,
        tone: opts?.tone,
        projectPath: opts?.projectPath,
        provider: opts?.provider,
        model: opts?.model,
      });

      if (!result?.success) {
        set((state) => ({
          assist: { ...state.assist, running: false, error: result?.error || 'The AI request failed' },
        }));
        return;
      }

      const data: ChatAssistResult = result.data;
      set((state) => ({
        assist: {
          ...state.assist,
          running: false,
          kind: data.kind,
          suggestions: data.suggestions || [],
          summary: data.summary || null,
          text: data.text || null,
          raw: data.raw || null,
          error: null,
        },
      }));
    },

    clearAssist: () => set({ assist: EMPTY_ASSIST }),

    clearError: (channelId) => {
      set({ channelsError: null });
      if (channelId) patchConvo(channelId, { error: null });
    },
  };
});

export { EMPTY_CONVO, EMPTY_THREAD, EMPTY_ASSIST };
