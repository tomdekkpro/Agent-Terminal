/**
 * ClickUp Chat (public API v3).
 *
 * Chat lives on a different API version than tasks, but on the SAME token
 * budget — so every request here goes through `clickUpFetch` from the v2
 * provider, which owns the rate limiter, the 429 backoff and the API log.
 * Endpoints starting `/v3/` are routed to the v3 base there.
 *
 * Everything ClickUp hands back is normalized into the `Chat*` shapes in
 * shared/types, because the renderer should never have to know that a DM has
 * no name, that messages arrive newest-first, or that a message carries a
 * `user_id` instead of a user.
 */
import type {
  AppSettings,
  ChatChannel,
  ChatMessage,
  ChatMessagePage,
  ChatUploadedFile,
  ChatUser,
} from '../../../shared/types';
import type { ProviderResult, WorkspaceMember } from './types';
import { clickUpFetch } from './clickup';
import { ClickUpProvider } from './clickup';
import { debugError, debugLog } from '../../../shared/utils';

const provider = new ClickUpProvider();

/** Channels are re-read on every sidebar poll; this keeps two surfaces asking
 *  at once from costing two page-throughs. */
const CHANNELS_TTL = 20_000;
/** Who is in a DM never changes, so the resolved member list is worth holding
 *  for the whole session rather than re-fetching per sidebar render. */
const MEMBERS_TTL = 30 * 60_000;
/** Pages of 100 — enough for any realistic workspace without unbounded paging. */
const CHANNEL_PAGE_LIMIT = 100;
const MAX_CHANNEL_PAGES = 10;
const DEFAULT_MESSAGE_LIMIT = 50;
/** DM member lookups fired at once while naming the sidebar. Bounded by the
 *  provider's own MAX_CONCURRENT (8) and run on the background lane, so a user
 *  click still jumps the queue — but high enough that a workspace with 40 DMs
 *  gets its sidebar named in ~4s rather than ~10s. */
const DM_RESOLVE_CONCURRENCY = 6;
/** DMs named per pass, newest conversation first. Anything past this is named
 *  by the next uncached channel load: already-resolved DMs are filtered out, so
 *  each pass picks up where the last left off and the list self-completes. */
const DM_RESOLVE_BATCH = 24;

const cache = new Map<string, { data: any; at: number }>();

function cacheGet<T>(key: string, ttl: number): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.data as T;
}

function cacheSet(key: string, data: any): void {
  cache.set(key, { data, at: Date.now() });
}

function requireConfig(settings: AppSettings): { apiKey: string; workspaceId: string } {
  const apiKey = settings.clickupApiKey;
  const workspaceId = (settings.clickupWorkspaceId || '').trim();
  if (!apiKey) throw new Error('ClickUp API key not configured — add it in Settings → Tasks.');
  if (!workspaceId) throw new Error('ClickUp Workspace ID not configured — add it in Settings → Tasks.');
  return { apiKey, workspaceId };
}

function toMs(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(n) ? n : 0;
}

/** Deep link into the ClickUp web app's Chat view.
 *
 *  `/{workspace}/chat/r/{channel}` is the shape ClickUp's own share links use —
 *  confirmed from links pasted into real messages by the web app. This matters
 *  more than it looks: ClickUp has no API to mark a conversation read, so
 *  opening it there is the only way to clear its unread badge on that side. */
function channelUrl(workspaceId: string, channelId: string): string {
  return `https://app.clickup.com/${workspaceId}/chat/r/${encodeURIComponent(channelId)}`;
}

// ─── Users ───────────────────────────────────────────────────────────────────

/** Workspace members keyed by id, so a message's `user_id` can become a name,
 *  an avatar and a colour without a request per message. */
async function memberIndex(settings: AppSettings): Promise<Map<string, WorkspaceMember>> {
  const result = await provider.getWorkspaceMembers!(settings);
  const index = new Map<string, WorkspaceMember>();
  if (result.success) {
    for (const m of result.data) index.set(String(m.id), m);
  }
  return index;
}

