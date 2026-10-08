import { useState } from 'react';
import type { ChatUser } from '../../../shared/types';
import { presenceLabel, presenceOf } from '../../../shared/types';
import { useChatStore } from '../../stores/chat-store';
import { cn } from '../../../shared/utils';

const SIZES = {
  xs: 'w-5 h-5 text-[9px]',
  sm: 'w-7 h-7 text-[10px]',
  md: 'w-9 h-9 text-xs',
} as const;

export function initialsFor(user: Pick<ChatUser, 'initials' | 'username'>): string {
  if (user.initials) return user.initials.slice(0, 2).toUpperCase();
  const parts = (user.username || '?').trim().split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (user.username || '?').slice(0, 2).toUpperCase();
}

/** ClickUp gives each member a colour; without one, derive a stable colour from
 *  the id so the same person is always the same shade across the page. */
const FALLBACK_COLORS = ['#7c8cff', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#8b7bff', '#f472b6'];

export function colorFor(user: Pick<ChatUser, 'color' | 'id'>): string {
  if (user.color) return user.color;
  let hash = 0;
  for (const char of String(user.id || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

const DOT_SIZES = {
  xs: 'w-1.5 h-1.5',
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
} as const;

const DOT_COLORS = {
  online: 'bg-[var(--success)]',
  away: 'bg-[var(--warning)]',
  offline: 'bg-[var(--text-muted)]',
} as const;

/**
 * Presence dot.
 *
 * Reads the store directly rather than taking a prop: an avatar appears in a
 * dozen places, and threading a live timestamp through every one of them would
 * be a lot of plumbing for one dot. Offline shows nothing — a grey dot on every
 * dormant guest is noise, not information.
 */
function PresenceDot({ userId, size }: { userId: string; size: keyof typeof SIZES }) {
  const lastActiveMs = useChatStore((s) => s.presence[userId]);
  const state = presenceOf(lastActiveMs);
  if (state === 'offline') return null;
  return (
    <span
      title={presenceLabel(lastActiveMs)}
      className={cn(
        'absolute -bottom-px -right-px rounded-full ring-2 ring-[var(--bg-secondary)]',
        DOT_SIZES[size],
        DOT_COLORS[state],
      )}
    />
  );
}

export function Avatar({
  user,
  size = 'sm',
  className,
  presence,
}: {
  user: ChatUser;
  size?: keyof typeof SIZES;
  className?: string;
  /** Show the online/away dot. Off by default — in a transcript every message
   *  would carry one, which is noise rather than signal. */
  presence?: boolean;
}) {
  const color = colorFor(user);
  const [pictureFailed, setPictureFailed] = useState(false);
  const lastActiveMs = useChatStore((s) => s.presence[user.id]);
  const title = presence ? `${user.username} — ${presenceLabel(lastActiveMs)}` : user.username;

  // ClickUp serves these from attachments.clickup.com (allowed in the CSP in
  // index.html). If one still can't be fetched, the initials are a better
  // fallback than a broken-image icon in every message header.
  const face =
    user.profilePicture && !pictureFailed ? (
      <img
        src={user.profilePicture}
        alt={user.username}
        onError={() => setPictureFailed(true)}
        className={cn('rounded-full object-cover w-full h-full')}
      />
    ) : (
      <div
        className="rounded-full flex items-center justify-center w-full h-full font-semibold text-white/95"
        style={{ backgroundColor: color }}
      >
        {initialsFor(user)}
      </div>
    );

  return (
    <div title={title} className={cn('relative shrink-0', SIZES[size], className)}>
      {face}
      {presence && <PresenceDot userId={user.id} size={size} />}
    </div>
  );
}
