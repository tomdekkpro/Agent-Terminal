import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Languages,
  Loader2,
  MessageSquare,
  Plus,
  ScrollText,
  Smile,
  Sparkles,
  Terminal as TerminalIcon,
  Ticket,
} from 'lucide-react';
import type { ChatMessage, ChatUser } from '../../../shared/types';
import { cn } from '../../../shared/utils';
import { Avatar } from './Avatar';
import { MARKDOWN_COMPONENTS, REMARK_PLUGINS } from './markdown';

/** Reactions worth one click. Everything else stays in ClickUp — a full emoji
 *  picker is a lot of surface for something a dev team uses five of. */
const QUICK_REACTIONS = ['+1', 'white_check_mark', 'eyes', 'tada', 'pray'];
const REACTION_GLYPHS: Record<string, string> = {
  '+1': '👍',
  '-1': '👎',
  white_check_mark: '✅',
  eyes: '👀',
  tada: '🎉',
  pray: '🙏',
  heart: '❤️',
  rocket: '🚀',
};

const glyph = (reaction: string) => REACTION_GLYPHS[reaction] || `:${reaction}:`;

/** Messages this close together from the same person render as one block. */
const GROUP_WINDOW_MS = 5 * 60_000;

/** Past either of these, a message is collapsed behind "Show more". Team
 *  announcements run to several thousand characters, and — now that single
 *  newlines are real line breaks — a pasted table is tall while being short,
 *  so height has to be judged on lines as well as characters. */
const COLLAPSE_CHARS = 900;
const COLLAPSE_LINES = 16;

