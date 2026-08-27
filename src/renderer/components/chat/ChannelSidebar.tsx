import { useMemo, useState } from 'react';
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Hash,
  Loader2,
  Lock,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import type { ChatChannel, ChatUser } from '../../../shared/types';
import { useChatStore, type ChannelUnread } from '../../stores/chat-store';
import { cn } from '../../../shared/utils';
import { Avatar } from './Avatar';

/** "Now", "14:32", "Tue", "12 Mar" — the shortest form that still says when. */
function shortWhen(ms?: number): string {
  if (!ms) return '';
  const date = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 24 * 3_600_000) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 7 * 24 * 3_600_000) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function ChannelIcon({ channel, unread }: { channel: ChatChannel; unread: boolean }) {
  if (channel.kind === 'DM' || channel.kind === 'GROUP_DM') {
    const member = channel.members?.[0];
    if (member) {
      return (
        <div className="relative shrink-0">
          <Avatar user={member} size="sm" presence />
          {channel.kind === 'GROUP_DM' && (channel.members?.length || 0) > 1 && (
            <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[var(--bg-secondary)] flex items-center justify-center">
              <Users className="w-2 h-2 text-[var(--text-muted)]" />
            </span>
          )}
        </div>
      );
    }
    return <div className="w-7 h-7 rounded-full bg-[var(--bg-tertiary)] shrink-0" />;
  }

  // Channels get a glyph tile rather than an avatar, so the eye can tell a
  // room from a person without reading either label.
  const Glyph = channel.visibility === 'PRIVATE' ? Lock : Hash;
  return (
    <div
      className={cn(
        'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors',
        unread ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
      )}
    >
      <Glyph className="w-3.5 h-3.5" />
    </div>
  );
}

/**
 * One conversation in the rail.
 *
 * A row with nothing new is a single compact line. A row with unread messages
 * grows a second line naming the sender and quoting them, because "who just
 * messaged me, and roughly what about" is the question the sidebar exists to
 * answer — a bare dot makes you open every conversation to find out.
 */
function ChannelRow({
  channel,
  active,
  unread,
  onSelect,
  onMarkRead,
}: {
  channel: ChatChannel;
  active: boolean;
  unread?: ChannelUnread;
  onSelect: () => void;
  onMarkRead: () => void;
}) {
  const label = channel.name || (channel.kind === 'CHANNEL' ? 'Channel' : 'Direct message');
  const count = unread?.count || 0;
  const isUnread = count > 0 && !active;
  // In a DM the sender is the conversation, so naming them again is noise.
  const showSender = isUnread && channel.kind !== 'DM' && !!unread?.sender;

  return (
    // The dismiss control is a sibling of the row, not a child: a button
    // nested inside a button is invalid and swallows its own clicks.
    <div className="group relative">
      <button
        onClick={onSelect}
        title={unread?.preview || channel.topic || label}
        className={cn(
          'relative w-full flex items-start gap-2.5 pl-2.5 pr-2 py-1.5 rounded-lg text-left transition-colors',
          active
            ? 'bg-[var(--accent)]/15'
            : isUnread
              ? 'bg-[var(--bg-tertiary)]/40 hover:bg-[var(--bg-tertiary)]'
              : 'hover:bg-[var(--bg-tertiary)]/70',
        )}
      >
        {/* Unread marker rail — reads at a glance down the whole list */}
        {isUnread && (
          <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-[var(--accent)]" />
        )}

        <ChannelIcon channel={channel} unread={isUnread} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'flex-1 min-w-0 truncate text-[13px] leading-5',
                active
                  ? 'text-[var(--text-primary)]'
                  : isUnread
                    ? 'font-semibold text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]',
              )}
            >
              {label}
            </span>
            <span
              className={cn(
                'text-[10px] shrink-0 tabular-nums',
                isUnread ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-muted)]',
                // Hidden under the dismiss control while hovering an unread row.
                isUnread && 'group-hover:opacity-0',
              )}
            >
              {shortWhen(channel.latestCommentAtMs)}
            </span>
          </div>

          {isUnread && unread && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <p className="flex-1 min-w-0 truncate text-[11px] leading-4 text-[var(--text-muted)]">
                {showSender && (
                  <span className="text-[var(--text-secondary)] font-medium">
                    {unread.sender!.username.split(' ')[0]}:{' '}
                  </span>
                )}
                {unread.preview || 'New message'}
              </p>
              <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-[var(--accent)] text-white text-[10px] font-semibold flex items-center justify-center tabular-nums">
                {count > 9 ? '9+' : count}
              </span>
            </div>
          )}
        </div>
      </button>

      {/* Clear a noisy channel without having to open and read it */}
      {isUnread && (
        <button
          onClick={onMarkRead}
          title="Mark as read"
          className="absolute right-1.5 top-1.5 p-1 rounded-md bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-muted)] opacity-0 group-hover:opacity-100 hover:text-[var(--accent)] transition-opacity"
        >
          <Check className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  newCount = 0,
  children,
  defaultOpen = true,
}: {
  title: string;
  count: number;
  /** Conversations in this section with unread messages. */
  newCount?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="truncate">{title}</span>
        <span className="opacity-50">{count}</span>
        {newCount > 0 && (
          <span className="ml-auto px-1.5 py-px rounded-full bg-[var(--accent)]/20 text-[var(--accent)] text-[9px] tabular-nums normal-case tracking-normal">
            {newCount} new
          </span>
        )}
      </button>
      {open && <div className="space-y-px">{children}</div>}
    </div>
  );
}

