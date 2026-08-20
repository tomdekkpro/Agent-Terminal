import type { AppSettings, TaskManagerTask, TaskManagerList, TaskSearchFilters } from '../../../shared/types';
import type { ITaskManagerProvider, ProviderResult, WorkspaceMember } from './types';
import { debugLog, debugError } from '../../../shared/utils';
import { logApiRequest } from '../../logging/api-log';

const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

// 30-second cache
const taskCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 30000;
// Workspace shape (lists, statuses, members) changes rarely and is re-read on
// every board render — cache it far longer than task data.
const STATIC_CACHE_TTL = 5 * 60_000;
// The space/folder/list tree is the slowest static read (one request for spaces
// then two per space, ~700ms in two round-trips) and it is what every list
// picker waits on before it can even ask for tasks. Past STATIC_CACHE_TTL the
// cached tree is still served immediately and refreshed behind the caller; only
// past this is it too old to hand out at all.
const LISTS_STALE_TTL = 60 * 60_000;
const MAX_SEARCH_PAGES = 10;
// Safety cap for the multi-list review fetch (3000 tasks across all lists).
const MAX_REVIEW_PAGES = 30;
const MAX_CACHE_ENTRIES = 500;
// Snapshot batching: page cap keeps a huge list from costing more than the
// per-task reads it replaces, and small boards skip batching entirely.
const MAX_SNAPSHOT_PAGES = 15;
const MIN_BULK_SNAPSHOT_TASKS = 5;
// After the first full page-through, snapshot refreshes only ask ClickUp for
// tasks updated since the last sync (usually zero or one small page) and serve
// everything else from the store below. A periodic full resync catches
// anything the incremental filter can miss (e.g. tasks moved between lists).
const SNAPSHOT_FULL_RESYNC_MS = 15 * 60_000;
// Overlap on the date_updated_gt watermark to absorb clock skew between this
// machine and ClickUp's servers.
const SNAPSHOT_WATERMARK_OVERLAP_MS = 60_000;

type SnapshotStore = {
  byId: Map<string, TaskManagerTask>;
  /** Start time of the last successful sync — next incremental watermark. */
  lastSyncMs: number;
  /** When the last full page-through ran. */
  fullSyncMs: number;
};
/** Keyed by the sorted list-id set the snapshot covers. */
const snapshotStores = new Map<string, SnapshotStore>();

/** At most one list-tree walk in flight per workspace; callers share it. */
const listsInflight = new Map<string, Promise<TaskManagerList[]>>();

// ─── Rate limiting ──────────────────────────────────────────────────────────
// ClickUp enforces a per-token limit of 100 requests/minute on Free/Unlimited/
// Business plans (1000 on Business Plus, 10000 on Enterprise). Several pollers
// hit this provider independently (Kanban snapshot refresh, backlog poll,
// dashboard notices, code-review scheduler, Auto Code), and some helpers fan out
// to one request per task or per page — enough to burn a whole minute's budget
// in one burst and get everything back a 429. So every request goes through a
// token bucket + concurrency gate, and a 429 pauses ALL traffic until the window
// the API told us about has passed.
const REQUEST_BUDGET = 90; // headroom under the 100/min floor
// Background pollers (snapshot refresh, schedulers) may not spend the last
// slice of the budget — it is reserved so a user click never has to wait a
// whole window because polling drained the bucket first.
const BACKGROUND_BUDGET = 60;
const BUDGET_WINDOW_MS = 60_000;
// ClickUp caps *requests per minute*, not requests in flight, so the token
// bucket above is what keeps us under the limit — this gate only exists to keep
// a fan-out from opening an unbounded number of sockets. It was set to 4, which
// turned every fan-out into ceil(n / 4) round-trips of pure waiting: the twelve
// per-task comment reads behind a Code Review load took three waves instead of
// one. 8 still bounds the socket count while letting a normal fan-out finish in
// a single round-trip.
const MAX_CONCURRENT = 8;
const MAX_RETRIES = 3;
// A user click must not sit through three 60s backoffs. Background pollers can
// afford to wait out a full window; something a person is watching cannot, so
// it retries once and then reports the limit instead of hanging for ~3 minutes.
const INTERACTIVE_MAX_RETRIES = 1;
// Longest an interactive caller will block waiting for the gate before giving
// up with a clear message. Blocking beyond this reads as a frozen UI.
const INTERACTIVE_MAX_WAIT_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

let windowStart = 0;
let windowCount = 0;
let inFlight = 0;
// Interactive requests (a user opening a task, dragging a status) always jump
// ahead of queued background traffic.
const interactiveWaiters: (() => void)[] = [];
const backgroundWaiters: (() => void)[] = [];
/** Hard pause: the API answered 429, so every caller must hold off — the limit
 *  is per token and sending more would only earn another 429. */
let pausedUntil = 0;
/** Soft pause: the rate-limit headers say the window is nearly spent. Applies
 *  to background traffic only, so the last requests in a window go to whatever
 *  the user just clicked rather than to a poller. */