function toChatUser(id: string, index: Map<string, WorkspaceMember>): ChatUser {
  const member = index.get(String(id));
  if (member) {
    return {
      id: String(member.id),
      username: member.username,
      email: member.email,
      initials: member.initials,
      color: member.color,
      profilePicture: member.profilePicture,
      lastActiveMs: member.lastActiveMs,
    };
  }
  // Bots, deactivated accounts and guests aren't in the member list. A negative
  // id is ClickUp's marker for an automation/integration author.
  const numeric = Number(id);
  const isBot = Number.isFinite(numeric) && numeric < 0;
  return { id: String(id), username: isBot ? 'ClickUp Automation' : `User ${id}`, initials: isBot ? 'CU' : '?' };
}

// ─── Channels ────────────────────────────────────────────────────────────────

function normalizeChannel(raw: any, workspaceId: string): ChatChannel {
  const kind = (raw?.type as ChatChannel['kind']) || 'CHANNEL';
  return {
    id: String(raw?.id ?? ''),
    // DMs and group DMs come back with no name — the member resolver fills it.
    name: (raw?.name || '').trim(),
    kind,
    visibility: raw?.visibility,
    topic: raw?.topic || undefined,
    description: typeof raw?.description === 'string' ? raw.description : undefined,
    archived: !!raw?.archived,
    // NOTE: ClickUp documents a `counts` object carrying `has_unread`, but it
    // comes back null for personal API tokens — verified against a live
    // Workspace. Unread is therefore tracked locally against
    // `latestCommentAtMs`; see the renderer's chat store.
    latestCommentAtMs: toMs(raw?.latest_comment_at) || toMs(raw?.updated_at),
    createdAtMs: toMs(raw?.created_at),
    url: channelUrl(workspaceId, String(raw?.id ?? '')),
  };
}

/**
 * Every Channel this account can see, newest conversation first.
 *
 * `followingOnly` maps to ClickUp's `is_follower` filter — the answer to
 * "list the Channels I follow" without pulling the whole Workspace. DMs are
 * always included regardless: a DM you are in is one you follow.
 */
export async function getChannels(
  settings: AppSettings,
  opts?: { followingOnly?: boolean; background?: boolean; force?: boolean },
): Promise<ProviderResult<ChatChannel[]>> {
  try {
    const { apiKey, workspaceId } = requireConfig(settings);
    const followingOnly = opts?.followingOnly !== false;
    const key = `channels:${workspaceId}:${followingOnly}`;
    if (!opts?.force) {
      const cached = cacheGet<ChatChannel[]>(key, CHANNELS_TTL);
      if (cached) return { success: true, data: withResolvedNames(cached) };
    }

    const all: ChatChannel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CHANNEL_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(CHANNEL_PAGE_LIMIT),
        description_format: 'text/md',
        include_closed: 'false',
      });
      if (followingOnly) params.set('is_follower', 'true');
      if (cursor) params.set('cursor', cursor);

      const body = await clickUpFetch(
        apiKey,
        `/v3/workspaces/${workspaceId}/chat/channels?${params.toString()}`,
        {},
        opts?.background,
      );
      for (const raw of body?.data || []) all.push(normalizeChannel(raw, workspaceId));
      cursor = body?.next_cursor || undefined;
      if (!cursor) break;
    }

    // On this Workspace `is_follower=true` includes DMs, so the extra read
    // below is skipped. It stays as a fallback because a DM has no follow
    // relationship to speak of, and a Workspace that filters them out would
    // otherwise show an empty "direct messages" list with no way to fix it.
    if (followingOnly && !all.some((c) => c.kind !== 'CHANNEL')) {
      const dmParams = new URLSearchParams({
        limit: String(CHANNEL_PAGE_LIMIT),
        description_format: 'text/md',
      });
      dmParams.append('channel_types', 'DM');
      dmParams.append('channel_types', 'GROUP_DM');
      try {
        const dmBody = await clickUpFetch(
          apiKey,
          `/v3/workspaces/${workspaceId}/chat/channels?${dmParams.toString()}`,
          {},
          opts?.background,
        );
        const seen = new Set(all.map((c) => c.id));
        for (const raw of dmBody?.data || []) {
          const channel = normalizeChannel(raw, workspaceId);
          if (!seen.has(channel.id)) all.push(channel);
        }
      } catch (err) {
        // A Workspace without Chat DMs enabled answers 4xx here. The Channel
        // list is still perfectly usable, so this is not worth failing over.
        debugLog('[ClickUpChat] DM channel fetch skipped:', err instanceof Error ? err.message : err);
      }
    }

    all.sort((a, b) => (b.latestCommentAtMs || 0) - (a.latestCommentAtMs || 0));
    cacheSet(key, all);

    // Name the DMs in the background so the sidebar paints immediately and
    // fills in names a beat later, instead of blocking on ~20 member reads.
    void resolveDmNames(settings, all).catch(() => {});

    return { success: true, data: withResolvedNames(all) };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to load Chat channels') };
  }
}

