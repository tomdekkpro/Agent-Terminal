import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Hash,
  Lock,
  MessageSquare,
  Maximize2,
  Search,
  Users,
  X,
} from 'lucide-react';
import type { ChatChannel, ChatLanguage, ChatMessage } from '../../../shared/types';
import { useChatStore, EMPTY_CONVO, EMPTY_THREAD } from '../../stores/chat-store';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { useChatSurface } from '../../hooks/useChatSurface';
import { sendAgentPrompt } from '../../lib/send-agent-prompt';
import { cn } from '../../../shared/utils';
import { Avatar } from './Avatar';
import { AssistPanel } from './AssistPanel';
import { ImageLightbox } from './ImageLightbox';
import { MessageComposer, type ComposerTone } from './MessageComposer';
import { MessageList } from './MessageList';
import { ThreadPanel } from './ThreadPanel';

const WIDTH_STORAGE_KEY = 'chat-dock-width';
const MIN_WIDTH = 320;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 380;

function loadWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved;
  } catch {
    // Falls through to the default.
  }
  return DEFAULT_WIDTH;
}

function channelLabel(channel: ChatChannel): string {
  return channel.name || (channel.kind === 'CHANNEL' ? 'Channel' : 'Direct message');
}

function ChannelGlyph({ channel }: { channel: ChatChannel }) {
  if (channel.kind !== 'CHANNEL') {
    const member = channel.members?.[0];
    if (member) return <Avatar user={member} size="xs" presence />;
    return <Users className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />;
  }
  const Glyph = channel.visibility === 'PRIVATE' ? Lock : Hash;
  return <Glyph className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />;
}

/**
 * Conversation switcher for the dock.
 *
 * The dock is too narrow for a permanent channel list, and giving up a third
 * of it to one would defeat the point. A dropdown keeps the whole width for
 * the conversation while still being one click from any other — sorted so the
 * ones with something new are at the top.
 */