let backgroundPausedUntil = 0;

/** Thrown instead of blocking when an interactive caller would have to wait out
 *  a rate-limit window. Carries a user-readable delay. */
class RateLimitedError extends Error {
  constructor(waitMs: number) {
    super(
      `ClickUp rate limit reached — too many requests in the last minute. Try again in ${Math.ceil(waitMs / 1000)}s.`,
    );
    this.name = 'RateLimitedError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Blocks until it is this caller's turn to issue a request.
 *  Interactive callers give up with a RateLimitedError rather than block past
 *  INTERACTIVE_MAX_WAIT_MS; background callers wait as long as it takes. */
async function acquireSlot(background: boolean): Promise<void> {
  const deadline = background ? Infinity : Date.now() + INTERACTIVE_MAX_WAIT_MS;
  for (;;) {
    const now = Date.now();
    // A 429 holds everyone; the pre-emptive header warning holds pollers only.
    const waitUntil = background
      ? Math.max(pausedUntil, backgroundPausedUntil)
      : pausedUntil;
    if (waitUntil > now) {
      if (waitUntil > deadline) throw new RateLimitedError(waitUntil - now);
      await sleep(waitUntil - now);
      continue;
    }
    if (now - windowStart >= BUDGET_WINDOW_MS) {
      windowStart = now;
      windowCount = 0;
    }
    if (windowCount >= (background ? BACKGROUND_BUDGET : REQUEST_BUDGET)) {
      const until = windowStart + BUDGET_WINDOW_MS;
      if (until > deadline) throw new RateLimitedError(until - now);
      await sleep(until - now);
      continue;
    }
    if (inFlight >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) =>
        (background ? backgroundWaiters : interactiveWaiters).push(resolve),
      );
      continue;
    }
    windowCount++;
    inFlight++;
    return;
  }
}

function releaseSlot(): void {
  inFlight--;
  (interactiveWaiters.shift() || backgroundWaiters.shift())?.();
}

/** How long to wait after a 429, from Retry-After / X-RateLimit-Reset, else backoff. */
function resolveRetryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  // ClickUp sends the reset as a unix timestamp in seconds
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset * 1000 - Date.now();
    if (ms > 0) return Math.min(ms + 500, MAX_BACKOFF_MS);
  }
  return Math.min(5000 * 2 ** attempt, MAX_BACKOFF_MS);
}

/** Keep the local budget in step with what the API reports it has left. */
function syncBudgetFromHeaders(response: Response): void {
  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  if (!Number.isFinite(remaining)) return;
  if (remaining > 2) return;
  // Nearly out. Hold back background traffic only — this is a warning, not a
  // refusal, so the requests still left in the window belong to whatever the
  // user is waiting on rather than to a poller. Draining can also be caused by
  // something else using the same token, which we cannot see or control.
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 + 500 : Date.now() + 5000;
  if (until > backgroundPausedUntil) {
    backgroundPausedUntil = Math.min(until, Date.now() + MAX_BACKOFF_MS);
    debugLog(`[ClickUp] ${remaining} request(s) left in window — pausing background traffic ${Math.ceil((backgroundPausedUntil - Date.now()) / 1000)}s`);
  }
}

/** Concurrent GETs for the same endpoint share one request instead of racing. */
const inflightGets = new Map<string, Promise<any>>();

async function clickUpFetch(
  apiKey: string,
  endpoint: string,
  options: RequestInit = {},
  background = false,
) {
  if (!apiKey) throw new Error('ClickUp API key not configured');

  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') return sendRequest(apiKey, endpoint, options, background);

  const key = `${apiKey}:${endpoint}`;
  const existing = inflightGets.get(key);
  if (existing) return existing;

  const promise = sendRequest(apiKey, endpoint, options, background).finally(() => {
    inflightGets.delete(key);
  });
  inflightGets.set(key, promise);
  return promise;
}

