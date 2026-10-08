/**
 * How a ClickUp attachment URL should be handed to the browser.
 *
 * ClickUp serves attachments with `Content-Disposition: attachment`, so opening
 * the raw URL saves a file instead of showing it — clicking a screenshot to
 * "open in browser" downloaded it. Its own viewer appends `view=open`, which
 * flips the header to `inline`; verified against a live attachment host.
 *
 * Normalising here rather than at upload time is deliberate: it also covers
 * images teammates posted from ClickUp's own client, which write the bare URL
 * into the message exactly like we do.
 */
const ATTACHMENT_HOST = /(^|\.)clickup-attachments\.com$/i;

export function viewableAttachmentUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!ATTACHMENT_HOST.test(url.hostname)) return raw;
    if (!url.searchParams.has('view')) url.searchParams.set('view', 'open');
    return url.toString();
  } catch {
    // Not a parseable URL — pass it through untouched rather than swallowing it.
    return raw;
  }
}

/** How many times a broken image is re-requested before giving up. */
export const MAX_IMAGE_RETRIES = 3;

/** Backoff between retries, multiplied by the attempt number. */
export const IMAGE_RETRY_DELAY_MS = 1200;

/** A distinct URL per attempt, so a cached failure isn't what gets retried.
 *  ClickUp ignores unknown query params on the attachment host. */
export function retryUrl(raw: string, attempt: number): string {
  if (attempt <= 0) return raw;
  return `${raw}${raw.includes('?') ? '&' : '?'}_retry=${attempt}`;
}
