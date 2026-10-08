import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Hash,
  ListChecks,
  Lock,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import type { ChatLanguage, ChatMessage } from '../../../shared/types';
import { presenceLabel, presenceOf } from '../../../shared/types';
import { useChatStore, EMPTY_CONVO, EMPTY_THREAD } from '../../stores/chat-store';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { sendAgentPrompt } from '../../lib/send-agent-prompt';
import { useChatSurface } from '../../hooks/useChatSurface';
import { InsightsView } from '../insights';
import { cn } from '../../../shared/utils';
import { Avatar } from './Avatar';
import { AssistPanel } from './AssistPanel';
import { ImageLightbox } from './ImageLightbox';
import { ChannelSidebar } from './ChannelSidebar';
import { CreateTaskModal } from './CreateTaskModal';
import { MessageComposer, type ComposerTone } from './MessageComposer';
import { MessageList } from './MessageList';
import { NewDmModal } from './NewDmModal';
import { ThreadPanel } from './ThreadPanel';

type Mode = 'chat' | 'assistant';

/** Quote a message the way every chat client does, so the reply has context. */
function quoteOf(message: ChatMessage): string {
  const body = (message.content || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${body}\n\n`;
}

function EmptyState({ onNewDm }: { onNewDm: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <MessageSquare className="w-10 h-10 text-[var(--text-muted)] opacity-30" />
      <h2 className="text-base font-semibold text-[var(--text-primary)]">Pick a conversation</h2>
      <p className="text-xs text-[var(--text-secondary)] max-w-sm leading-relaxed">
        Your ClickUp channels and direct messages are on the left. Highlight any text in a
        conversation to summarize, translate or explain it — or ask for a reply you can edit
        before sending.
      </p>
      <button
        onClick={onNewDm}
        className="px-3 py-1.5 rounded-lg bg-[var(--accent)]/15 text-[var(--accent)] text-[12px] font-medium hover:bg-[var(--accent)]/25"
      >
        Message someone
      </button>
    </div>
  );
}

function NotConfigured({ error }: { error: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <AlertTriangle className="w-8 h-8 text-[var(--warning)] opacity-70" />
      <h2 className="text-base font-semibold text-[var(--text-primary)]">ClickUp Chat isn’t connected</h2>
      <p className="text-xs text-[var(--text-secondary)] max-w-md leading-relaxed">{error}</p>
      <p className="text-[11px] text-[var(--text-muted)] max-w-md">
        Chat needs the ClickUp API key <em>and</em> the Workspace ID in Settings → Tasks.
        The AI assistant on the left works without either.
      </p>
    </div>
  );
}

/**
 * The Chat page.
 *
 * Two kinds of conversation in one place: the team's ClickUp Chat, and the
 * local AI assistant that already lived here. They share a sidebar because
 * "who am I talking to" is the same question either way, and because the most
 * useful thing the assistant does — read a thread and answer it — needs the
 * thread to be one click away.
 */
export function ChatView() {
  const {
    me, people, bootstrapError,
    channels, channelsError,
    activeChannelId, conversations, drafts,
    activeThreadId, threads,
    assist, selection, openedSeenAt, presence, lightbox, closeLightbox,
    bootstrap, loadMessages, loadOlder, send, loadReactions,
    openThread, closeThread, sendThreadReply,
    startDm, toggleReaction, setDraft, setSelection,
    attachments, uploading, addAttachments, removeAttachment, cancelUpload, addMention,
    runAssist, clearAssist, clearError,
  } = useChatStore();

  const settings = useSettingsStore((s) => s.settings);
  const settingsLoading = useSettingsStore((s) => s.isLoading);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);

  const [mode, setMode] = useState<Mode>('chat');
  const [showNewDm, setShowNewDm] = useState(false);
  const [taskSource, setTaskSource] = useState<{ text: string; attribution?: string } | null>(null);
  const [focusToken, setFocusToken] = useState(0);

  const projectPath = useMemo(
    () => projects.find((p) => p.id === activeProjectId)?.path,
    [projects, activeProjectId],
  );

  const channel = channels.find((c) => c.id === activeChannelId) || null;
  const convo = activeChannelId ? conversations[activeChannelId] || EMPTY_CONVO : EMPTY_CONVO;
  const draft = activeChannelId ? drafts[activeChannelId] || '' : '';
  const parentMessage = activeThreadId
    ? convo.messages.find((m) => m.id === activeThreadId) || null
    : null;

  // Bootstrap once settings have landed: the "following vs all channels"
  // default lives in settings, and asking ClickUp for the wrong one first
  // would cost a page-through that gets thrown away a tick later.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (settingsLoading || bootstrapped.current) return;
    bootstrapped.current = true;
    useChatStore.setState({ showAll: !!settings.chatShowAllChannels });
    void bootstrap();
  }, [settingsLoading, settings.chatShowAllChannels, bootstrap]);

  // Viewing state and the open conversation's refresh, shared with the dock so
  // the two surfaces can never drift apart. The channel list is polled by App.
  useChatSurface('page', mode === 'chat');

  const setComposer = useCallback(
    (text: string) => {
      if (!activeChannelId) return;
      setDraft(activeChannelId, text);
      setFocusToken((n) => n + 1);
    },
    [activeChannelId, setDraft],
  );

  const appendToComposer = useCallback(
    (text: string) => {
      if (!activeChannelId) return;
      const current = drafts[activeChannelId] || '';
      setDraft(activeChannelId, current ? `${current.replace(/\s*$/, '')}\n${text}` : text);
      setFocusToken((n) => n + 1);
    },
    [activeChannelId, drafts, setDraft],
  );

  const doSend = useCallback(async () => {
    if (!activeChannelId) return;
    await send(activeChannelId, drafts[activeChannelId] || '');
  }, [activeChannelId, drafts, send]);

  const sendToAgent = useCallback(
    (text: string) => {
      if (!activeTerminalId) return;
      sendAgentPrompt(activeTerminalId, text, { submit: false });
    },
    [activeTerminalId],
  );

  /** The five things the highlight toolbar can do, in one place. */
  const handleSelectionAction = useCallback(
    (action: 'summarize' | 'translate' | 'explain' | 'reply' | 'task', text: string) => {
      switch (action) {
        case 'summarize':
          void runAssist('summarize', { selection: text, projectPath });
          break;
        case 'translate':
          void runAssist('translate', { selection: text, language: settings.chatTranslateLanguage, projectPath });
          break;
        case 'explain':
          void runAssist('explain', { selection: text, projectPath });
          break;
        case 'reply':
          void runAssist('suggest', { selection: text, projectPath });
          break;
        case 'task':
          setTaskSource({
            text,
            attribution: channel ? `#${channel.name || 'direct message'}` : undefined,
          });
          break;
      }
      setSelection(null);
    },
    [runAssist, projectPath, settings.chatTranslateLanguage, channel, setSelection],
  );

  const messageActions = useMemo(
    () => ({
      onOpenThread: (message: ChatMessage) => void openThread(message.id),
      onReact: (messageId: string, reaction: string) => void toggleReaction(messageId, reaction),
      onLoadReactions: (messageId: string) => void loadReactions([messageId]),
      onTranslate: (text: string) =>
        void runAssist('translate', { selection: text, language: settings.chatTranslateLanguage, projectPath }),
      onExplain: (text: string) => void runAssist('explain', { selection: text, projectPath }),
      onQuote: (message: ChatMessage) => appendToComposer(quoteOf(message)),
      onCreateTask: (message: ChatMessage) =>
        setTaskSource({
          text: message.content,
          attribution: `${message.user.username} in #${channel?.name || 'direct message'}`,
        }),
      onSendToAgent: activeTerminalId ? sendToAgent : undefined,
    }),
    [openThread, toggleReaction, loadReactions, runAssist, settings.chatTranslateLanguage, projectPath, appendToComposer, channel, activeTerminalId, sendToAgent],
  );

  // Channel members first — the people actually in this conversation are who
  // you mean 90% of the time — then the rest of the workspace.
  const mentionCandidates = useMemo(() => {
    const members = channel?.members || [];
    const seen = new Set(members.map((m) => m.id));
    return [...members, ...people.filter((p) => !seen.has(p.id))];
  }, [channel, people]);

  const headerTitle = channel
    ? channel.name || (channel.kind === 'CHANNEL' ? 'Channel' : 'Direct message')
    : '';

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      <ChannelSidebar
        onNewDm={() => setShowNewDm(true)}
        onOpenAssistant={() => setMode('assistant')}
        assistantActive={mode === 'assistant'}
      />

      {mode === 'assistant' ? (
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-secondary)]/40 shrink-0">
            <Sparkles className="w-4 h-4 text-purple-400" />
            <span className="text-[13px] font-semibold text-[var(--text-primary)]">AI assistant</span>
            <span className="text-[11px] text-[var(--text-muted)]">Runs against this project’s code</span>
            <button
              onClick={() => setMode('chat')}
              className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Back to team chat
            </button>
          </div>
          <div className="flex-1 flex min-h-0">
            <InsightsView />
          </div>
        </div>
      ) : bootstrapError ? (
        <NotConfigured error={bootstrapError} />
      ) : !channel ? (
        <EmptyState onNewDm={() => setShowNewDm(true)} />
      ) : (
        <>
          <div className="flex-1 flex flex-col min-w-0">
            {/* Channel header */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-secondary)]/40 shrink-0">
              {channel.kind === 'CHANNEL' ? (
                channel.visibility === 'PRIVATE'
                  ? <Lock className="w-4 h-4 text-[var(--text-muted)]" />
                  : <Hash className="w-4 h-4 text-[var(--text-muted)]" />
              ) : (
                <Users className="w-4 h-4 text-[var(--text-muted)]" />
              )}
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{headerTitle}</div>
                {/* In a one-to-one, whether they are around right now is the
                    most useful thing the header can say. */}
                {channel.kind === 'DM' && channel.members?.[0] ? (
                  <div className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        presenceOf(presence[channel.members[0].id]) === 'online'
                          ? 'bg-[var(--success)]'
                          : presenceOf(presence[channel.members[0].id]) === 'away'
                            ? 'bg-[var(--warning)]'
                            : 'bg-[var(--text-muted)]',
                      )}
                    />
                    <span className="text-[10px] text-[var(--text-muted)] truncate">
                      {presenceLabel(presence[channel.members[0].id])}
                    </span>
                  </div>
                ) : channel.topic ? (
                  <div className="text-[10px] text-[var(--text-muted)] truncate">{channel.topic}</div>
                ) : null}
              </div>

              {(channel.members?.length || 0) > 0 && (
                <div className="flex -space-x-1.5 ml-2">
                  {channel.members!.slice(0, 4).map((member) => (
                    <Avatar key={member.id} user={member} size="xs" presence className="ring-1 ring-[var(--bg-secondary)]" />
                  ))}
                </div>
              )}

              <div className="ml-auto flex items-center gap-0.5">
                <button
                  onClick={() => void runAssist('summarize', { projectPath })}
                  disabled={assist.running || convo.messages.length === 0}
                  title="Catch me up on this conversation"
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--accent)] disabled:opacity-40"
                >
                  <ScrollText className="w-3.5 h-3.5" />
                  Catch me up
                </button>
                <button
                  onClick={() => void runAssist('action-items', { projectPath })}
                  disabled={assist.running || convo.messages.length === 0}
                  title="Pull out decisions, todos and who owes what"
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--success)] disabled:opacity-40"
                >
                  <ListChecks className="w-3.5 h-3.5" />
                  Action items
                </button>
                <button
                  onClick={() => activeChannelId && void loadMessages(activeChannelId, { force: true })}
                  title="Refresh"
                  className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  <RefreshCw className={cn('w-3.5 h-3.5', convo.loading && 'animate-spin')} />
                </button>
                {channel.url && (
                  <button
                    onClick={() => window.electronAPI.openExternal(channel.url!)}
                    title="Open in ClickUp"
                    className="p-1.5 rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--clickup-purple)]"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {(convo.error || channelsError) && (
              <div className="flex items-center gap-2 px-4 py-1.5 bg-[var(--error)]/10 border-b border-[var(--error)]/30 shrink-0">
                <AlertTriangle className="w-3.5 h-3.5 text-[var(--error)] shrink-0" />
                <p className="flex-1 text-[11px] text-[var(--error)]">{convo.error || channelsError}</p>
                <button
                  onClick={() => clearError(activeChannelId || undefined)}
                  className="p-0.5 rounded hover:bg-[var(--error)]/20 text-[var(--error)]"
                >
                  <X className="w-3.5 h-3.5" />
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
              emptyHint={
                channel.kind === 'CHANNEL'
                  ? `Nothing has been posted in ${headerTitle} yet. Say the first thing.`
                  : `This is the start of your conversation with ${headerTitle}.`
              }
              onLoadOlder={() => activeChannelId && void loadOlder(activeChannelId)}
              onSelectionChange={setSelection}
              onSelectionAction={handleSelectionAction}
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
              onSend={doSend}
              sending={convo.sending}
              disabled={!activeChannelId}
              placeholder={
                channel.kind === 'CHANNEL' ? `Message #${headerTitle}` : `Message ${headerTitle}`
              }
              assistRunning={assist.running}
              language={settings.chatTranslateLanguage || 'vi'}
              onLanguageChange={(language: ChatLanguage) => void updateSettings({ chatTranslateLanguage: language })}
              onSuggest={() => void runAssist('suggest', { selection: selection || undefined, projectPath })}
              onTranslate={() =>
                void runAssist('translate', {
                  draft,
                  language: settings.chatTranslateLanguage,
                  projectPath,
                })
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
              mentionCandidates={mentionCandidates}
              onMention={(m) => activeChannelId && addMention(activeChannelId, m)}
            />
          </div>

          {parentMessage && (
            <ThreadPanel
              parent={parentMessage}
              thread={threads[parentMessage.id] || EMPTY_THREAD}
              me={me}
              onClose={closeThread}
              onSend={(text) => sendThreadReply(parentMessage.id, text)}
            />
          )}
        </>
      )}

      {showNewDm && (
        <NewDmModal
          people={people}
          onClose={() => setShowNewDm(false)}
          onStart={async (userIds) => {
            const id = await startDm(userIds);
            if (id) setMode('chat');
            return id;
          }}
        />
      )}

      {lightbox && (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={closeLightbox} />
      )}

      {taskSource && (
        <CreateTaskModal
          source={taskSource.text}
          attribution={taskSource.attribution}
          onClose={() => setTaskSource(null)}
        />
      )}
    </div>
  );
}
