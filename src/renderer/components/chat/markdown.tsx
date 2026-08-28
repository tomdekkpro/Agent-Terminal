import { useCallback, useEffect, useRef, useState } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { FileText, Image as ImageIcon, Mail, Ticket } from 'lucide-react';
import { useChatStore } from '../../stores/chat-store';
import { describeLink } from './link-label';
import {
  IMAGE_RETRY_DELAY_MS,
  MAX_IMAGE_RETRIES,
  retryUrl,
  viewableAttachmentUrl,
} from './attachment-url';
import { cn } from '../../../shared/utils';

function MarkdownLink({ href, children }: { href?: string; children: React.ReactNode }) {
  const target = href || '';
  // React children → plain text, so a self-link can be recognised.
  const text = typeof children === 'string'
    ? children
    : Array.isArray(children)
      ? children.filter((c) => typeof c === 'string').join('')
      : '';
  const { label, kind } = describeLink(target, text);

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (target) window.electronAPI.openExternal(viewableAttachmentUrl(target));
  };

  // A ClickUp @mention. It has no destination, so it must not look clickable.
  if (kind === 'mention') {
    return (
      <span className="px-1 rounded bg-[var(--accent)]/15 text-[var(--accent)] font-medium">
        {label}
      </span>
    );
  }

  // Markdown autolinked a filename. Show the text the author actually wrote.
  if (kind === 'plain') {
    return <span className="font-mono text-[0.95em] text-[var(--text-secondary)]">{label}</span>;
  }

  if (kind === 'authored') {
    return (
      <button onClick={open} title={target} className="text-[var(--accent)] hover:underline break-words text-left">
        {children}
      </button>
    );
  }

  // A bare URL becomes a compact chip — it reads as one object rather than a
  // wall of characters, and the full target is still one hover away.
  const Icon = kind === 'task' ? Ticket : kind === 'mail' ? Mail : null;
  return (
    <button
      onClick={open}
      title={target}
      className={cn(
        'inline-flex items-center gap-1 align-baseline px-1.5 py-px rounded-md max-w-full',
        'text-[0.95em] font-medium border transition-colors',
        kind === 'task'
          ? 'bg-[var(--clickup-purple)]/15 border-[var(--clickup-purple)]/30 text-[var(--clickup-purple)] hover:bg-[var(--clickup-purple)]/25'
          : 'bg-[var(--bg-tertiary)] border-[var(--border)] text-[var(--accent)] hover:border-[var(--accent)]/50',
      )}
    >
      {Icon && <Icon className="w-3 h-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * An image pasted into a message. Clicking opens the in-app viewer rather than
 * a browser: a screenshot is usually the point of the message, and bouncing to
 * an external window to read it loses the conversation around it.
 *
 * A just-uploaded attachment can miss for a second or two before ClickUp's CDN
 * serves it, so the first failures are retried with a short backoff. Latching
 * on the first `onError` left the message showing a text chip for the rest of
 * the session — long after the image had become fetchable.
 */
function InlineImage({ src, alt }: { src?: string; alt?: string }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const openLightbox = useChatStore((s) => s.openLightbox);

  // A new src is a new image: whatever state the last one ended in is stale.
  useEffect(() => {
    attemptRef.current = 0;
    setAttempt(0);
    setFailed(false);
    return () => window.clearTimeout(timerRef.current);
  }, [src]);

  const onError = useCallback(() => {
    if (attemptRef.current >= MAX_IMAGE_RETRIES) {
      setFailed(true);
      return;
    }
    const next = ++attemptRef.current;
    timerRef.current = window.setTimeout(() => setAttempt(next), IMAGE_RETRY_DELAY_MS * next);
  }, []);

  if (!src) return null;

  if (failed) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          window.electronAPI.openExternal(viewableAttachmentUrl(src));
        }}
        title={src}
        className="my-1 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)]"
      >
        <ImageIcon className="w-3.5 h-3.5" />
        {alt || 'Image'} — open in browser
      </button>
    );
  }

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        openLightbox(src, alt);
      }}
      title={alt ? `${alt} — click to view` : 'Click to view'}
      className="block my-1.5 rounded-lg overflow-hidden border border-[var(--border)] hover:border-[var(--accent)]/50 transition-colors"
    >
      <img
        src={retryUrl(src, attempt)}
        alt={alt || ''}
        loading="lazy"
        onError={onError}
        className="max-h-72 max-w-full object-contain"
      />
    </button>
  );
}

/**
 * Remark plugins shared by every surface that renders a message.
 *
 * `remark-breaks` is the important one. ClickUp Chat content is chat text, not
 * prose: a message is `"Hi
Yes, I will remove it now"`, and pasted tables are
 * rows separated by single newlines and aligned with non-breaking spaces.
 * Standard Markdown treats a lone newline as a space, which runs every one of
 * those lines together into a paragraph — a pasted table came out as one long
 * smear. Hard-breaking on single newlines is what ClickUp's own client does.
 */
export const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/** Markdown renderers shared by the transcript, threads and the AI panel. */
export const MARKDOWN_COMPONENTS = {
  a: ({ href, children }: any) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ src, alt }: any) => <InlineImage src={src} alt={alt} />,
  // ClickUp posts often paste in whole emails; a fenced block inside one
  // should scroll rather than force the whole column wider.
  pre: ({ children }: any) => (
    <pre className="overflow-x-auto rounded-lg bg-[var(--bg-primary)] border border-[var(--border)] p-2 my-1.5 text-[12px]">
      {children}
    </pre>
  ),
  table: ({ children }: any) => (
    <div className="overflow-x-auto my-1.5">
      <table>{children}</table>
    </div>
  ),
};

/** Non-image attachment links keep a paperclip so they read as files. */
export function FileChip({ href, name }: { href: string; name: string }) {
  return (
    <button
      onClick={() => window.electronAPI.openExternal(href)}
      title={href}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--accent)]"
    >
      <FileText className="w-3.5 h-3.5" />
      {name}
    </button>
  );
}
