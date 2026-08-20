import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerUpLeft,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquare,
  Quote,
  RefreshCw,
  ScrollText,
  Sparkles,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import type { TaskComment, TaskCommentBlock } from '../../../shared/types';
import { useCommentsStore } from '../../stores/comments-store';
import { cn } from '../../../shared/utils';

const WIDTH_STORAGE_KEY = 'comments-panel-width';
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 400;
/** How often an open panel re-reads the thread. Runs on the background API
 *  lane, so a poll can never spend the budget a user click is waiting for. */
const POLL_MS = 60_000;

interface CommentsPanelProps {
  /** Task-manager task id (ClickUp id) — the thread's owner. */
  taskId: string;
  /** Short label for the composer placeholder, e.g. "DP2-1234". */
  taskLabel?: string;
  taskName?: string;
  /** Opens the task in ClickUp. */
  taskUrl?: string;
  /** CLI working directory for the AI helpers. */
  projectPath?: string;
  onClose: () => void;
  /** When given, the panel offers "send to agent" on the thread and on single
   *  comments — the text lands in the linked terminal's agent prompt. */
  onSendToAgent?: (text: string) => void;
  /** Fill the host container instead of managing a resizable width (used by
   *  the terminal's overlay drawer, which sets its own size). */
  fill?: boolean;
}