interface ChannelSidebarProps {
  onNewDm: () => void;
  /** Switches the whole page over to the AI assistant. */
  onOpenAssistant: () => void;
  assistantActive: boolean;
}

/**
 * The left rail: everything the user can open, in one searchable list.
 *
 * Three groups, in the order a person actually reaches for them — the Channels
 * they follow, the people they talk to, and everyone else they could talk to.
 */
export function ChannelSidebar({ onNewDm, onOpenAssistant, assistantActive }: ChannelSidebarProps) {
  const channels = useChatStore((s) => s.channels);
  const people = useChatStore((s) => s.people);
  const loading = useChatStore((s) => s.channelsLoading);
  const error = useChatStore((s) => s.channelsError);
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const showAll = useChatStore((s) => s.showAll);
  const unread = useChatStore((s) => s.unread);
  const selectChannel = useChatStore((s) => s.selectChannel);
  const setShowAll = useChatStore((s) => s.setShowAll);
  const loadChannels = useChatStore((s) => s.loadChannels);
  const startDm = useChatStore((s) => s.startDm);
  const markAllRead = useChatStore((s) => s.markAllRead);
  const markRead = useChatStore((s) => s.markRead);

  const [query, setQuery] = useState('');

  const { rooms, dms, strangers } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (channel: ChatChannel) =>
      !q || (channel.name || '').toLowerCase().includes(q) ||
      (channel.topic || '').toLowerCase().includes(q) ||
      (channel.members || []).some((m) => m.username.toLowerCase().includes(q));

    const visible = channels.filter((c) => !c.archived && matches(c));
    const dmChannels = visible.filter((c) => c.kind !== 'CHANNEL');

    // People with no conversation yet — the "who else can I message" list, so
    // starting a first DM is one click and not a hunt through ClickUp.
    const inConversation = new Set(
      channels.flatMap((c) => (c.kind === 'DM' ? (c.members || []).map((m) => m.id) : [])),
    );
    const rest = people
      .filter((p) => !inConversation.has(p.id))
      .filter((p) => !q || p.username.toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q));

    return {
      rooms: visible.filter((c) => c.kind === 'CHANNEL'),
      dms: dmChannels,
      strangers: rest,
    };
  }, [channels, people, query]);

  // ClickUp exposes no read state to a personal API token, so unread is derived
  // in the chat store from when the user last opened each conversation.
  const totalUnread = Object.entries(unread).reduce(
    (total, [id, entry]) => (id === activeChannelId ? total : total + entry.count),
    0,
  );
  const newIn = (list: ChatChannel[]) =>
    list.filter((c) => (unread[c.id]?.count || 0) > 0 && c.id !== activeChannelId).length;

  return (
    <div className="w-72 shrink-0 border-r border-[var(--border)] bg-[var(--bg-secondary)]/60 flex flex-col">
      {/* Header: what is new, and a way out of a backlog */}
      <div className="p-2 border-b border-[var(--border)] space-y-2">
        <div className="flex items-center gap-2 px-1 pt-0.5">
          <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">Messages</h2>
          {totalUnread > 0 && (
            <>
              <span className="px-1.5 py-px rounded-full bg-[var(--accent)] text-white text-[10px] font-semibold tabular-nums">
                {totalUnread > 99 ? '99+' : totalUnread} new
              </span>
              <button
                onClick={markAllRead}
                title="Mark every conversation as read"
                className="ml-auto flex items-center gap-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              >
                <CheckCheck className="w-3 h-3" />
                Mark read
              </button>
            </>
          )}
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people and channels"
            className="w-full pl-7 pr-7 py-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-transparent focus:border-[var(--accent)]/50 outline-none text-[12px] placeholder:text-[var(--text-muted)]"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-muted)]"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowAll(!showAll)}
            title={showAll ? 'Showing every channel in the workspace' : 'Showing only channels you follow'}
            className={cn(
              'flex-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors',
              showAll
                ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {showAll ? 'All channels' : 'Following'}
          </button>
          <button
            onClick={onNewDm}
            title="New direct message"
            className="p-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)]"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => loadChannels({ force: true })}
            title="Refresh"
            className="p-1.5 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent)]"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5">
        {error && (
          <div className="m-1 p-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[11px] text-[var(--error)]">
            {error}
          </div>
        )}

        {loading && channels.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-[var(--text-muted)] text-xs">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading conversations…
          </div>
        )}

        <Section
          title={showAll ? 'Channels' : 'Channels you follow'}
          count={rooms.length}
          newCount={newIn(rooms)}
        >
          {rooms.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={channel.id === activeChannelId && !assistantActive}
              unread={unread[channel.id]}
              onSelect={() => selectChannel(channel.id)}
              onMarkRead={() => markRead(channel.id)}
            />
          ))}
          {rooms.length === 0 && !loading && (
            <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]">
              {query ? 'No match.' : showAll ? 'No channels here.' : 'You follow no channels yet — switch to "All channels".'}
            </p>
          )}
        </Section>

        <Section title="Direct messages" count={dms.length} newCount={newIn(dms)}>
          {dms.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={channel.id === activeChannelId && !assistantActive}
              unread={unread[channel.id]}
              onSelect={() => selectChannel(channel.id)}
              onMarkRead={() => markRead(channel.id)}
            />
          ))}
          {dms.length === 0 && !loading && (
            <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]">No direct messages yet.</p>
          )}
        </Section>

        {strangers.length > 0 && (
          <Section title="Everyone else" count={strangers.length} defaultOpen={!!query}>
            {strangers.map((person: ChatUser) => (
              <button
                key={person.id}
                onClick={() => startDm([person.id])}
                title={`Message ${person.username}`}
                className="w-full flex items-center gap-2.5 pl-2.5 pr-2 py-1.5 rounded-lg text-left hover:bg-[var(--bg-tertiary)]/70 group"
              >
                <Avatar user={person} size="sm" presence className="opacity-70 group-hover:opacity-100" />
                <span className="flex-1 min-w-0 truncate text-[13px] leading-5 text-[var(--text-secondary)]">
                  {person.username}
                </span>
                <MessageSquarePlus className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 text-[var(--accent)]" />
              </button>
            ))}
          </Section>
        )}
      </div>

      {/* AI assistant lives in the same rail — one page, two kinds of chat. */}
      <button
        onClick={onOpenAssistant}
        className={cn(
          'flex items-center gap-2 m-1.5 px-2 py-2 rounded-lg text-left transition-colors border',
          assistantActive
            ? 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--text-primary)]'
            : 'bg-[var(--bg-tertiary)]/50 border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        )}
      >
        <Sparkles className="w-4 h-4 text-purple-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium truncate">AI assistant</div>
          <div className="text-[10px] text-[var(--text-muted)] truncate">Codebase chat, personas, round table</div>
        </div>
      </button>
    </div>
  );
}