async function sendRequest(
  apiKey: string,
  endpoint: string,
  options: RequestInit,
  background: boolean,
): Promise<any> {
  const method = (options.method || 'GET').toUpperCase();

  for (let attempt = 0; ; attempt++) {
    await acquireSlot(background);

    let response: Response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const startedAt = Date.now();
    try {
      response = await fetch(`${CLICKUP_API_BASE}${endpoint}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } catch (err) {
      // Network failure or the 30s abort — there is no response to inspect, so
      // this is the only place the endpoint can be attached to the error.
      const reason = err instanceof Error ? err.message : String(err);
      logApiRequest({
        provider: 'ClickUp',
        method,
        endpoint,
        durationMs: Date.now() - startedAt,
        attempt,
        background,
        error: reason,
      });
      throw new Error(`ClickUp request failed: ${method} ${endpoint} — ${reason}`);
    } finally {
      clearTimeout(timeoutId);
      releaseSlot();
    }

    // Exactly one log line per attempt: each outcome below records its own, so
    // a failure is never reported twice, once with and once without its reason.
    const logLine = (error?: string) =>
      logApiRequest({
        provider: 'ClickUp',
        method,
        endpoint,
        status: response.status,
        durationMs: Date.now() - startedAt,
        attempt,
        background,
        rateRemaining: response.headers.get('x-ratelimit-remaining'),
        error,
      });

    if (response.status === 429) {
      const delay = resolveRetryDelay(response, attempt);
      // Hold every other caller too — the limit is per token, not per request.
      pausedUntil = Math.max(pausedUntil, Date.now() + delay);
      // Interactive callers retry once, then report; three 60s backoffs behind
      // a click is a three-minute freeze, which is worse than a clear error.
      const maxRetries = background ? MAX_RETRIES : INTERACTIVE_MAX_RETRIES;
      if (attempt >= maxRetries) {
        debugError(`[ClickUp] Rate limited on ${method} ${endpoint} — giving up after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}`);
        logLine(`rate limited, gave up after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}`);
        throw new RateLimitedError(delay);
      }
      logLine(`rate limited, retrying in ${Math.ceil(delay / 1000)}s`);
      debugLog(`[ClickUp] 429 on ${method} ${endpoint} — retrying in ${Math.ceil(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
      continue;
    }

    syncBudgetFromHeaders(response);

    if (!response.ok) {
      // ClickUp returns a JSON body like {"err":"Task not found","ECODE":"ITEM_013"}
      // which names the actual problem. Without it — and without the endpoint —
      // a failure was just "400 Bad Request" with no way to tell which query
      // produced it.
      let detail = '';
      try {
        const body = await response.text();
        if (body) {
          try {
            const parsed = JSON.parse(body);
            detail = parsed?.err
              ? `${parsed.err}${parsed.ECODE ? ` [${parsed.ECODE}]` : ''}`
              : body.slice(0, 300);
          } catch {
            detail = body.slice(0, 300);
          }
        }
      } catch { /* body already consumed or unreadable */ }

      const message = `ClickUp API error ${response.status} on ${method} ${endpoint}${detail ? ` — ${detail}` : ''}`;
      logLine(detail || response.statusText || 'request failed');
      throw new Error(message);
    }

    logLine();
    return response.json();
  }
}

function cacheGet(key: string, ttl: number = CACHE_TTL): any | undefined {
  const hit = taskCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.timestamp >= ttl) {
    taskCache.delete(key);
    return undefined;
  }
  return hit.data;
}

/** Like cacheGet but leaves the entry in place when it is past `ttl`, so a
 *  caller can check a short freshness window and still fall back to a longer
 *  staleness window on the same entry. */
function cachePeek(key: string, ttl: number): any | undefined {
  const hit = taskCache.get(key);
  if (!hit) return undefined;
  return Date.now() - hit.timestamp < ttl ? hit.data : undefined;
}

function cacheSet(key: string, data: any): void {
  if (taskCache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of taskCache) {
      if (now - v.timestamp >= CACHE_TTL) taskCache.delete(k);
    }
    // Still full of fresh entries — drop the oldest insertions to bound growth.
    while (taskCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = taskCache.keys().next();
      if (oldest.done) break;
      taskCache.delete(oldest.value);
    }
  }
  taskCache.set(key, { data, timestamp: Date.now() });
}

/** Drop cached copies of a task after we write to it, so the next read is fresh. */
function invalidateTask(taskId: string): void {
  taskCache.delete(`task-${taskId}`);
}

/** Resolve the "Release version" custom field to its display value. Handles
 *  dropdown fields (value is the option id for new_drop_down, or the orderindex
 *  for legacy) and plain text fields. Returns undefined when unset/not present. */
function extractReleaseVersion(raw: any): string | undefined {
  const fields = raw.custom_fields;
  if (!Array.isArray(fields)) return undefined;
  const field = fields.find((f: any) => (f?.name || '').toLowerCase().includes('release version'));
  if (!field) return undefined;
  const value = field.value;
  if (value === undefined || value === null || value === '') return undefined;

  const options = field.type_config?.options;
  if (Array.isArray(options) && options.length > 0) {
    const match = options.find(
      (o: any) => String(o.id) === String(value) || o.orderindex === value,
    );
    if (match) return match.name || match.label || undefined;
  }
  // Plain text / short_text custom field
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function normalizeClickUpTask(raw: any): TaskManagerTask {
  return {
    id: raw.id,
    customId: raw.custom_id,
    name: raw.name,
    description: raw.text_content || raw.description,
    status: { name: raw.status?.status || '', color: raw.status?.color || '#888' },
    priority: raw.priority
      ? { id: raw.priority.id, name: raw.priority.priority, color: raw.priority.color }
      : undefined,
    assignees: (raw.assignees || []).map((a: any) => ({
      id: String(a.id),
      username: a.username,
      email: a.email,
      initials: a.initials,
    })),
    tags: (raw.tags || []).map((t: any) => ({
      name: t.name,
      bgColor: t.tag_bg,
      fgColor: t.tag_fg,
    })),
    releaseVersion: extractReleaseVersion(raw),
    url: raw.url,
    createdAt: raw.date_created,
    updatedAt: raw.date_updated,
    listId: raw.list?.id ? String(raw.list.id) : undefined,
    providerTaskId: raw.id,
    provider: 'clickup',
  };
}

/** Cached `/task/{id}` read. The board refreshes a snapshot per tracked task and
 *  several features re-read the same task moments apart, so this is where the
 *  request count adds up fastest. */
async function fetchTaskRaw(settings: AppSettings, taskId: string): Promise<any> {
  const cacheKey = `task-${taskId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}`);
  cacheSet(cacheKey, data);
  return data;
}

