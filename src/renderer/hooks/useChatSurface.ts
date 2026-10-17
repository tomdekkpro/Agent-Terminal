import { useEffect } from 'react';
import { useChatStore, type ChatSurface } from '../stores/chat-store';
import { useSettingsStore } from '../stores/settings-store';

/**
 * Shared behaviour for anything showing a ClickUp Chat transcript.
 *
 * Both surfaces — the full Chat page and the dock that rides along beside
 * every other page — have to do the same two things: tell the store they are
 * on screen (so the conversation being read is exempt from unread counting),
 * and keep the open conversation fresh. Doing it here means the two can never
 * drift apart, and a surface that is mounted-but-hidden (the Chat page while
 * the AI assistant is showing) counts as closed.
 *
 * The channel LIST is not polled here — App owns that single poller, so the
 * sidebar and the rail badge stay correct whether or not a transcript is open.
 */
export function useChatSurface(surface: ChatSurface, active: boolean): void {
  const setViewing = useChatStore((s) => s.setViewing);
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const pollSeconds = useSettingsStore((s) => s.settings.chatPollSeconds);

  useEffect(() => {
    setViewing(surface, active);
    return () => setViewing(surface, false);
  }, [surface, active, setViewing]);

  useEffect(() => {
    if (!active || !activeChannelId) return;
    const seconds = pollSeconds ?? 20;
    if (!seconds) return;
    // Background lane: a poll must never outbid a click for ClickUp's budget.
    const timer = setInterval(() => {
      void loadMessages(activeChannelId, { force: true, background: true });
    }, Math.max(seconds, 5) * 1000);
    return () => clearInterval(timer);
  }, [active, activeChannelId, pollSeconds, loadMessages]);
}