function formatRelative(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function formatExact(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString();
}

function initialsFor(comment: TaskComment): string {
  const { initials, username } = comment.user;
  if (initials) return initials.slice(0, 2).toUpperCase();
  const parts = (username || '?').trim().split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (username || '?').slice(0, 2).toUpperCase();
}

/** Render ClickUp's rich-text runs: links stay clickable, @mentions and task
 *  references become chips, and images/clips show inline. Anything unknown
 *  falls back to its plain text so no content is silently dropped. */
function CommentBody({ blocks, text }: { blocks: TaskCommentBlock[]; text: string }) {
  const attachments = blocks?.filter((b) => b.kind === 'attachment') || [];
  const runs = blocks?.filter((b) => b.kind !== 'attachment') || [];

  // No structured content (or nothing renderable in it) — show the flat text.
  if (runs.length === 0 && attachments.length === 0) {
    return <div className="text-[12px] leading-relaxed whitespace-pre-wrap break-words">{text}</div>;
  }

  return (
    <div className="space-y-1.5">
      {runs.length > 0 && (
        <div className="text-[12px] leading-relaxed whitespace-pre-wrap break-words">
          {runs.map((block, i) => {
            if (block.kind === 'divider') {
              return <hr key={i} className="my-1.5 border-[var(--border)]" />;
            }

            if (block.kind === 'mention') {
              const chip = (
                <span className="px-1 rounded bg-[var(--accent)]/15 text-[var(--accent)] font-medium">
                  {block.text}
                </span>
              );
              if (!block.url) return <span key={i}>{chip}</span>;
              return (
                <button
                  key={i}
                  onClick={() => window.electronAPI.openExternal(block.url!)}
                  title={block.url}
                  className="hover:underline"
                >
                  {chip}
                </button>
              );
            }

            const content = block.code
              ? <code className="px-1 py-0.5 rounded bg-black/30 font-mono text-[11px]">{block.text}</code>
              : block.text;
            const styled = (
              <span
                className={cn(
                  block.bold && 'font-semibold',
                  block.italic && 'italic',
                  block.underline && 'underline',
                  block.strike && 'line-through opacity-70',
                )}
              >
                {content}
              </span>
            );
            if (block.url) {
              return (
                <button
                  key={i}
                  onClick={() => window.electronAPI.openExternal(block.url!)}
                  className="text-[var(--accent)] hover:underline"
                  title={block.url}
                >
                  {styled}
                </button>
              );
            }
            return <span key={i}>{styled}</span>;
          })}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {attachments.map((block, i) => {
            const att = block.attachment!;
            const open = () => att.url && window.electronAPI.openExternal(att.url);
            if (att.isImage && (att.thumbnailUrl || att.url)) {
              return (
                <button key={i} onClick={open} title={att.title} className="block">
                  <img
                    src={att.thumbnailUrl || att.url}
                    alt={att.title || 'attachment'}
                    className="max-h-40 rounded border border-[var(--border)] hover:opacity-80 transition-opacity"
                  />
                </button>
              );
            }
            return (
              <button
                key={i}
                onClick={open}
                title={att.title}
                className="flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg-tertiary)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors max-w-[220px]"
              >
                <FileText className="w-3 h-3 shrink-0" />
                <span className="truncate">{att.title || 'attachment'}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Avatar({ comment, mine }: { comment: TaskComment; mine: boolean }) {
  const color = comment.bot ? '#a78bfa' : comment.user.color || (mine ? 'var(--accent)' : '#64748b');
  if (comment.user.profilePicture) {
    return (
      <img
        src={comment.user.profilePicture}
        alt={comment.user.username}
        className="w-6 h-6 rounded-full shrink-0 object-cover border border-[var(--border)]"
      />
    );
  }
  return (
    <div
      className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[9px] font-semibold text-white"
      style={{ backgroundColor: color }}
      title={comment.user.username}
    >
      {comment.bot ? <Bot className="w-3.5 h-3.5" /> : initialsFor(comment)}
    </div>
  );
}

interface CommentRowProps {
  comment: TaskComment;
  /** The ClickUp id of the API-key owner, so "You" is only shown for real. */
  meId?: string;
  taskId: string;
  isReply?: boolean;
  onQuote: (comment: TaskComment) => void;
  onReply: (comment: TaskComment) => void;
  onSendToAgent?: (text: string) => void;
}

function CommentRow({ comment, meId, taskId, isReply, onQuote, onReply, onSendToAgent }: CommentRowProps) {
  const mine = !!meId && comment.user.id === meId && !comment.bot;
  const thread = useCommentsStore((s) => s.threads[taskId]);
  const loadReplies = useCommentsStore((s) => s.loadReplies);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const replies = thread?.replies[comment.id];
  const repliesLoading = !!thread?.repliesLoading[comment.id];

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(comment.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [comment.text]);

  const toggleReplies = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadReplies(taskId, comment.id);
  }, [expanded, loadReplies, taskId, comment.id]);

  return (
    <div className={cn('group flex gap-2', isReply && 'pl-6')}>
      <Avatar comment={comment} mine={mine} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cn('text-[11px] font-medium truncate', mine ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]')}>
            {mine ? 'You' : comment.user.username}
          </span>
          {comment.bot && (
            <span className="text-[9px] px-1 rounded bg-violet-500/15 text-violet-300 uppercase tracking-wide">auto</span>
          )}
          <span className="text-[10px] text-[var(--text-muted)]" title={formatExact(comment.createdAtMs)}>
            {formatRelative(comment.createdAtMs)}
          </span>
          {comment.resolved && (
            <span className="flex items-center gap-0.5 text-[9px] text-emerald-400">
              <Check className="w-2.5 h-2.5" /> resolved
            </span>
          )}
          {comment.assignee && (
            <span className="text-[9px] text-amber-400" title="Assigned as a to-do">
              → {comment.assignee.username}
            </span>
          )}

          {/* Row actions — appear on hover so the thread stays readable */}
          <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              title="Copy comment text"
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </button>
            <button
              onClick={() => onQuote(comment)}
              title="Quote in your reply"
              className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <Quote className="w-3 h-3" />
            </button>
            {!isReply && (
              <button
                onClick={() => onReply(comment)}
                title="Reply in this comment's thread"
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <CornerUpLeft className="w-3 h-3" />
              </button>
            )}
            {onSendToAgent && (
              <button
                onClick={() => onSendToAgent(comment.text)}
                title="Send this comment to the agent"
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-emerald-400"
              >
                <TerminalIcon className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        <div
          className={cn(
            'mt-1 rounded-lg px-2.5 py-2 border',
            comment.bot
              ? 'bg-violet-500/5 border-violet-500/20 text-[var(--text-secondary)]'
              : mine
                ? 'bg-[var(--accent)]/10 border-[var(--accent)]/20 text-[var(--text-primary)]'
                : 'bg-[var(--bg-card)] border-[var(--border)] text-[var(--text-primary)]',
          )}
        >
          <CommentBody blocks={comment.blocks} text={comment.text} />
          {comment.reactions && comment.reactions.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {comment.reactions.map((r) => (
                <span
                  key={r.reaction}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                >
                  {r.reaction} {r.count > 1 ? r.count : ''}
                </span>
              ))}
            </div>
          )}
        </div>

        {comment.replyCount > 0 && !isReply && (
          <>
            <button
              onClick={toggleReplies}
              className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {comment.replyCount} {comment.replyCount === 1 ? 'reply' : 'replies'}
              {repliesLoading && <Loader2 className="w-3 h-3 animate-spin" />}
            </button>
            {expanded && replies && replies.length > 0 && (
              <div className="mt-2 space-y-3 border-l border-[var(--border)] pl-2">
                {replies.map((reply) => (
                  <CommentRow
                    key={reply.id}
                    comment={reply}
                    meId={meId}
                    taskId={taskId}
                    isReply
                    onQuote={onQuote}
                    onReply={onReply}
                    onSendToAgent={onSendToAgent}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * ClickUp comment thread for a task: the whole conversation, a composer that
 * posts back, and AI help — three drafted replies (optionally polishing what
 * you already typed) or a digest of a long thread. Mounted by both task-detail
 * surfaces: the Kanban task modal and the terminal's drawer.
 */
export function CommentsPanel({
  taskId,
  taskLabel,
  taskName,
  taskUrl,
  projectPath,
  onClose,
  onSendToAgent,
  fill,
}: CommentsPanelProps) {
  const thread = useCommentsStore((s) => s.threads[taskId]);
  const assist = useCommentsStore((s) => s.assist[taskId]);
  const load = useCommentsStore((s) => s.load);
  const loadOlder = useCommentsStore((s) => s.loadOlder);
  const post = useCommentsStore((s) => s.post);
  const postReply = useCommentsStore((s) => s.postReply);
  const runAssist = useCommentsStore((s) => s.runAssist);
  const clearAssist = useCommentsStore((s) => s.clearAssist);

  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<TaskComment | null>(null);
  const [showSummary, setShowSummary] = useState(true);
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH;
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastCountRef = useRef(0);

  const comments = thread?.comments || [];
  const meId = thread?.me?.id;

  // First load on open, then a slow background poll so replies show up without
  // the user hunting for a refresh button.
  useEffect(() => {
    void load(taskId);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void load(taskId, { force: true, background: true });
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [taskId, load]);

  // Jump to the newest comment on first render, and follow new arrivals only
  // when already near the bottom — never yank the view while reading history.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || comments.length === 0) return;
    const previous = lastCountRef.current;
    lastCountRef.current = comments.length;
    if (comments.length <= previous) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (previous === 0 || nearBottom) el.scrollTop = el.scrollHeight;
  }, [comments.length]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let latest = startWidth;
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setWidth(latest);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(WIDTH_STORAGE_KEY, String(Math.round(latest)));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  const handleQuote = useCallback((comment: TaskComment) => {
    const quoted = comment.text
      .split('\n')
      .slice(0, 12)
      .map((line) => `> ${line}`)
      .join('\n');
    setDraft((prev) => (prev ? `${prev}\n\n${quoted}\n\n` : `${quoted}\n\n`));
    textareaRef.current?.focus();
  }, []);

  const handleReplyTo = useCallback((comment: TaskComment) => {
    setReplyTo(comment);
    textareaRef.current?.focus();
  }, []);

  const handlePost = useCallback(async () => {
    const body = draft.trim();
    if (!body || thread?.posting) return;
    const ok = replyTo
      ? await postReply(taskId, replyTo.id, body)
      : await post(taskId, body);
    if (ok) {
      setDraft('');
      setReplyTo(null);
    }
  }, [draft, thread?.posting, replyTo, postReply, post, taskId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handlePost();
    }
  }, [handlePost]);

  const sendThreadToAgent = useCallback(() => {
    if (!onSendToAgent) return;
    const recent = comments.slice(-15);
    const rendered = recent
      .map((c) => `[${c.user.username} · ${formatExact(c.createdAtMs)}]\n${c.text}`)
      .join('\n\n');
    onSendToAgent(
      `Here is the ClickUp comment thread for ${taskLabel || taskId}${taskName ? ` (${taskName})` : ''}. ` +
      `Use it as context for the work on this task:\n\n${rendered}`,
    );
  }, [onSendToAgent, comments, taskLabel, taskId, taskName]);

  const suggestions = assist?.suggestions || [];
  const assistRunning = !!assist?.running;
  const summarizing = assistRunning && assist?.kind === 'summarize';
  const drafting = assistRunning && assist?.kind === 'suggest';
  const hasDigest = !!(assist?.summary || (assist?.kind === 'summarize' && assist?.raw));

  return (
    <div
      className={cn(
        'relative flex flex-col h-full bg-[var(--bg-primary)] border-l border-[var(--border)]',
        !fill && 'shrink-0',
      )}
      style={fill ? undefined : { width }}
      onClick={(e) => e.stopPropagation()}
    >
      {!fill && (
        <div
          onMouseDown={startResize}
          title="Drag to resize"
          className="absolute left-0 top-0 bottom-0 w-1.5 -ml-1 z-20 cursor-col-resize hover:bg-[var(--accent)]/40 transition-colors"
        />
      )}

      {/* Header */}
      <div className="h-9 bg-[var(--bg-card)] border-b border-[var(--border)] flex items-center px-2 gap-1 shrink-0">
        <MessageSquare className="w-3.5 h-3.5 text-sky-400 shrink-0" />
        <span className="text-[11px] text-[var(--text-primary)] font-medium truncate">
          Comments
          {comments.length > 0 && (
            <span className="text-[var(--text-muted)] font-normal"> · {comments.length}</span>
          )}
        </span>
        <div className="flex-1" />
        {onSendToAgent && comments.length > 0 && (
          <button
            onClick={sendThreadToAgent}
            title="Send the thread to the agent as context"
            className="h-6 px-1.5 rounded flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-emerald-400 hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <TerminalIcon className="w-3 h-3" />
            To agent
          </button>
        )}
        <button
          onClick={() => load(taskId, { force: true })}
          disabled={thread?.loading}
          title="Reload the thread from ClickUp"
          className="h-6 w-6 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3 h-3', thread?.loading && 'animate-spin')} />
        </button>
        {taskUrl && (
          <button
            onClick={() => window.electronAPI.openExternal(taskUrl)}
            title="Open the task in ClickUp"
            className="h-6 w-6 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={onClose}
          title="Close comments"
          className="h-6 w-6 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {thread?.error && (
        <div className="m-2 flex items-start gap-2 text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="flex-1 break-words">{thread.error}</span>
          <button
            onClick={() => useCommentsStore.getState().clearError(taskId)}
            className="shrink-0 hover:opacity-70"
            title="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Thread digest — pinned under the header rather than placed in the
          scrolling thread: the thread opens scrolled to the newest comment, so
          a card added at the top would appear off-screen and the Summarize
          button would look like it did nothing. */}
      {(summarizing || hasDigest) && (
        <div className="mx-2 mt-2 rounded-lg border border-amber-500/25 bg-amber-500/5 overflow-hidden shrink-0">
          <div className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-amber-300">
            {summarizing
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <ScrollText className="w-3 h-3" />}
            <span className="font-medium uppercase tracking-wide">
              {summarizing ? 'Summarizing thread…' : 'Thread digest'}
            </span>
            <div className="flex-1" />
            {hasDigest && (
              <>
                <button
                  onClick={() => setShowSummary((v) => !v)}
                  title={showSummary ? 'Collapse' : 'Expand'}
                  className="p-0.5 rounded hover:bg-amber-500/15"
                >
                  {showSummary ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
                <button
                  onClick={() => clearAssist(taskId)}
                  title="Dismiss digest"
                  className="p-0.5 rounded hover:bg-amber-500/15"
                >
                  <X className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
          {hasDigest && showSummary && (
            <div className="px-2.5 pb-2.5 max-h-[40vh] overflow-y-auto text-[11px] text-[var(--text-secondary)] leading-relaxed [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_strong]:text-[var(--text-primary)] [&_p]:mb-1.5 [&_li]:mb-0.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {assist?.summary || assist?.raw || ''}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}

      {/* Thread */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-2.5 py-3 space-y-4">
        {thread?.hasMore && (
          <button
            onClick={() => loadOlder(taskId)}
            disabled={thread.loadingOlder}
            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-[var(--border)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-60"
          >
            {thread.loadingOlder ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />}
            Load older comments
          </button>
        )}

        {thread?.loading && comments.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-[11px] text-[var(--text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading comments…
          </div>
        )}

        {!thread?.loading && comments.length === 0 && !thread?.error && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <MessageSquare className="w-6 h-6 text-[var(--text-muted)] opacity-40" />
            <span className="text-[11px] text-[var(--text-muted)]">
              No comments on this task yet.
            </span>
          </div>
        )}

        {comments.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            meId={meId}
            taskId={taskId}
            onQuote={handleQuote}
            onReply={handleReplyTo}
            onSendToAgent={onSendToAgent}
          />
        ))}
      </div>

      {/* AI suggestions */}
      {(drafting || suggestions.length > 0 || (assist?.kind === 'suggest' && assist?.raw) || assist?.error) && (
        <div className="border-t border-[var(--border)] bg-[var(--bg-card)]/60 px-2.5 py-2 space-y-1.5 max-h-[42%] overflow-y-auto shrink-0">
          <div className="flex items-center gap-1.5">
            {drafting
              ? <Loader2 className="w-3 h-3 animate-spin text-violet-400" />
              : <Sparkles className="w-3 h-3 text-violet-400" />}
            <span className="text-[10px] uppercase tracking-wide text-violet-300 font-medium">
              {drafting ? 'Drafting replies…' : 'Suggested replies'}
            </span>
            <div className="flex-1" />
            <button
              onClick={() => clearAssist(taskId)}
              title="Dismiss suggestions"
              className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          {assist?.error && (
            <div className="text-[11px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-2 py-1.5">
              {assist.error}
            </div>
          )}

          {suggestions.map((s, i) => (
            <div
              key={i}
              className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-violet-300 font-medium truncate">{s.title}</span>
                <div className="flex-1" />
                <button
                  onClick={() => { setDraft(s.text); textareaRef.current?.focus(); }}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-200 hover:bg-violet-500/30 transition-colors"
                  title="Put this in the composer to edit before posting"
                >
                  Use
                </button>
              </div>
              <div className="mt-1 text-[11px] text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words">
                {s.text}
              </div>
            </div>
          ))}

          {assist?.kind === 'suggest' && assist?.raw && suggestions.length === 0 && (
            <div className="text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words">
              {assist.raw}
            </div>
          )}
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-2 space-y-1.5 shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => runAssist(taskId, 'suggest', { draft: draft.trim() || undefined, projectPath })}
            disabled={assistRunning}
            title={draft.trim()
              ? 'Polish what you typed into three ready-to-post replies'
              : 'Draft three replies from the thread'}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 transition-colors disabled:opacity-60"
          >
            {assistRunning && assist?.kind === 'suggest'
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Sparkles className="w-3 h-3" />}
            {draft.trim() ? 'Polish reply' : 'Suggest reply'}
          </button>
          <button
            onClick={() => runAssist(taskId, 'summarize', { projectPath })}
            disabled={assistRunning || comments.length === 0}
            title={comments.length === 0
              ? 'Nothing to summarize yet — this task has no comments'
              : 'Summarize the thread: state, decisions, open questions'}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors disabled:opacity-60"
          >
            {assistRunning && assist?.kind === 'summarize'
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <ScrollText className="w-3 h-3" />}
            Summarize
          </button>
          <div className="flex-1" />
          <span className="text-[9px] text-[var(--text-muted)]">Ctrl+Enter posts</span>
        </div>

        {replyTo && (
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] rounded px-2 py-1">
            <CornerUpLeft className="w-3 h-3 shrink-0" />
            <span className="truncate">
              Replying to {replyTo.user.username}: {replyTo.text.slice(0, 60)}
            </span>
            <button onClick={() => setReplyTo(null)} title="Cancel reply" className="ml-auto shrink-0 hover:text-[var(--text-primary)]">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          placeholder={replyTo
            ? `Reply to ${replyTo.user.username}…`
            : `Comment on ${taskLabel || 'this task'}…`}
          className="w-full resize-y rounded-lg bg-[var(--bg-primary)] border border-[var(--border)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]/50"
        />

        <div className="flex items-center gap-1.5">
          <div className="flex-1" />
          {draft && (
            <button
              onClick={() => setDraft('')}
              className="px-2 py-1 rounded-md text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              Clear
            </button>
          )}
          <button
            onClick={handlePost}
            disabled={!draft.trim() || thread?.posting}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {thread?.posting ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageSquare className="w-3 h-3" />}
            {replyTo ? 'Reply' : 'Post'}
          </button>
        </div>
      </div>
    </div>
  );
}
