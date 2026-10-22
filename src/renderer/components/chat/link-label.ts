/**
 * How a link should read once it's on screen.
 *
 * ClickUp's Markdown is full of self-links — `[https://…](https://…)` — because
 * that is what its editor emits when someone pastes a URL. A third of the
 * messages in a real workspace contain one, and rendered literally they put a
 * 90-character URL in the middle of a sentence and blow out the column width.
 * A link whose text is just its own href gets a short, meaningful label
 * instead; a link someone actually wrote text for is left alone.
 *
 * Kept free of React so it can be exercised on its own.
 */
export type LinkKind = 'authored' | 'task' | 'mail' | 'url' | 'mention' | 'plain';

export interface LinkLabel {
  label: string;
  kind: LinkKind;
}

/** Longest path fragment kept before elision. */
const MAX_PATH = 24;

/** ClickUp encodes @mentions as pseudo-links whose href is an internal token
 *  (`#user_mention#89027999`). They must render as chips, never as something
 *  clickable — "opening" one would hand a non-URL to the browser. */
const MENTION_TOKEN = /^#[a-z_]*mention[a-z_]*#/i;

/** Suffixes that make a bare dotted word a real address rather than a filename.
 *  GitHub-flavoured Markdown autolinks any `foo.bar` it sees, which turns
 *  `CLAUDE.md` and `Web.Host` — both common in dev chat — into dead links to
 *  http://CLAUDE.md. Anything outside this list stays plain text. */
const REAL_TLDS = new Set([
  'com', 'net', 'org', 'io', 'dev', 'app', 'ai', 'co', 'me', 'sh', 'cloud',
  'no', 'se', 'dk', 'fi', 'uk', 'de', 'nl', 'fr', 'es', 'it', 'pl', 'eu', 'vn',
]);

export function describeLink(href: string, text: string): LinkLabel {
  const target = (href || '').trim();
  const written = (text || '').trim();

  // Order matters. Each of these recognises the link by its HREF, so they all
  // have to run before the "author wrote their own text" shortcut below —
  // a mention and a filename both have text that differs from their href.

  // 1. ClickUp mention pseudo-link. Chip, never clickable.
  if (MENTION_TOKEN.test(target)) {
    return { label: written || 'mention', kind: 'mention' };
  }

  // 2. A bare dotted word Markdown turned into http://CLAUDE.md. The author
  //    wrote a filename; render what they wrote, unlinked.
  const bare = target.match(/^http:\/\/([^/?#]+)\/?$/i);
  if (
    bare &&
    written.toLowerCase() === bare[1].toLowerCase() &&
    !REAL_TLDS.has((bare[1].split('.').pop() || '').toLowerCase())
  ) {
    return { label: written, kind: 'plain' };
  }

  // 3. Email, so it can carry a mail icon rather than reading as a web link.
  if (target.startsWith('mailto:')) {
    return { label: target.slice(7) || written || target, kind: 'mail' };
  }

  // 4. ClickUp task link — the ticket id is the only part anyone reads. A
  //    custom id's letter half can contain digits ("DP2"), so the class must
  //    allow them after the first character, or DP2-25983 truncates to "DP2".
  const task = target.match(/app\.clickup\.com\/t\/(?:\d+\/)?([A-Za-z][A-Za-z0-9]*-\d+|[A-Za-z0-9]+)/i);
  if (task) return { label: task[1], kind: 'task' };

  // 5. Someone wrote real link text — never second-guess it.
  if (written && written !== target && !/^https?:\/\//i.test(written)) {
    return { label: written, kind: 'authored' };
  }

  // 6. A naked URL: shorten it to host + a slice of path.
  try {
    const url = new URL(target);
    const host = url.host.replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return { label: host, kind: 'url' };
    const shortPath = path.length > MAX_PATH ? `${path.slice(0, MAX_PATH)}…` : path;
    return { label: `${host}${shortPath}`, kind: 'url' };
  } catch {
    // Not a parseable URL — fall back to whatever text there was.
    return { label: written || target, kind: 'url' };
  }
}