function ConversationPicker({
  channels,
  activeId,
  unreadOf,
  onPick,
  onClose,
}: {
  channels: ChatChannel[];
  activeId: string | null;
  unreadOf: (id: string) => number;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return channels
      .filter((c) => !c.archived)
      .filter((c) => !q || channelLabel(c).toLowerCase().includes(q))
      .sort((a, b) => {
        const unreadDelta = (unreadOf(b.id) > 0 ? 1 : 0) - (unreadOf(a.id) > 0 ? 1 : 0);
        if (unreadDelta) return unreadDelta;
        return (b.latestCommentAtMs || 0) - (a.latestCommentAtMs || 0);
      })
      .slice(0, 60);
  }, [channels, query, unreadOf]);

  return (
    <div
      ref={ref}
      className="absolute left-2 right-2 top-full mt-1 z-30 rounded-xl bg-[var(--bg-card)] border border-[var(--border-strong)] shadow-[var(--shadow-float)] overflow-hidden"
    >
      <div className="relative border-b border-[var(--border)]">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to a conversation"
          className="w-full pl-8 pr-2 py-2 bg-transparent outline-none text-[12px] placeholder:text-[var(--text-muted)]"
        />
      </div>
      <div className="max-h-72 overflow-y-auto p-1">
        {listed.length === 0 && (
          <p className="px-2 py-3 text-center text-[11px] text-[var(--text-muted)]">No match.</p>
        )}
        {listed.map((channel) => {
          const count = unreadOf(channel.id);
          return (
            <button
              key={channel.id}
              onClick={() => onPick(channel.id)}
              className={cn(
                'w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left',
                channel.id === activeId ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-tertiary)]',
              )}
            >
              <ChannelGlyph channel={channel} />
              <span
                className={cn(
                  'flex-1 min-w-0 truncate text-[12px]',
                  count > 0 ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                )}
              >
                {channelLabel(channel)}
              </span>
              {count > 0 && (
                <span className="shrink-0 min-w-[16px] h-4 px-1 rounded-full bg-[var(--accent)] text-white text-[9px] font-semibold flex items-center justify-center tabular-nums">
                  {count > 9 ? '9+' : count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ClickUp Chat docked beside whatever page the user is on.
 *
 * Deliberately a push-dock rather than an overlay: the whole point is to read
 * and answer a message *while* working in a terminal or a task, and an overlay
 * would cover the thing being worked on. It sits beside `main` at the app root
 * so every page gets it without knowing it exists, and it hides itself on the
 * Chat page, where it would only duplicate what is already on screen.
 */
export function ChatDock({ onOpenFullPage }: { onOpenFullPage: () => void }) {
  const {
    me, channels, unread, activeChannelId, conversations, drafts, assist, selection,
    bootstrapError, openedSeenAt, toggleReaction, activeThreadId, threads, lightbox, closeLightbox,
    selectChannel, loadOlder, send, loadReactions, openThread, closeThread, sendThreadReply,
    setDraft, setSelection, runAssist, clearAssist, clearError, setDockOpen,
    attachments, uploading, addAttachments, removeAttachment, cancelUpload,
  } = useChatStore();

  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);

  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [focusToken, setFocusToken] = useState(0);

  useChatSurface('dock', true);

  const projectPath = useMemo(
    () => projects.find((p) => p.id === activeProjectId)?.path,
    [projects, activeProjectId],
  );

  const channel = channels.find((c) => c.id === activeChannelId) || null;
  const convo = activeChannelId ? conversations[activeChannelId] || EMPTY_CONVO : EMPTY_CONVO;
  const draft = activeChannelId ? drafts[activeChannelId] || '' : '';
  const unreadOf = useCallback((id: string) => unread[id]?.count || 0, [unread]);
  const threadParent = activeThreadId
    ? convo.messages.find((m) => m.id === activeThreadId) || null
    : null;
  const totalUnread = Object.values(unread).reduce((sum, entry) => sum + entry.count, 0);

  // Nothing picked yet — drop into the conversation with the newest activity so
  // opening the dock always shows something rather than an empty shell.
  useEffect(() => {
    if (activeChannelId || channels.length === 0) return;
    const withUnread = channels.filter((c) => unreadOf(c.id) > 0);
    const best = (withUnread.length > 0 ? withUnread : channels)
      .filter((c) => !c.archived && c.latestCommentAtMs)
      .sort((a, b) => (b.latestCommentAtMs || 0) - (a.latestCommentAtMs || 0))[0];
    if (best) void selectChannel(best.id);
  }, [activeChannelId, channels, unreadOf, selectChannel]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      // Dragging left widens: the dock is anchored to the right edge.
      const next = Math.min(Math.max(window.innerWidth - ev.clientX, MIN_WIDTH), MAX_WIDTH);
      setWidth(next);
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

  const setComposer = useCallback(
    (text: string) => {
      if (!activeChannelId) return;
      setDraft(activeChannelId, text);
      setFocusToken((n) => n + 1);
    },
    [activeChannelId, setDraft],
  );

  const messageActions = useMemo(
    () => ({
      onOpenThread: (message: ChatMessage) => void openThread(message.id),
      onReact: (messageId: string, reaction: string) => void toggleReaction(messageId, reaction),
      onLoadReactions: (messageId: string) => void loadReactions([messageId]),
      onTranslate: (text: string) =>
        void runAssist('translate', { selection: text, language: settings.chatTranslateLanguage, projectPath }),
      onExplain: (text: string) => void runAssist('explain', { selection: text, projectPath }),
      onQuote: (message: ChatMessage) => {
        const quoted = (message.content || '')
          .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
        setComposer(`${draft ? `${draft.replace(/\s*$/, '')}\n` : ''}${quoted}\n\n`);
      },
      // Making a task needs more room than the dock has — hand the whole job
      // to the full page rather than cramming a form in here.
      onCreateTask: onOpenFullPage,
      onSendToAgent: activeTerminalId
        ? (text: string) => sendAgentPrompt(activeTerminalId, text, { submit: false })
        : undefined,
    }),
    [openThread, toggleReaction, loadReactions, runAssist, settings.chatTranslateLanguage, projectPath, draft, setComposer, activeTerminalId, onOpenFullPage],
  );

  const label = channel ? channelLabel(channel) : 'Messages';

  return (
    <div
      style={{ width }}
      className={cn(
        'shrink-0 h-full flex bg-[var(--bg-secondary)]/70 border-l border-[var(--border)]',
        dragging && 'select-none',
      )}
    >
      {/* Resize handle */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        className={cn(
          'w-1 shrink-0 cursor-col-resize relative group transition-colors',
          dragging ? 'bg-[var(--accent)]' : 'bg-transparent hover:bg-[var(--accent)]',
        )}
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5 z-10" />
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header — conversation switcher + escape hatches */}
        <div className="relative shrink-0 border-b border-[var(--border)]">
          <div className="flex items-center gap-1 px-2 py-2">
            <button
              onClick={() => setPickerOpen((v) => !v)}
              className="flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-[var(--bg-tertiary)] text-left"
            >
              {channel ? <ChannelGlyph channel={channel} /> : <MessageSquare className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
              <span className="flex-1 min-w-0 truncate text-[12px] font-semibold text-[var(--text-primary)]">
                {label}
              </span>
              {totalUnread > 0 && (
                <span className="shrink-0 min-w-[16px] h-4 px-1 rounded-full bg-[var(--accent)] text-white text-[9px] font-semibold flex items-center justify-center tabular-nums">
                  {totalUnread > 99 ? '99+' : totalUnread}
                </span>
              )}
              <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--text-muted)]" />
            </button>

            <button
              onClick={onOpenFullPage}
              title="Open the full Chat page"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)]"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setDockOpen(false)}
              title="Close the message dock  (Ctrl+Shift+M)"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {pickerOpen && (
            <ConversationPicker
              channels={channels}
              activeId={activeChannelId}
              unreadOf={unreadOf}
              onPick={(id) => {
                void selectChannel(id);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        {bootstrapError ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <AlertTriangle className="w-6 h-6 text-[var(--warning)] opacity-70" />
            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">{bootstrapError}</p>
          </div>
        ) : !channel ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <MessageSquare className="w-6 h-6 text-[var(--text-muted)] opacity-40" />
            <p className="text-[11px] text-[var(--text-muted)]">Pick a conversation to start.</p>
          </div>
        ) : threadParent ? (
          // The dock is too narrow to split, so a thread takes the whole panel
          // and hands the conversation back when it closes.
          <ThreadPanel
            fill
            parent={threadParent}
            thread={threads[threadParent.id] || EMPTY_THREAD}
            me={me}
            onClose={closeThread}
            onSend={(text) => sendThreadReply(threadParent.id, text)}
          />
        ) : (
          <>
            {convo.error && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-[var(--error)]/10 border-b border-[var(--error)]/30 shrink-0">
                <p className="flex-1 text-[10px] text-[var(--error)] truncate">{convo.error}</p>
                <button
                  onClick={() => clearError(activeChannelId || undefined)}
                  className="p-0.5 rounded text-[var(--error)] hover:bg-[var(--error)]/20"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            <MessageList
              channelId={channel.id}
              newSince={openedSeenAt[channel.id] || 0}
              messages={convo.messages}
              me={me}
              loading={convo.loading}
              loadingOlder={convo.loadingOlder}
              hasMore={convo.hasMore}
              emptyHint={`Nothing here yet — say the first thing to ${label}.`}
              onLoadOlder={() => activeChannelId && void loadOlder(activeChannelId)}
              onSelectionChange={setSelection}
              onSelectionAction={(action, text) => {
                if (action === 'summarize') void runAssist('summarize', { selection: text, projectPath });
                else if (action === 'translate')
                  void runAssist('translate', { selection: text, language: settings.chatTranslateLanguage, projectPath });
                else if (action === 'explain') void runAssist('explain', { selection: text, projectPath });
                else if (action === 'reply') void runAssist('suggest', { selection: text, projectPath });
                else onOpenFullPage();
                setSelection(null);
              }}
              actions={messageActions}
            />

            <AssistPanel
              assist={assist}
              onClose={clearAssist}
              onUse={setComposer}
              onSend={(text) => {
                if (!activeChannelId) return;
                void send(activeChannelId, text);
                clearAssist();
              }}
            />

            <MessageComposer
              value={draft}
              onChange={(text) => activeChannelId && setDraft(activeChannelId, text)}
              onSend={() => activeChannelId && void send(activeChannelId, draft)}
              sending={convo.sending}
              placeholder={channel.kind === 'CHANNEL' ? `Message #${label}` : `Message ${label}`}
              assistRunning={assist.running}
              language={settings.chatTranslateLanguage || 'vi'}
              onLanguageChange={(language: ChatLanguage) => void updateSettings({ chatTranslateLanguage: language })}
              onSuggest={() => void runAssist('suggest', { selection: selection || undefined, projectPath })}
              onTranslate={() =>
                void runAssist('translate', { draft, language: settings.chatTranslateLanguage, projectPath })
              }
              onRewrite={(tone: ComposerTone) => void runAssist('rewrite', { draft, tone, projectPath })}
              focusToken={focusToken}
              attachments={activeChannelId ? attachments[activeChannelId] || [] : []}
              onAttach={(files) => activeChannelId && addAttachments(activeChannelId, files)}
              onRemoveAttachment={(id) => activeChannelId && removeAttachment(activeChannelId, id)}
              uploading={activeChannelId ? uploading[activeChannelId] : undefined}
              onCancelUpload={() => activeChannelId && cancelUpload(activeChannelId)}
              attachmentsEnabled={!!settings.chatUploadTaskId}
              attachmentsHint="ClickUp has no attachment API for Chat, so files are uploaded to a task and linked. Pick that task in Settings → Tasks → “Task that hosts files shared in Chat”."
            />
          </>
        )}
      </div>

      {lightbox && (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeLightbox} />
      )}

      {/* Swallows mouse events mid-drag so the page underneath doesn't start a
          text selection while the dock is being resized. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}

/** The closed dock's handle: a drawer pull on the right edge, carrying the
 *  unread count so a new message is visible from any page without opening it. */
export function ChatDockHandle({ onOpen, unread }: { onOpen: () => void; unread: number }) {
  return (
    <button
      onClick={onOpen}
      title="Messages  (Ctrl+Shift+M)"
      className={cn(
        'fixed right-0 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-1 py-3 px-1.5',
        'rounded-l-lg border border-r-0 border-[var(--border)] bg-[var(--bg-card)]/90 backdrop-blur',
        'text-[var(--text-muted)] hover:text-[var(--accent)] hover:px-2 transition-all',
        unread > 0 && 'text-[var(--accent)] border-[var(--accent)]/40',
      )}
    >
      <MessageSquare className="w-4 h-4" />
      {unread > 0 && (
        <span className="min-w-[16px] h-4 px-1 rounded-full bg-[var(--accent)] text-white text-[9px] font-semibold flex items-center justify-center tabular-nums">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}