function dayLabel(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 24 * 3_600_000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

const clockTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

interface MessageActions {
  onOpenThread: (message: ChatMessage) => void;
  onReact: (messageId: string, reaction: string) => void;
  /** Pull this message's real reaction counts before the picker is used —
   *  ClickUp ships none with the message list. */
  onLoadReactions: (messageId: string) => void;
  onTranslate: (text: string) => void;
  onExplain: (text: string) => void;
  onQuote: (message: ChatMessage) => void;
  onCreateTask: (message: ChatMessage) => void;
  onSendToAgent?: (text: string) => void;
}

function MessageRow({
  message,
  me,
  grouped,
  actions,
}: {
  message: ChatMessage;
  me: ChatUser | null;
  grouped: boolean;
  actions: MessageActions;
}) {
  const [copied, setCopied] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const body = message.content || '';
  const collapsible =
    body.length > COLLAPSE_CHARS || body.split('\n').length > COLLAPSE_LINES;
  const mine = !!me && message.user.id === me.id;
  const pending = message.id.startsWith('pending:');

  const copy = useCallback(() => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [message.content]);

  return (
    <div
      className={cn(
        'group relative flex gap-2.5 px-4 hover:bg-[var(--bg-secondary)]/40',
        grouped ? 'py-0.5' : 'pt-3 pb-0.5',
        pending && 'opacity-60',
      )}
      data-message-id={message.id}
    >
      {/* Gutter: avatar on the first message of a block, timestamp on the rest */}
      <div className="w-7 shrink-0 flex justify-center">
        {grouped ? (
          <span className="text-[9px] text-[var(--text-muted)] opacity-0 group-hover:opacity-100 pt-1 tabular-nums">
            {clockTime(message.createdAtMs)}
          </span>
        ) : (
          <Avatar user={message.user} size="sm" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        {!grouped && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className={cn('text-[13px] font-semibold', mine ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]')}>
              {mine ? 'You' : message.user.username}
            </span>
            <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
              {clockTime(message.createdAtMs)}
            </span>
            {message.type === 'post' && message.postTitle && (
              <span className="px-1.5 py-px rounded bg-[var(--accent)]/15 text-[var(--accent)] text-[9px] font-medium">
                {message.postTitle}
              </span>
            )}
            {pending && <Loader2 className="w-3 h-3 animate-spin text-[var(--text-muted)]" />}
          </div>
        )}

        <div className="relative">
          <div
            className={cn(
              'insights-prose text-[13px] leading-relaxed text-[var(--text-primary)] break-words',
              collapsible && !expanded && 'max-h-52 overflow-hidden',
            )}
          >
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
              {message.content || '_(no text)_'}
            </ReactMarkdown>
          </div>
          {collapsible && !expanded && (
            // Fades the clipped edge so it reads as "there is more" rather
            // than as a message that just stops mid-sentence.
            <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--bg-primary)] to-transparent pointer-events-none" />
          )}
          {collapsible && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>

        {/* Reactions */}
        {(message.reactions?.length || 0) > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {message.reactions!.map((r) => (
              <button
                key={r.reaction}
                onClick={() => actions.onReact(message.id, r.reaction)}
                className={cn(
                  'px-1.5 py-0.5 rounded-full text-[11px] border transition-colors',
                  r.mine
                    ? 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]'
                    : 'bg-[var(--bg-tertiary)] border-transparent text-[var(--text-secondary)] hover:border-[var(--border-strong)]',
                )}
              >
                {glyph(r.reaction)} {r.count}
              </button>
            ))}
          </div>
        )}

        {/* Thread affordance */}
        {message.replyCount > 0 && (
          <button
            onClick={() => actions.onOpenThread(message)}
            className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--accent)] hover:underline"
          >
            <MessageSquare className="w-3 h-3" />
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
      </div>

      {/* Hover toolbar */}
      {!pending && (
        <div className="absolute right-3 -top-3 hidden group-hover:flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] shadow-[var(--shadow-float)] z-10">
          <div className="relative">
            <button
              onClick={() => {
                const opening = !reactOpen;
                setReactOpen(opening);
                // Counts are fetched per message, so only when someone looks.
                if (opening && message.reactions === undefined) actions.onLoadReactions(message.id);
              }}
              title="React"
              className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)]"
            >
              <Smile className="w-3.5 h-3.5" />
            </button>
            {reactOpen && (
              <div className="absolute right-0 top-full mt-1 flex gap-0.5 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] shadow-[var(--shadow-float)]">
                {QUICK_REACTIONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => {
                      actions.onReact(message.id, r);
                      setReactOpen(false);
                    }}
                    className="px-1.5 py-1 rounded hover:bg-[var(--bg-tertiary)] text-[15px] leading-none"
                  >
                    {glyph(r)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => actions.onOpenThread(message)}
            title="Reply in thread"
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)]"
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => actions.onTranslate(message.content)}
            title="Translate this message"
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)]"
          >
            <Languages className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => actions.onExplain(message.content)}
            title="Explain this message"
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-purple-400"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => actions.onQuote(message)}
            title="Quote in reply"
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)]"
          >
            <ScrollText className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => actions.onCreateTask(message)}
            title="Create a ClickUp task from this"
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--clickup-purple)]"
          >
            <Ticket className="w-3.5 h-3.5" />
          </button>
          {actions.onSendToAgent && (
            <button
              onClick={() => actions.onSendToAgent!(message.content)}
              title="Send to the agent terminal"
              className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--success)]"
            >
              <TerminalIcon className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={copy}
            title="Copy"
            className="p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      )}
    </div>
  );
}

/** Toolbar that follows a text selection — the "highlight it and ask" path. */
function SelectionToolbar({
  rect,
  onSummarize,
  onTranslate,
  onExplain,
  onReplyTo,
  onCreateTask,
}: {
  rect: { top: number; left: number };
  onSummarize: () => void;
  onTranslate: () => void;
  onExplain: () => void;
  onReplyTo: () => void;
  onCreateTask: () => void;
}) {
  const item = (label: string, Icon: any, onClick: () => void, accent?: string) => (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-[11px] font-medium text-[var(--text-secondary)] whitespace-nowrap',
        accent,
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );

  return (
    <div
      style={{ top: rect.top, left: rect.left }}
      className="absolute z-30 -translate-x-1/2 -translate-y-full flex items-center gap-0.5 p-1 rounded-xl bg-[var(--bg-card)] border border-[var(--border-strong)] shadow-[var(--shadow-float)]"
    >
      {item('What is this?', Sparkles, onExplain, 'hover:text-purple-400')}
      {item('Summarize', ScrollText, onSummarize, 'hover:text-[var(--accent)]')}
      {item('Translate', Languages, onTranslate, 'hover:text-[var(--accent-2)]')}
      {item('Reply to this', MessageSquare, onReplyTo, 'hover:text-[var(--accent)]')}
      {item('Task', Plus, onCreateTask, 'hover:text-[var(--clickup-purple)]')}
    </div>
  );
}