/** Overlay any DM names that have resolved since the list was cached. */
function withResolvedNames(channels: ChatChannel[]): ChatChannel[] {
  return channels.map((channel) => {
    if (channel.kind === 'CHANNEL') return channel;
    const members = cacheGet<ChatUser[]>(`members:${channel.id}`, MEMBERS_TTL);
    if (!members) return channel;
    return { ...channel, members, name: channel.name || dmName(members) };
  });
}

/** "Anh Tuan" for a DM, "Anh, Tuan, Mai +2" for a group. */
function dmName(members: ChatUser[]): string {
  const names = members.map((m) => m.username).filter(Boolean);
  if (names.length === 0) return 'Direct message';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

/**
 * Fill in the participant list for DM/group-DM channels that don't have one
 * yet, a few at a time. The result is cached, so this is a one-off cost per
 * DM per session and later calls are no-ops.
 */
async function resolveDmNames(settings: AppSettings, channels: ChatChannel[]): Promise<void> {
  const pending = channels
    .filter((c) => c.kind !== 'CHANNEL' && !c.name)
    .filter((c) => !cacheGet(`members:${c.id}`, MEMBERS_TTL))
    .slice(0, DM_RESOLVE_BATCH);
  if (pending.length === 0) return;

  const index = await memberIndex(settings);
  const queue = [...pending];
  const workers = Array.from({ length: Math.min(DM_RESOLVE_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await loadChannelMembers(settings, next.id, index, true);
      } catch {
        // One unreadable DM must not stop the rest from getting names.
      }
    }
  });
  await Promise.all(workers);
}

async function loadChannelMembers(
  settings: AppSettings,
  channelId: string,
  index: Map<string, WorkspaceMember>,
  background: boolean,
): Promise<ChatUser[]> {
  const key = `members:${channelId}`;
  const cached = cacheGet<ChatUser[]>(key, MEMBERS_TTL);
  if (cached) return cached;

  const { apiKey, workspaceId } = requireConfig(settings);
  const body = await clickUpFetch(
    apiKey,
    `/v3/workspaces/${workspaceId}/chat/channels/${encodeURIComponent(channelId)}/members?limit=100`,
    {},
    background,
  );
  const me = await getMe(settings);
  const members: ChatUser[] = (body?.data || [])
    .map((raw: any) => {
      const id = String(raw?.id ?? raw?.user_id ?? '');
      const resolved = toChatUser(id, index);
      // The Channel member payload is richer than the id alone when ClickUp
      // includes it; prefer it over the Workspace lookup.
      return {
        ...resolved,
        username: raw?.username || raw?.name || resolved.username,
        email: raw?.email || resolved.email,
        initials: raw?.initials || resolved.initials,
        profilePicture: raw?.profile_picture || raw?.profilePicture || resolved.profilePicture,
      };
    })
    // A DM named "me and them" should read as "them".
    .filter((u: ChatUser) => !me.success || u.id !== me.data.id);

  cacheSet(key, members);
  return members;
}