/** A custom task id as ClickUp renders it, e.g. DP2-21173. Requires the
 *  `-<digits>` tail, so an ordinary search word can never match. */
const CUSTOM_TASK_ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** A raw ClickUp task id, e.g. 86d28ttjq. Anchored on a leading digit so
 *  ordinary words (which never start with one) cannot match. */
const RAW_TASK_ID_RE = /^[0-9][0-9a-z]{5,11}$/;

export class ClickUpProvider implements ITaskManagerProvider {
  async checkConnection(settings: AppSettings): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, '/user');
      const teams = await clickUpFetch(settings.clickupApiKey, '/team');
      return {
        success: true,
        data: { user: data.user, workspaces: teams.teams },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  private parseManualListIds(settings: AppSettings): TaskManagerList[] {
    if (!settings.clickupListIds) return [];
    return settings.clickupListIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id, name: `List ${id}` }));
  }

  async getLists(settings: AppSettings): Promise<ProviderResult<TaskManagerList[]>> {
    // If manual list IDs are configured, use them directly
    const manualLists = this.parseManualListIds(settings);
    if (manualLists.length > 0) {
      return { success: true, data: manualLists };
    }

    try {
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const cacheKey = `lists-${teamId}`;
      const fresh = cachePeek(cacheKey, STATIC_CACHE_TTL);
      if (fresh) return { success: true, data: fresh };

      let refresh = listsInflight.get(cacheKey);
      if (!refresh) {
        refresh = this.loadLists(settings, teamId, cacheKey)
          .finally(() => listsInflight.delete(cacheKey));
        listsInflight.set(cacheKey, refresh);
      }

      // Merely stale: hand back what we have and let the refresh land for the
      // next caller. A list picker that would have blocked ~700ms on the walk
      // now paints immediately and picks up new lists on its next open.
      const stale = cachePeek(cacheKey, LISTS_STALE_TTL);
      if (stale) {
        void refresh.catch(() => {});
        return { success: true, data: stale };
      }

      return { success: true, data: await refresh };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch lists',
      };
    }
  }

  /** Walk the workspace's spaces, folders and lists, and cache the result. */
  private async loadLists(
    settings: AppSettings,
    teamId: string,
    cacheKey: string,
  ): Promise<TaskManagerList[]> {
    const spacesRes = await clickUpFetch(settings.clickupApiKey, `/team/${teamId}/space?archived=false`);

    // Folderless lists and folders for every space in parallel — walking
    // them one request at a time made the first open of any list picker
    // take (2 × spaces) round-trips back to back.
    const spaces: any[] = spacesRes.spaces || [];
    const perSpace = await Promise.all(
      spaces.map(async (space: any) => {
        const [folderlessRes, foldersRes] = await Promise.all([
          clickUpFetch(settings.clickupApiKey, `/space/${space.id}/list?archived=false`),
          clickUpFetch(settings.clickupApiKey, `/space/${space.id}/folder?archived=false`),
        ]);
        const spaceLists: TaskManagerList[] = [];
        for (const list of folderlessRes.lists || []) {
          spaceLists.push({ id: list.id, name: list.name, space: space.name });
        }
        for (const folder of foldersRes.folders || []) {
          for (const list of folder.lists || []) {
            spaceLists.push({ id: list.id, name: list.name, space: space.name, folder: folder.name });
          }
        }
        return spaceLists;
      }),
    );
    const lists: TaskManagerList[] = perSpace.flat();

    cacheSet(cacheKey, lists);
    return lists;
  }

  async getTasks(settings: AppSettings, listId?: string, page: number = 0): Promise<ProviderResult<TaskManagerTask[]>> {
    try {
      const targetListId = listId || settings.clickupListId;
      if (!targetListId) throw new Error('No list ID configured');

      const cacheKey = `tasks-${targetListId}-${page}`;
      const cached = cacheGet(cacheKey);
      if (cached) return { success: true, data: cached.map(normalizeClickUpTask) };

      const data = await clickUpFetch(
        settings.clickupApiKey,
        `/list/${targetListId}/task?include_closed=true&subtasks=true&page=${page}`,
      );
      const tasks = data.tasks || [];
      cacheSet(cacheKey, tasks);
      return { success: true, data: tasks.map(normalizeClickUpTask) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch tasks',
      };
    }
  }

  async searchTasks(
    settings: AppSettings,
    query: string,
    filters?: TaskSearchFilters,
    listId?: string,
    page: number = 0,
  ): Promise<ProviderResult<TaskManagerTask[]>> {
    try {
      const targetListId = listId || settings.clickupListId;
      if (!targetListId) throw new Error('No list ID configured');

      const params = new URLSearchParams();
      params.set('subtasks', 'true');
      params.set('include_closed', filters?.includeClosed ? 'true' : 'false');

      if (filters?.statuses?.length) {
        for (const s of filters.statuses) params.append('statuses[]', s);
      }
      if (filters?.assignees?.length) {
        for (const a of filters.assignees) params.append('assignees[]', a);
      }
      // Server-side ordering so paged fetches return the right subset first.
      // These also become part of the cache key via params.toString().
      if (filters?.orderBy) params.set('order_by', filters.orderBy);
      if (filters?.reverse) params.set('reverse', 'true');

      const trimmedQuery = query.trim();
      const hasQuery = !!trimmedQuery;

      // An exact task id resolves in ONE request. The paged path below can only
      // ever see the first MAX_SEARCH_PAGES * 100 tasks of a list, so on a list
      // bigger than that, searching for an older task returned nothing at all
      // even though the task existed. A direct read has no such horizon.
      if (hasQuery) {
        const direct = await this.lookupTaskById(settings, trimmedQuery);
        if (direct) return { success: true, data: [direct] };
      }

      // When there's a text query, fetch all pages (ClickUp has no server-side text search).
      // When just browsing/filtering, use single-page pagination.
      if (hasQuery) {
        const allCacheKey = `search-all-${targetListId}-${params.toString()}`;
        const cached = cacheGet(allCacheKey);
        let allTasks: any[];

        if (cached) {
          allTasks = cached;
        } else {
          allTasks = [];
          // Pages in parallel chunks (the rate gate caps real concurrency) —
          // serial paging made the first text search wait out up to 10
          // round-trips. A page under 100 tasks is the last one.
          const PAGE_CHUNK = 5;
          let lastPageSeen = false;
          for (let start = 0; start < MAX_SEARCH_PAGES && !lastPageSeen; start += PAGE_CHUNK) {
            const pageNums = Array.from(
              { length: Math.min(PAGE_CHUNK, MAX_SEARCH_PAGES - start) },
              (_, i) => start + i,
            );
            const pages = await Promise.all(
              pageNums.map((p) =>
                clickUpFetch(
                  settings.clickupApiKey,
                  `/list/${targetListId}/task?${params.toString()}&page=${p}`,
                ),
              ),
            );
            for (const data of pages) {
              const pageTasks = data.tasks || [];
              allTasks.push(...pageTasks);
              if (pageTasks.length < 100) {
                lastPageSeen = true;
                break;
              }
            }
          }
          cacheSet(allCacheKey, allTasks);
        }

        const q = query.toLowerCase();
        const filtered = allTasks.filter(
          (t: any) =>
            t.name?.toLowerCase().includes(q) ||
            t.custom_id?.toLowerCase().includes(q) ||
            t.text_content?.toLowerCase().includes(q) ||
            t.description?.toLowerCase().includes(q),
        );

        return { success: true, data: filtered.map(normalizeClickUpTask) };
      }

      // No text query — single page for infinite scroll
      const cacheKey = `search-${targetListId}-${params.toString()}-${page}`;
      const cached = cacheGet(cacheKey);
      let tasks: any[];

      if (cached) {
        tasks = cached;
      } else {
        const data = await clickUpFetch(
          settings.clickupApiKey,
          `/list/${targetListId}/task?${params.toString()}&page=${page}`,
        );
        tasks = data.tasks || [];
        cacheSet(cacheKey, tasks);
      }

      return { success: true, data: tasks.map(normalizeClickUpTask) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to search tasks',
      };
    }
  }

  /**
   * Resolve a query that is itself a task id — custom (DP2-21173) or raw
   * (86d28ttjq) — with a single read, bypassing the paged text search.
   *
   * Returns undefined when the query is not id-shaped or no such task exists,
   * in which case the caller falls back to the paged scan. Both outcomes are
   * cached: a typed-in id arrives one keystroke at a time, and every prefix
   * would otherwise re-issue its own failing lookup.
   */
  private async lookupTaskById(
    settings: AppSettings,
    query: string,
  ): Promise<TaskManagerTask | undefined> {
    const isCustom = CUSTOM_TASK_ID_RE.test(query);
    if (!isCustom && !RAW_TASK_ID_RE.test(query)) return undefined;

    const teamId = settings.clickupWorkspaceId;
    // Custom ids are only resolvable with a workspace to scope them to.
    if (isCustom && !teamId) return undefined;

    const cacheKey = `id-lookup-${isCustom ? `${teamId}:` : ''}${query}`;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached === null ? undefined : cached;

    const endpoint = isCustom
      ? `/task/${encodeURIComponent(query)}?custom_task_ids=true&team_id=${teamId}`
      : `/task/${encodeURIComponent(query)}`;

    try {
      const raw = await clickUpFetch(settings.clickupApiKey, endpoint);
      const task = normalizeClickUpTask(raw);
      cacheSet(cacheKey, task);
      debugLog(`[ClickUp] Resolved "${query}" by id in 1 request`);
      return task;
    } catch {
      // No such task (404) or the id was a false positive — remember the miss
      // so the next keystroke does not repeat it, and let the caller page.
      cacheSet(cacheKey, null);
      return undefined;
    }
  }

  /**
   * Fetch every task sitting in the given statuses across several lists at
   * once, for the Code Review page.
   *
   * Paging each list separately costs at least one request per list — twelve
   * selected lists is twelve requests, gated to four at a time, so three
   * round-trips elapse before a single PR is looked up. The "filtered team
   * tasks" endpoint accepts `list_ids[]`, so the same set comes back 100 at a
   * time no matter how many lists it spans.
   */
  async searchTasksInLists(
    settings: AppSettings,
    statuses: string[],
    listIds: string[],
  ): Promise<ProviderResult<TaskManagerTask[]>> {
    try {
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const ids = [...new Set(listIds.map((id) => (id || '').trim()).filter(Boolean))];
      if (ids.length === 0) throw new Error('No list ID configured');

      const sortedIds = [...ids].sort();
      const cacheKey = `review-tasks-${sortedIds.join(',')}-${[...statuses].sort().join(',')}`;
      const cached = cacheGet(cacheKey);
      if (cached) return { success: true, data: cached.map(normalizeClickUpTask) };

      const params = new URLSearchParams();
      params.set('include_closed', 'false');
      params.set('subtasks', 'true');
      for (const s of statuses) params.append('statuses[]', s);
      for (const id of ids) params.append('list_ids[]', id);

      // Pages in parallel chunks. Strictly serial paging cost one full
      // round-trip per page before the next could start — two ~750ms requests
      // back to back for a set that arrives in one.
      //
      // The chunk is deliberately 2, not larger: every page in a chunk is
      // fired before any of them answers, so a chunk wider than the data costs
      // requests that come back empty. Two covers 200 tasks in review statuses
      // in a single round-trip, which is the realistic case; beyond that the
      // next chunk is issued only because the previous one was genuinely full.
      const all: any[] = [];
      const PAGE_CHUNK = 2;
      let lastPageSeen = false;
      for (let start = 0; start < MAX_REVIEW_PAGES && !lastPageSeen; start += PAGE_CHUNK) {
        const pageNums = Array.from(
          { length: Math.min(PAGE_CHUNK, MAX_REVIEW_PAGES - start) },
          (_, i) => start + i,
        );
        const pages = await Promise.all(
          pageNums.map((page) =>
            clickUpFetch(
              settings.clickupApiKey,
              `/team/${teamId}/task?${params.toString()}&page=${page}`,
            ),
          ),
        );
        for (const data of pages) {
          const tasks: any[] = data.tasks || [];
          all.push(...tasks);
          // ClickUp states this outright; the length check is a fallback for
          // endpoints/versions that omit the flag. Trusting `last_page` also
          // avoids a needless extra chunk when a final page holds exactly 100.
          if (data.last_page === true || tasks.length < 100) {
            lastPageSeen = true;
            break;
          }
        }
      }

      cacheSet(cacheKey, all);
      debugLog(`[ClickUp] Review fetch: ${all.length} task(s) across ${ids.length} list(s)`);
      return { success: true, data: all.map(normalizeClickUpTask) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch tasks across lists',
      };
    }
  }

  async getTask(settings: AppSettings, taskId: string): Promise<ProviderResult<TaskManagerTask>> {
    try {
      const data = await fetchTaskRaw(settings, taskId);
      return { success: true, data: normalizeClickUpTask(data) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch task',
      };
    }
  }

  /**
   * Bulk-read many tasks with as few requests as possible, for the snapshot
   * refreshes that keep the Kanban board in step with ClickUp.
   *
   * One request per task blows the 100/min token budget on any board with ~100
   * tracked tasks, so this uses the list-scoped "filtered team tasks" endpoint
   * (100 tasks/page, `list_ids[]` accepts several lists at once). `task_ids[]`
   * is not supported by the API, hence the list-then-match approach. After the
   * first full page-through the result is kept in a persistent store and later
   * calls only fetch tasks updated since the last sync (`date_updated_gt`) —
   * normally a single small request — merging them over the stored snapshots.
   *
   * Returns a map of ClickUp task id → task, covering as many of `refs` as were
   * found. Callers MUST fall back to `getTask` for anything missing (archived
   * tasks, a list bigger than the page cap, or a task in an unknown list).
   *
   * NOTE: results are deliberately NOT shared with `getTask`'s cache — the
   * bulk payload is only trusted for the snapshot fields (name/status/assignees/
   * priority/tags/release version), not for `description`, which agent prompts
   * read via `getTask`.
   */
  async getTaskSnapshots(
    settings: AppSettings,
    refs: Array<{ taskId: string; listId?: string }>,
  ): Promise<ProviderResult<Record<string, TaskManagerTask>>> {
    try {
      // Below this, individual reads are cheaper than paging whole lists.
      if (refs.length < MIN_BULK_SNAPSHOT_TASKS) return { success: true, data: {} };

      const teamId = settings.clickupWorkspaceId;
      if (!teamId) return { success: true, data: {} };

      // Lists we know tracked tasks live in, plus the configured board lists as
      // a fallback for tasks whose list hasn't been recorded yet.
      const listIds = [
        ...new Set(
          [
            ...refs.map((r) => r.listId),
            settings.clickupListId,
            settings.kanbanBacklogListId,
          ]
            .map((id) => (id || '').trim())
            .filter(Boolean),
        ),
      ];
      if (listIds.length === 0) return { success: true, data: {} };

      const storeKey = [...listIds].sort().join(',');
      const cacheKey = `snapshots-${storeKey}`;
      const cached = cacheGet(cacheKey);
      if (cached) return { success: true, data: cached };

      const params = new URLSearchParams();
      params.set('include_closed', 'true');
      params.set('subtasks', 'true');
      // Most-recently-updated first — tracked board tasks are the active ones,
      // so a full sync usually covers them all within a page or two.
      params.set('order_by', 'updated');
      for (const id of listIds) params.append('list_ids[]', id);

      const wanted = new Set(refs.map((r) => r.taskId));
      const syncStart = Date.now();
      const store = snapshotStores.get(storeKey);
      const fullSync = !store || syncStart - store.fullSyncMs >= SNAPSHOT_FULL_RESYNC_MS;
      if (!fullSync) {
        params.set(
          'date_updated_gt',
          String(Math.max(0, store.lastSyncMs - SNAPSHOT_WATERMARK_OVERLAP_MS)),
        );
      }

      // Full sync rebuilds the store; incremental merges updates into it, so
      // unchanged tasks keep serving their last-known snapshot with zero
      // additional requests.
      const byId = fullSync ? new Map<string, TaskManagerTask>() : store.byId;
      let pages = 0;

      for (let page = 0; page < MAX_SNAPSHOT_PAGES; page++) {
        const data = await clickUpFetch(
          settings.clickupApiKey,
          `/team/${teamId}/task?${params.toString()}&page=${page}`,
          {},
          true, // background — never starve interactive requests
        );
        const tasks: any[] = data.tasks || [];
        pages++;
        for (const raw of tasks) {
          byId.set(raw.id, normalizeClickUpTask(raw));
        }
        // Last page reached, or (on a full sync) every tracked task seen.
        if (tasks.length < 100) break;
        if (fullSync && [...wanted].every((id) => byId.has(id))) break;
      }

      snapshotStores.set(storeKey, {
        byId,
        lastSyncMs: syncStart,
        fullSyncMs: fullSync ? syncStart : store.fullSyncMs,
      });

      const result: Record<string, TaskManagerTask> = {};
      for (const id of wanted) {
        const hit = byId.get(id);
        if (hit) result[id] = hit;
      }

      cacheSet(cacheKey, result);
      debugLog(
        `[ClickUp] Snapshot ${fullSync ? 'full' : 'incremental'} sync: ${Object.keys(result).length}/${wanted.size} task(s) in ${pages} request(s) across ${listIds.length} list(s)`,
      );
      return { success: true, data: result };
    } catch (error) {
      // Non-fatal: callers fall back to per-task reads.
      debugError('[ClickUp] Snapshot batch failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch-fetch tasks',
      };
    }
  }

  async createTask(settings: AppSettings, listId: string, taskData: any): Promise<ProviderResult<TaskManagerTask>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/list/${listId}/task`, {
        method: 'POST',
        body: JSON.stringify(taskData),
      });
      return { success: true, data: normalizeClickUpTask(data) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task',
      };
    }
  }

  async postComment(settings: AppSettings, taskId: string, comment: string): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}/comment`, {
        method: 'POST',
        body: JSON.stringify({ comment_text: comment }),
      });
      taskCache.delete(`comments-${taskId}`);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to post comment',
      };
    }
  }

  async updateStatus(settings: AppSettings, taskId: string, status: string): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      invalidateTask(taskId);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update status',
      };
    }
  }

  async postTimeEntry(
    settings: AppSettings,
    taskId: string,
    startMs: number,
    durationMs: number,
    description?: string,
  ): Promise<ProviderResult<any>> {
    try {
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const body: any = { tid: taskId, start: startMs, duration: durationMs };
      if (description) body.description = description;

      const data = await clickUpFetch(settings.clickupApiKey, `/team/${teamId}/time_entries`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to post time entry',
      };
    }
  }

  async addTag(settings: AppSettings, taskId: string, tagName: string): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}/tag/${encodeURIComponent(tagName)}`, {
        method: 'POST',
      });
      invalidateTask(taskId);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add tag',
      };
    }
  }

  async removeTag(settings: AppSettings, taskId: string, tagName: string): Promise<ProviderResult<any>> {
    try {
      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}/tag/${encodeURIComponent(tagName)}`, {
        method: 'DELETE',
      });
      invalidateTask(taskId);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to remove tag',
      };
    }
  }

  /** Cached for CACHE_TTL. A task's thread is read up to three times in one
   *  pass over it — the approval-comment check, the PR-URL scan and the review
   *  context all want it — and those reads are sequential, so request
   *  coalescing never caught them. Writes go through `postComment`, which
   *  invalidates the entry. */
  async getComments(settings: AppSettings, taskId: string): Promise<ProviderResult<any[]>> {
    try {
      const cacheKey = `comments-${taskId}`;
      const cached = cacheGet(cacheKey);
      if (cached) return { success: true, data: cached };

      const data = await clickUpFetch(settings.clickupApiKey, `/task/${taskId}/comment`);
      const comments = data.comments || [];
      cacheSet(cacheKey, comments);
      return { success: true, data: comments };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch comments',
      };
    }
  }

  async getTimeEntries(settings: AppSettings, taskId: string): Promise<ProviderResult<{ totalMs: number; todayMs: number; entries: any[] }>> {
    try {
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const data = await clickUpFetch(settings.clickupApiKey, `/team/${teamId}/time_entries?task_id=${taskId}`);
      const entries = data.data || [];
      const totalMs = entries.reduce((sum: number, e: any) => sum + Number(e.duration || 0), 0);

      // Compute today's tracked time
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const todayMs = entries.reduce((sum: number, e: any) => {
        const start = Number(e.start || 0);
        const dur = Number(e.duration || 0);
        if (start >= todayStart) return sum + dur;
        // Entry started before today but may overlap into today
        const end = start + dur;
        if (end > todayStart) return sum + (end - todayStart);
        return sum;
      }, 0);

      return { success: true, data: { totalMs, todayMs, entries } };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get time entries',
      };
    }
  }

  async getTaskStatuses(settings: AppSettings, taskId: string): Promise<ProviderResult<{ name: string; color: string }[]>> {
    try {
      // Fetch the task to get its list.id, then fetch that list for statuses
      const task = await fetchTaskRaw(settings, taskId);
      const listId = task.list?.id;
      if (!listId) throw new Error('Could not determine task list');

      return this.getListStatuses(settings, listId);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get statuses',
      };
    }
  }

  async getWorkspaceMembers(settings: AppSettings): Promise<ProviderResult<WorkspaceMember[]>> {
    try {
      const teamId = settings.clickupWorkspaceId;
      if (!teamId) throw new Error('Workspace ID not configured');

      const cacheKey = `members-${teamId}`;
      const cached = cacheGet(cacheKey, STATIC_CACHE_TTL);
      if (cached) return { success: true, data: cached };

      const data = await clickUpFetch(settings.clickupApiKey, `/team/${teamId}`);
      const members: WorkspaceMember[] = (data.team?.members || []).map((m: any) => {
        const user = m.user || {};
        return {
          id: String(user.id),
          username: user.username || user.email || 'Unknown',
          email: user.email,
          initials: user.initials,
          color: user.color,
          profilePicture: user.profilePicture,
        };
      });

      // De-duplicate by id (some ClickUp workspaces return duplicates across groups)
      const seen = new Set<string>();
      const unique = members.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      // Sort alphabetically by username for stable dropdowns
      unique.sort((a, b) => a.username.localeCompare(b.username));

      cacheSet(cacheKey, unique);
      return { success: true, data: unique };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch workspace members',
      };
    }
  }

  async getListStatuses(settings: AppSettings, listId: string): Promise<ProviderResult<{ name: string; color: string }[]>> {
    try {
      if (!listId) throw new Error('List ID is required');

      const cacheKey = `list-statuses-${listId}`;
      const cached = cacheGet(cacheKey, STATIC_CACHE_TTL);
      if (cached) return { success: true, data: cached };

      const list = await clickUpFetch(settings.clickupApiKey, `/list/${listId}`);
      const statuses: { name: string; color: string }[] = (list.statuses || []).map((s: any) => ({
        name: s.status as string,
        color: (s.color as string) || '#999',
      }));
      cacheSet(cacheKey, statuses);
      return { success: true, data: statuses };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get list statuses',
      };
    }
  }
}