interface MessageListProps {
  /** The conversation on screen. Switching it always lands on the newest
   *  message, regardless of where the previous conversation was scrolled to. */
  channelId: string;
  /** When this visit started, so the transcript can mark where the messages
   *  arriving since the last visit begin. 0 disables the marker. */
  newSince: number;
  messages: ChatMessage[];
  me: ChatUser | null;
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  emptyHint: string;
  onLoadOlder: () => void;
  onSelectionChange: (text: string | null) => void;
  onSelectionAction: (action: 'summarize' | 'translate' | 'explain' | 'reply' | 'task', text: string) => void;
  actions: MessageActions;
}

export function MessageList({
  channelId,
  newSince,
  messages,
  me,
  loading,
  loadingOlder,
  hasMore,
  emptyHint,
  onLoadOlder,
  onSelectionChange,
  onSelectionAction,
  actions,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null);

  /** The conversation the scroll position currently belongs to. This component
   *  is not remounted between channels, so without it a channel opened after
   *  scrolling up in another one would inherit that scroll position. */
  const scrolledChannel = useRef<string | null>(null);
  /** scrollHeight captured just before an older page is prepended. */
  const olderAnchor = useRef<number | null>(null);
  /** Read by listeners that outlive a render, so they never see a stale value. */
  const pinnedRef = useRef(true);
  pinnedRef.current = pinned;
  /** The scroll container from the previous render. The loading and empty
   *  states render a different tree, so returning from one gives a brand-new
   *  container sitting at the top that has to be re-anchored. */
  const lastContainer = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    // Assigning scrollTop directly rather than scrollIntoView: it is
    // synchronous and exact, so it can be repeated as late content lands.
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Stay glued to the newest message unless the user has scrolled up to read.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distance < 120);
  }, []);

  // Opening a conversation shows its newest message. Depends on `messages`
  // because the container does not exist yet while the first page is loading —
  // this re-runs when it mounts with content.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const remounted = lastContainer.current !== el;
    lastContainer.current = el;
    if (!remounted && scrolledChannel.current === channelId) return;
    scrolledChannel.current = channelId;
    setPinned(true);
    setSelection(null);
    scrollToBottom();
  }, [channelId, messages, scrollToBottom]);

  // Prepending older messages must not move the text the user is reading.
  // Runs before the pin effect below so it wins while scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || olderAnchor.current === null) return;
    const grew = el.scrollHeight - olderAnchor.current;
    olderAnchor.current = null;
    if (grew > 0) el.scrollTop += grew;
  }, [messages]);

  useLayoutEffect(() => {
    if (pinned) scrollToBottom();
  }, [messages, pinned, scrollToBottom]);

  // Images arrive after the messages that contain them and grow the transcript,
  // which would otherwise leave the view stranded above the newest message.
  // `load` does not bubble, so this listens in the capture phase.
  const hasMessages = messages.length > 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onLoad = () => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
    // hasMessages flips when the loading/empty branch swaps the container out,
    // which is exactly when the listener needs re-attaching to the new node.
  }, [hasMessages]);

  const readSelection = useCallback(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || '';
    const container = scrollRef.current;
    if (!sel || !text || sel.rangeCount === 0 || !container) {
      setSelection(null);
      onSelectionChange(null);
      return;
    }
    // Ignore selections made outside the transcript (composer, sidebar…).
    const anchor = sel.anchorNode;
    if (!anchor || !container.contains(anchor.nodeType === 3 ? anchor.parentNode : anchor)) {
      setSelection(null);
      onSelectionChange(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const host = container.getBoundingClientRect();
    setSelection({
      text,
      // Positioned against the scroll container, with a small gap above the
      // highlight so the toolbar never covers what was selected.
      top: rect.top - host.top + container.scrollTop - 6,
      left: Math.min(Math.max(rect.left - host.left + rect.width / 2, 160), host.width - 160),
    });
    onSelectionChange(text);
  }, [onSelectionChange]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelection(null);
        onSelectionChange(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelectionChange]);

  const runSelectionAction = (action: 'summarize' | 'translate' | 'explain' | 'reply' | 'task') => {
    if (!selection) return;
    onSelectionAction(action, selection.text);
    setSelection(null);
  };

  if (loading && messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-[var(--text-muted)] text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading conversation…
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-8">
        <MessageSquare className="w-8 h-8 text-[var(--text-muted)] opacity-40" />
        <p className="text-sm text-[var(--text-secondary)]">No messages yet</p>
        <p className="text-xs text-[var(--text-muted)] max-w-sm">{emptyHint}</p>
      </div>
    );
  }

  let lastDay = '';
  // The "new messages" line is drawn once, above the first message that landed
  // after the last visit. The user's own messages never trigger it.
  const firstUnreadId = newSince
    ? messages.find((m) => m.createdAtMs > newSince && (!me || m.user.id !== me.id))?.id
    : undefined;

  return (
    <div className="flex-1 relative min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onMouseUp={readSelection}
        className="absolute inset-0 overflow-y-auto pb-2"
      >
        {hasMore && (
          <div className="flex justify-center py-2">
            <button
              onClick={() => {
                // Remember the height so the prepended page can be offset out
                // from under the reader — see the anchor effect above.
                olderAnchor.current = scrollRef.current?.scrollHeight ?? null;
                onLoadOlder();
              }}
              disabled={loadingOlder}
              className="px-3 py-1 rounded-full bg-[var(--bg-tertiary)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 flex items-center gap-1.5"
            >
              {loadingOlder && <Loader2 className="w-3 h-3 animate-spin" />}
              Load earlier messages
            </button>
          </div>
        )}

        {messages.map((message, i) => {
          const day = dayLabel(message.createdAtMs);
          const showDay = day !== lastDay;
          lastDay = day;
          const previous = messages[i - 1];
          const grouped =
            !showDay &&
            message.id !== firstUnreadId &&
            !!previous &&
            previous.user.id === message.user.id &&
            message.createdAtMs - previous.createdAtMs < GROUP_WINDOW_MS &&
            message.type !== 'post';

          return (
            <div key={message.id}>
              {message.id === firstUnreadId && (
                <div className="flex items-center gap-3 px-4 pt-3 pb-1">
                  <div className="flex-1 h-px bg-[var(--accent)]/50" />
                  <span className="px-2 py-0.5 rounded-full bg-[var(--accent)]/15 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                    New messages
                  </span>
                  <div className="flex-1 h-px bg-[var(--accent)]/50" />
                </div>
              )}
              {showDay && (
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 h-px bg-[var(--border)]" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {day}
                  </span>
                  <div className="flex-1 h-px bg-[var(--border)]" />
                </div>
              )}
              <MessageRow message={message} me={me} grouped={grouped} actions={actions} />
            </div>
          );
        })}


        {selection && (
          <SelectionToolbar
            rect={{ top: selection.top, left: selection.left }}
            onExplain={() => runSelectionAction('explain')}
            onSummarize={() => runSelectionAction('summarize')}
            onTranslate={() => runSelectionAction('translate')}
            onReplyTo={() => runSelectionAction('reply')}
            onCreateTask={() => runSelectionAction('task')}
          />
        )}
      </div>

      {!pinned && (
        <button
          onClick={() => {
            setPinned(true);
            scrollToBottom();
          }}
          title="Jump to the newest message"
          className="absolute bottom-3 right-4 p-2 rounded-full bg-[var(--bg-card)] border border-[var(--border-strong)] shadow-[var(--shadow-float)] text-[var(--text-secondary)] hover:text-[var(--accent)]"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