export async function getChannelMembers(
  settings: AppSettings,
  channelId: string,
): Promise<ProviderResult<ChatUser[]>> {
  try {
    const index = await memberIndex(settings);
    return { success: true, data: await loadChannelMembers(settings, channelId, index, false) };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to load channel members') };
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

function normalizeMessage(raw: any, channelId: string, index: Map<string, WorkspaceMember>): ChatMessage {
  return {
    id: String(raw?.id ?? ''),
    channelId: String(raw?.parent_channel || channelId),
    content: typeof raw?.content === 'string' ? raw.content : '',
    user: toChatUser(String(raw?.user_id ?? ''), index),
    createdAtMs: toMs(raw?.date),
    updatedAtMs: toMs(raw?.date_updated) || undefined,
    type: raw?.type === 'post' ? 'post' : 'message',
    postTitle: raw?.post_data?.title || undefined,
    resolved: !!raw?.resolved,
    replyCount: Number(raw?.replies_count ?? 0) || 0,
    parentMessageId: raw?.parent_message ? String(raw.parent_message) : undefined,
  };
}

/**
 * One page of a Channel's messages, returned OLDEST-FIRST so the renderer can
 * append without reversing. ClickUp answers newest-first with a cursor that
 * walks backwards in time; `cursor` from the previous page fetches older
 * messages, which is what "load earlier" means in the UI.
 */
export async function getMessages(
  settings: AppSettings,
  channelId: string,
  opts?: { cursor?: string | null; limit?: number; background?: boolean },
): Promise<ProviderResult<ChatMessagePage>> {
  try {
    const { apiKey, workspaceId } = requireConfig(settings);
    const params = new URLSearchParams({
      limit: String(Math.min(opts?.limit || DEFAULT_MESSAGE_LIMIT, 100)),
      content_format: 'text/md',
    });
    if (opts?.cursor) params.set('cursor', opts.cursor);

    const [body, index] = await Promise.all([
      clickUpFetch(
        apiKey,
        `/v3/workspaces/${workspaceId}/chat/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`,
        {},
        opts?.background,
      ),
      memberIndex(settings),
    ]);

    const raw: any[] = body?.data || [];
    const messages = raw
      .map((m) => normalizeMessage(m, channelId, index))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);

    return {
      success: true,
      data: {
        messages,
        cursor: body?.next_cursor || null,
        // ClickUp keeps handing back a cursor even on the last page, so a short
        // page is the only reliable end-of-history signal.
        hasMore: !!body?.next_cursor && raw.length >= (opts?.limit || DEFAULT_MESSAGE_LIMIT),
      },
    };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to load messages') };
  }
}

export async function sendMessage(
  settings: AppSettings,
  channelId: string,
  content: string,
): Promise<ProviderResult<ChatMessage>> {
  try {
    const text = (content || '').trim();
    if (!text) return { success: false, error: 'Message is empty' };
    // ClickUp rejects anything past 40 000 characters outright.
    if (text.length > 40_000) return { success: false, error: 'Message is longer than ClickUp allows (40 000 characters)' };

    const { apiKey, workspaceId } = requireConfig(settings);
    const [body, index] = await Promise.all([
      clickUpFetch(
        apiKey,
        `/v3/workspaces/${workspaceId}/chat/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'message', content: text, content_format: 'text/md' }),
        },
      ),
      memberIndex(settings),
    ]);

    // The Channel list orders by recency, so it is stale the moment we post.
    invalidateChannels();
    return { success: true, data: normalizeMessage(body?.data || body, channelId, index) };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to send message') };
  }
}

export async function getReplies(
  settings: AppSettings,
  messageId: string,
  opts?: { cursor?: string | null; background?: boolean },
): Promise<ProviderResult<ChatMessagePage>> {
  try {
    const { apiKey, workspaceId } = requireConfig(settings);
    const params = new URLSearchParams({ limit: '100', content_format: 'text/md' });
    if (opts?.cursor) params.set('cursor', opts.cursor);

    const [body, index] = await Promise.all([
      clickUpFetch(
        apiKey,
        `/v3/workspaces/${workspaceId}/chat/messages/${encodeURIComponent(messageId)}/replies?${params.toString()}`,
        {},
        opts?.background,
      ),
      memberIndex(settings),
    ]);

    const messages = (body?.data || [])
      .map((m: any) => normalizeMessage(m, '', index))
      .sort((a: ChatMessage, b: ChatMessage) => a.createdAtMs - b.createdAtMs);

    return { success: true, data: { messages, cursor: body?.next_cursor || null, hasMore: false } };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to load replies') };
  }
}

export async function sendReply(
  settings: AppSettings,
  messageId: string,
  content: string,
): Promise<ProviderResult<ChatMessage>> {
  try {
    const text = (content || '').trim();
    if (!text) return { success: false, error: 'Reply is empty' };

    const { apiKey, workspaceId } = requireConfig(settings);
    const [body, index] = await Promise.all([
      clickUpFetch(
        apiKey,
        `/v3/workspaces/${workspaceId}/chat/messages/${encodeURIComponent(messageId)}/replies`,
        {
          method: 'POST',
          body: JSON.stringify({ type: 'message', content: text, content_format: 'text/md' }),
        },
      ),
      memberIndex(settings),
    ]);

    invalidateChannels();
    return { success: true, data: normalizeMessage(body?.data || body, '', index) };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to send reply') };
  }
}

// ─── Reactions ───────────────────────────────────────────────────────────────

/** Reactions are cached per message: they are read one message at a time, so
 *  a channel that re-polls must not re-read every message's reactions. */
const REACTIONS_TTL = 10 * 60_000;
/** Newest messages whose reactions are pre-loaded when a Channel opens.
 *  ClickUp returns no reaction data with the message list and offers no bulk
 *  read, so each one costs a request — this is the ceiling on that cost. */
const REACTION_PREFETCH = 12;
const REACTION_CONCURRENCY = 4;

async function loadReactions(
  settings: AppSettings,
  messageId: string,
  background: boolean,
  force = false,
): Promise<ChatMessage['reactions']> {
  const key = `reactions:${messageId}`;
  if (!force) {
    const cached = cacheGet<ChatMessage['reactions']>(key, REACTIONS_TTL);
    if (cached) return cached;
  }

  const { apiKey, workspaceId } = requireConfig(settings);
  const [body, me] = await Promise.all([
    clickUpFetch(
      apiKey,
      `/v3/workspaces/${workspaceId}/chat/messages/${encodeURIComponent(messageId)}/reactions?limit=100`,
      {},
      background,
    ),
    getMe(settings),
  ]);

  const meId = me.success ? me.data.id : null;
  const byReaction = new Map<string, { reaction: string; count: number; mine: boolean }>();
  for (const raw of body?.data || []) {
    const name = String(raw?.reaction || '');
    if (!name) continue;
    const entry = byReaction.get(name) || { reaction: name, count: 0, mine: false };
    entry.count += 1;
    if (meId && String(raw?.user_id) === meId) entry.mine = true;
    byReaction.set(name, entry);
  }

  const reactions = [...byReaction.values()].sort((a, b) => b.count - a.count);
  cacheSet(key, reactions);
  return reactions;
}

/** Reactions for a set of messages, keyed by message id.
 *
 *  ClickUp ships no reaction data on the message list and has no bulk endpoint,
 *  so this is one request per message — capped, run on the background lane and
 *  cached, which is what keeps a Channel open from eating the minute's budget.
 */
export async function getReactions(
  settings: AppSettings,
  messageIds: string[],
  opts?: { background?: boolean; force?: boolean },
): Promise<ProviderResult<Record<string, ChatMessage['reactions']>>> {
  try {
    const ids = [...new Set((messageIds || []).filter(Boolean))].slice(0, REACTION_PREFETCH);
    const out: Record<string, ChatMessage['reactions']> = {};
    const queue = [...ids];

    const workers = Array.from({ length: Math.min(REACTION_CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        try {
          out[id] = await loadReactions(settings, id, opts?.background !== false, opts?.force);
        } catch {
          // One unreadable message must not lose the rest of the page.
        }
      }
    });
    await Promise.all(workers);

    return { success: true, data: out };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to load reactions') };
  }
}

export async function react(
  settings: AppSettings,
  messageId: string,
  reaction: string,
): Promise<ProviderResult<true>> {
  try {
    const { apiKey, workspaceId } = requireConfig(settings);
    await clickUpFetch(
      apiKey,
      `/v3/workspaces/${workspaceId}/chat/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: 'POST', body: JSON.stringify({ reaction }) },
    );
    cache.delete(`reactions:${messageId}`);
    return { success: true, data: true };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to add reaction') };
  }
}

export async function unreact(
  settings: AppSettings,
  messageId: string,
  reaction: string,
): Promise<ProviderResult<true>> {
  try {
    const { apiKey, workspaceId } = requireConfig(settings);
    await clickUpFetch(
      apiKey,
      `/v3/workspaces/${workspaceId}/chat/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reaction)}`,
      { method: 'DELETE' },
    );
    cache.delete(`reactions:${messageId}`);
    return { success: true, data: true };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to remove reaction') };
  }
}

// ─── Presence ────────────────────────────────────────────────────────────────

/** Presence is re-read far more often than the member list, but not on every
 *  poll — a minute of staleness is invisible against a 5-minute online window. */
const PRESENCE_TTL = 60_000;

/**
 * When each workspace member was last active in ClickUp, keyed by user id.
 *
 * ClickUp exposes no realtime presence channel, but every member carries a
 * `last_active` timestamp that tracks actual app usage — and notably is NOT
 * bumped by API traffic, so it reflects a person being there rather than an
 * integration polling. That makes it an honest basis for an "online" dot, as
 * long as the UI says "active 12m ago" rather than claiming a live socket.
 */
export async function getPresence(
  settings: AppSettings,
  opts?: { background?: boolean },
): Promise<ProviderResult<Record<string, number>>> {
  try {
    const { apiKey, workspaceId } = requireConfig(settings);
    const key = `presence:${workspaceId}`;
    const cached = cacheGet<Record<string, number>>(key, PRESENCE_TTL);
    if (cached) return { success: true, data: cached };

    // Read /team directly rather than through getWorkspaceMembers: that cache
    // is five minutes deep, which is older than the online window itself.
    const body = await clickUpFetch(apiKey, `/team/${workspaceId}`, {}, opts?.background !== false);
    const team = body?.team || (body?.teams || [])[0];
    const presence: Record<string, number> = {};
    for (const member of team?.members || []) {
      const id = String(member?.user?.id ?? '');
      const lastActive = Number(member?.user?.last_active);
      if (id && Number.isFinite(lastActive) && lastActive > 0) presence[id] = lastActive;
    }

    cacheSet(key, presence);
    return { success: true, data: presence };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to load presence') };
  }
}

// ─── Attachments ─────────────────────────────────────────────────────────────

/** Base64 inflates by 4/3 and the whole payload crosses IPC as a string, so
 *  this is a practical ceiling rather than a ClickUp one. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Uploads get far longer than a JSON read: a 20MB file on a slow link is
 *  minutes, and the user can cancel long before this fires. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** In-flight uploads, so the renderer can cancel one it started. Keyed by an
 *  id the renderer generates and passes to both calls. */
const uploadControllers = new Map<string, AbortController>();

/** Abort an upload in progress. Unknown ids are a no-op: the upload may have
 *  finished between the user clicking cancel and this arriving. */
export function cancelUpload(uploadId: string): ProviderResult<true> {
  uploadControllers.get(uploadId)?.abort();
  uploadControllers.delete(uploadId);
  return { success: true, data: true };
}

/** ClickUp's attachment POST is not a reliable source for the file's URL: it
 *  has been observed answering with the literal string "null" in `url`, and
 *  with a different uuid than the one the attachment is actually filed under.
 *  Anything that is not an absolute http(s) URL has to be treated as absent —
 *  `"null"` is truthy, so a plain falsy check let it through and the message
 *  went out as `![image.png](null)`. */
function isUsableUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** The task record is authoritative, so when the upload response has no usable
 *  URL, read it back from the task. The response's `id` does match what the
 *  attachment is stored as, so it is the key; the newest attachment is the
 *  fallback for the case where even that is missing. */
async function attachmentUrlFromTask(
  apiKey: string,
  taskId: string,
  attachmentId: string,
): Promise<string | undefined> {
  try {
    const task = await clickUpFetch(apiKey, `/task/${encodeURIComponent(taskId)}`);
    const stored: any[] = Array.isArray(task?.attachments) ? task.attachments : [];
    const byId = attachmentId
      ? stored.find((a) => String(a?.id ?? '') === attachmentId)
      : undefined;
    const newest = [...stored].sort((a, b) => Number(b?.date ?? 0) - Number(a?.date ?? 0))[0];
    for (const candidate of [byId, newest]) {
      const found = [candidate?.url, candidate?.url_w_host, candidate?.url_w_query].find(isUsableUrl);
      if (found) return found;
    }
  } catch {
    // Leave it to the caller to report — a failed read-back is still "no URL".
  }
  return undefined;
}

/**
 * Put a file somewhere ClickUp Chat can reference it.
 *
 * Chat has no attachment endpoint — the v3 attachments API answers
 * "Invalid path param for entityType: chat_messages" — so the file is attached
 * to the task named by `chatUploadTaskId` and the message links its URL.
 * Task attachments are served from the same public host as images pasted into
 * Chat by the web app (`t<workspace>.p.clickup-attachments.com`), so the
 * result renders inline for everyone, not just this account.
 *
 * The hosting task is a deliberate setting with no default: uploads leave a
 * visible trail on whichever task is chosen, and that is the user's call.
 */
export async function uploadFile(
  settings: AppSettings,
  file: { name: string; mime: string; data: string },
  uploadId?: string,
): Promise<ProviderResult<ChatUploadedFile>> {
  let taskId = '';
  try {
    const { apiKey } = requireConfig(settings);
    taskId = (settings.chatUploadTaskId || '').trim();
    if (!taskId) {
      return {
        success: false,
        error: 'No upload task configured. ClickUp Chat has no attachment API, so files are attached to a task and linked — pick one in Settings → Tasks.',
      };
    }

    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length === 0) return { success: false, error: 'That file is empty' };
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return { success: false, error: `${file.name} is larger than the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit` };
    }

    // Newlines in a multipart filename would break the part header.
    const name = (file.name || 'file').replace(/[\r\n]/g, ' ').slice(0, 200);
    const form = new FormData();
    // ClickUp names the multipart field "attachment"; anything else is ignored
    // and the request comes back 400 with no explanation.
    form.append('attachment', new Blob([bytes], { type: file.mime || 'application/octet-stream' }), name);

    const controller = new AbortController();
    if (uploadId) uploadControllers.set(uploadId, controller);
    let body: any;
    try {
      body = await clickUpFetch(
        apiKey,
        `/task/${encodeURIComponent(taskId)}/attachment`,
        { method: 'POST', body: form, signal: controller.signal },
        false,
        UPLOAD_TIMEOUT_MS,
      );
    } finally {
      if (uploadId) uploadControllers.delete(uploadId);
    }

    const url =
      [body?.url, body?.url_w_query, body?.url_w_host, body?.thumbnail_large].find(isUsableUrl) ||
      (await attachmentUrlFromTask(apiKey, taskId, String(body?.id ?? '')));
    if (!url) {
      return {
        success: false,
        error: `ClickUp stored ${file.name} on the upload task but returned no usable URL for it`,
      };
    }

    return {
      success: true,
      data: {
        name: body?.title || name,
        url,
        isImage: /^image\//.test(file.mime || '') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An abort is the user cancelling, not a failure worth explaining.
    if (/abort/i.test(message)) {
      return { success: false, error: `Upload of ${file.name} cancelled` };
    }
    // A 401/404 here is about the hosting TASK, not about Chat access — the
    // generic mapper below would blame the wrong thing and send the user off
    // to check a setting that is already correct.
    if (/401|404|OAUTH_027|ITEM_013/.test(message)) {
      return {
        success: false,
        error: `ClickUp would not accept the upload. Check that the Chat files task "${taskId}" exists and this account can see it (Settings → Tasks).`,
      };
    }
    return { success: false, error: describe(error, `Failed to upload ${file.name}`) };
  }
}

/** Markdown for an uploaded file — images embed, everything else links. This
 *  is the shape ClickUp Chat itself uses, so it renders the same way. */
export function attachmentMarkdown(file: ChatUploadedFile): string {
  return file.isImage ? `![${file.name}](${file.url})` : `[📎 ${file.name}](${file.url})`;
}

// ─── Direct messages ─────────────────────────────────────────────────────────

/**
 * Open (or reuse) a direct message with the given people.
 *
 * ClickUp returns the existing conversation when one already exists, so this
 * is safe to call every time the user picks a name out of the people list —
 * there is no "already have a DM with them" case to handle in the UI.
 */
export async function createDirectMessage(
  settings: AppSettings,
  userIds: string[],
): Promise<ProviderResult<ChatChannel>> {
  try {
    const ids = [...new Set((userIds || []).map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return { success: false, error: 'Pick at least one person' };
    if (ids.length > 15) return { success: false, error: 'ClickUp allows at most 15 people in a group DM' };

    const { apiKey, workspaceId } = requireConfig(settings);
    const body = await clickUpFetch(
      apiKey,
      `/v3/workspaces/${workspaceId}/chat/channels/direct_message`,
      // ClickUp wants numbers here; string ids from the member list are
      // rejected with a 400 that names no field.
      { method: 'POST', body: JSON.stringify({ user_ids: ids.map((id) => Number(id) || id) }) },
    );

    const channel = normalizeChannel(body?.data || body, workspaceId);
    invalidateChannels();
    const index = await memberIndex(settings);
    const members = ids.map((id) => toChatUser(id, index));
    cacheSet(`members:${channel.id}`, members);
    return { success: true, data: { ...channel, members, name: channel.name || dmName(members) } };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to open a direct message') };
  }
}

/** Everyone in the Workspace, so the page can offer "message anyone" and not
 *  just the people already in a conversation. */
export async function getPeople(settings: AppSettings): Promise<ProviderResult<ChatUser[]>> {
  const result = await provider.getWorkspaceMembers!(settings);
  if (!result.success) return result;
  const me = await getMe(settings);
  const meId = me.success ? me.data.id : null;
  return {
    success: true,
    data: result.data
      .filter((m) => m.id !== meId)
      .map((m) => ({
        id: String(m.id),
        username: m.username,
        email: m.email,
        initials: m.initials,
        color: m.color,
        profilePicture: m.profilePicture,
        lastActiveMs: m.lastActiveMs,
      })),
  };
}

/** The account this API key belongs to — used to right-align the user's own
 *  messages and to keep them out of the people picker. */
export async function getMe(settings: AppSettings): Promise<ProviderResult<ChatUser>> {
  try {
    const { apiKey } = requireConfig(settings);
    const key = `me:${apiKey.slice(-8)}`;
    const cached = cacheGet<ChatUser>(key, MEMBERS_TTL);
    if (cached) return { success: true, data: cached };

    const body = await clickUpFetch(apiKey, '/user');
    const user = body?.user || {};
    const me: ChatUser = {
      id: String(user.id ?? ''),
      username: user.username || user.email || 'Me',
      email: user.email,
      initials: user.initials,
      color: user.color,
      profilePicture: user.profilePicture,
    };
    cacheSet(key, me);
    return { success: true, data: me };
  } catch (error) {
    return { success: false, error: describe(error, 'Failed to identify the ClickUp account') };
  }
}

function invalidateChannels(): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith('channels:')) cache.delete(key);
  }
}

function describe(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (!message) return fallback;
  debugError(`[ClickUpChat] ${fallback}:`, message);
  // ClickUp answers 401 for a key without the Chat scope, which reads as a
  // broken integration unless we say what it actually means.
  if (message.includes('401')) {
    return 'ClickUp rejected the API key for Chat. A personal API token can read Chat only if the account has Chat enabled.';
  }
  if (message.includes('403')) return 'This ClickUp account does not have access to Chat.';
  return message;
}
