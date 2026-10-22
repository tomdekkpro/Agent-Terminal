import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ArrowLeft, Loader2, Send, X } from 'lucide-react';
import type { ChatMessage, ChatUser } from '../../../shared/types';
import type { ThreadState } from '../../stores/chat-store';
import { cn } from '../../../shared/utils';
import { Avatar } from './Avatar';
import { MARKDOWN_COMPONENTS, REMARK_PLUGINS } from './markdown';

const WIDTH_STORAGE_KEY = 'chat-thread-width';
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 340;

function loadWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved;
  } catch {
    // Falls through to the default.
  }
  return DEFAULT_WIDTH;
}

const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ThreadMessage({ message, me }: { message: ChatMessage; me: ChatUser | null }) {
  const mine = !!me && message.user.id === me.id;
  return (
    <div className="flex gap-2.5 px-3 py-2">
      <Avatar user={message.user} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className={cn('text-[12px] font-semibold', mine ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]')}>
            {mine ? 'You' : message.user.username}
          </span>
          <span className="text-[10px] text-[var(--text-muted)] tabular-nums">{clockTime(message.createdAtMs)}</span>
        </div>
        <div className="insights-prose text-[12px] leading-relaxed text-[var(--text-primary)] break-words">
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {message.content || '_(no text)_'}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

interface ThreadPanelProps {
  parent: ChatMessage;
  thread: ThreadState;
  me: ChatUser | null;
  onClose: () => void;
  onSend: (text: string) => Promise<boolean>;
  /** Fill the host instead of managing a resizable width. Used by the dock,
   *  which is already narrow — there a thread replaces the transcript rather
   *  than splitting what little width there is. */
  fill?: boolean;
}

/** Replies to one message, in a column beside the transcript so the room stays
 *  visible — a thread you have to leave the channel to read gets forgotten. */
export function ThreadPanel({ parent, thread, me, onClose, onSend, fill }: ThreadPanelProps) {
  const [draft, setDraft] = useState('');
  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // The panel's right edge is fixed while dragging, so capture it once —
    // reading it per move would chase the element as it resizes.
    const rightEdge = panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      setWidth(Math.min(Math.max(rightEdge - ev.clientX, MIN_WIDTH), MAX_WIDTH));
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setWidth((current) => {
        try {
          localStorage.setItem(WIDTH_STORAGE_KEY, String(current));
        } catch {
          // Layout preference only.
        }
        return current;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [thread.messages]);

  useEffect(() => {
    setDraft('');
    textareaRef.current?.focus();
  }, [parent.id]);

  const send = async () => {
    const text = draft.trim();
    if (!text || thread.sending) return;
    const ok = await onSend(text);
    if (ok) setDraft('');
  };

  return (
    <div
      ref={panelRef}
      style={fill ? undefined : { width }}
      className={cn(
        'h-full flex bg-[var(--bg-secondary)]/40',
        fill ? 'flex-1 min-w-0' : 'shrink-0 border-l border-[var(--border)]',
        dragging && 'select-none',
      )}
    >
      {/* Drag the left edge to give the thread more room. Absent in fill mode,
          where the host already owns the width. */}
      {!fill && (
        <div
          onMouseDown={startResize}
          title="Drag to resize"
          className={cn(
            'w-1 shrink-0 cursor-col-resize relative transition-colors',
            dragging ? 'bg-[var(--accent)]' : 'bg-transparent hover:bg-[var(--accent)]',
          )}
        >
          {/* Widens the grab target without widening the visible line. */}
          <div className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" />
        </div>
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
          {fill && (
            <button
              onClick={onClose}
              title="Back to the conversation"
              className="p-1 -ml-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-[12px] font-semibold text-[var(--text-primary)]">Thread</span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {thread.messages.length} {thread.messages.length === 1 ? 'reply' : 'replies'}
          </span>
          {!fill && (
            <button
              onClick={onClose}
              className="ml-auto p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {/* The message the thread hangs off, pinned at the top for context. */}
          <div className="bg-[var(--bg-tertiary)]/40 border-b border-[var(--border)]">
            <ThreadMessage message={parent} me={me} />
          </div>

          {thread.loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-[var(--text-muted)] text-xs">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading replies…
            </div>
          )}

          {thread.error && (
            <p className="m-3 p-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[11px] text-[var(--error)]">
              {thread.error}
            </p>
          )}

          {!thread.loading && thread.messages.length === 0 && !thread.error && (
            <p className="px-3 py-4 text-[11px] text-[var(--text-muted)] text-center">
              No replies yet — start the thread below.
            </p>
          )}

          {thread.messages.map((message) => (
            <ThreadMessage key={message.id} message={message} me={me} />
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="flex items-end gap-2 p-2 border-t border-[var(--border)] shrink-0">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Reply in thread…"
            className="flex-1 resize-none bg-[var(--bg-tertiary)] rounded-lg px-2.5 py-2 text-[12px] outline-none border border-transparent focus:border-[var(--accent)]/50 placeholder:text-[var(--text-muted)] max-h-32"
          />
          <button
            onClick={send}
            disabled={!draft.trim() || thread.sending}
            className={cn(
              'p-2 rounded-lg shrink-0',
              draft.trim() && !thread.sending
                ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
            )}
          >
            {thread.sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Swallows mouse events mid-drag so the transcript underneath doesn't
          start a text selection while the panel is being resized. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}
