/**
 * IPC for the Chat page.
 *
 * Thin: every handler resolves settings and forwards to the ClickUp Chat
 * client, except CHAT_ASSIST, which takes the conversation the renderer is
 * already showing rather than paying for a second read of it.
 */
import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  AgentProviderId,
  ChatAssistKind,
  ChatLanguage,
  ChatMessage,
} from '../../shared/types';
import { runChatAssist } from '../ai/chat-assist';
import { getSettings } from './settings-handlers';
import {
  cancelUpload,
  createDirectMessage,
  getChannelMembers,
  getChannels,
  getMe,
  getMessages,
  getPeople,
  getPresence,
  getReactions,
  getReplies,
  react,
  sendMessage,
  sendReply,
  uploadFile,
  unreact,
} from './providers/clickup-chat';
import { ClickUpProvider } from './providers';

const provider = new ClickUpProvider();

/** Chat is ClickUp-only. Saying so beats a 401 from a Jira-configured install. */
function requireClickUp(): { ok: true } | { ok: false; error: string } {
  const settings = getSettings();
  if (settings.taskManagerProvider !== 'clickup') {
    return { ok: false, error: 'Chat needs ClickUp as the task manager — set it in Settings → Tasks.' };
  }
  return { ok: true };
}

export function registerChatHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_CHANNELS,
    async (_event, opts?: { followingOnly?: boolean; background?: boolean; force?: boolean }) => {
      const gate = requireClickUp();
      if (!gate.ok) return { success: false, error: gate.error };
      return getChannels(getSettings(), opts);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_MESSAGES,
    async (_event, channelId: string, opts?: { cursor?: string | null; limit?: number; background?: boolean }) => {
      const gate = requireClickUp();
      if (!gate.ok) return { success: false, error: gate.error };
      return getMessages(getSettings(), channelId, opts);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SEND_MESSAGE,
    async (_event, channelId: string, content: string) => {
      const gate = requireClickUp();
      if (!gate.ok) return { success: false, error: gate.error };
      return sendMessage(getSettings(), channelId, content);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_REPLIES,
    async (_event, messageId: string, opts?: { cursor?: string | null; background?: boolean }) => {
      const gate = requireClickUp();
      if (!gate.ok) return { success: false, error: gate.error };
      return getReplies(getSettings(), messageId, opts);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHAT_SEND_REPLY,
    async (_event, messageId: string, content: string) => {
      const gate = requireClickUp();
      if (!gate.ok) return { success: false, error: gate.error };
      return sendReply(getSettings(), messageId, content);
    },
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_CHANNEL_MEMBERS, async (_event, channelId: string) => {
    const gate = requireClickUp();
    if (!gate.ok) return { success: false, error: gate.error };
    return getChannelMembers(getSettings(), channelId);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_CREATE_DM, async (_event, userIds: string[]) => {
    const gate = requireClickUp();
    if (!gate.ok) return { success: false, error: gate.error };
    return createDirectMessage(getSettings(), userIds);
  });

  /** Reactions for a page of messages. ClickUp ships none with the message
   *  list, so this is deliberately capped and cached — see getReactions. */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_REACTIONS,
    async (_event, messageIds: string[], opts?: { background?: boolean; force?: boolean }) => {
      const gate = requireClickUp();
      if (!gate.ok) return { success: false, error: gate.error };
      return getReactions(getSettings(), messageIds, opts);
    },
  );

  ipcMain.handle(IPC_CHANNELS.CHAT_REACT, async (_event, messageId: string, reaction: string) => {
    const gate = requireClickUp();
    if (!gate.ok) return { success: false, error: gate.error };
    return react(getSettings(), messageId, reaction);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_UNREACT, async (_event, messageId: string, reaction: string) => {
    const gate = requireClickUp();
    if (!gate.ok) return { success: false, error: gate.error };
    return unreact(getSettings(), messageId, reaction);
  });

  /** Page bootstrap: who I am plus everyone I could start a DM with, in one
   *  round trip so the sidebar has both before its first paint. */
  ipcMain.handle(IPC_CHANNELS.CHAT_ME, async () => {
    const gate = requireClickUp();
    if (!gate.ok) return { success: false, error: gate.error };
    const settings = getSettings();
    const [me, people] = await Promise.all([getMe(settings), getPeople(settings)]);
    if (!me.success) return me;
    return { success: true, data: { me: me.data, people: people.success ? people.data : [] } };
  });

  /** Upload one staged file and hand back the URL to reference it by. See
   *  uploadFile — Chat has no attachment API, so this goes to a task. */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPLOAD_FILE,
    async (_event, file: { name: string; mime: string; data: string }, uploadId?: string) => {
      const gate = requireClickUp();
      if (!gate.ok) return { success: false, error: gate.error };
      return uploadFile(getSettings(), file, uploadId);
    },
  );

  /** Abort an upload the user gave up on. Safe to call for an id that has
   *  already finished — it simply does nothing. */
  ipcMain.handle(IPC_CHANNELS.CHAT_CANCEL_UPLOAD, async (_event, uploadId: string) =>
    cancelUpload(uploadId),
  );

  /** When each member was last active in ClickUp — the basis for the presence
   *  dots. See getPresence: ClickUp has no realtime presence channel. */
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_PRESENCE, async () => {
    const gate = requireClickUp();
    if (!gate.ok) return { success: false, error: gate.error };
    return getPresence(getSettings());
  });

  /**
   * AI help on the open conversation.
   *
   * The renderer passes the messages it is showing: they were fetched a moment
   * ago through this same process, and re-reading them here would spend ClickUp
   * budget to arrive at the same text the user is already looking at.
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_ASSIST,
    async (
      _event,
      req: {
        kind: ChatAssistKind;
        channel: { name: string; kind: string; topic?: string };
        messages: ChatMessage[];
        selection?: string;
        draft?: string;
        language?: ChatLanguage;
        tone?: 'polite' | 'shorter' | 'direct' | 'formal';
        projectPath?: string;
        provider?: AgentProviderId;
        model?: string;
      },
    ) => {
      const settings = getSettings();
      const me = await getMe(settings);
      return runChatAssist({
        kind: req.kind,
        channel: req.channel,
        messages: Array.isArray(req.messages) ? req.messages : [],
        selection: req.selection,
        draft: req.draft,
        language: req.language || settings.chatTranslateLanguage,
        tone: req.tone,
        me: me.success ? { id: me.data.id, username: me.data.username } : null,
        cwd: req.projectPath,
        provider: req.provider,
        model: req.model,
      });
    },
  );

  /**
   * Turn a chat message into a ClickUp task.
   *
   * The single most common thing that happens to a message in a dev team's
   * chat — "can you make a ticket for this?" — done without leaving the page.
   */
  ipcMain.handle(
    IPC_CHANNELS.CHAT_CREATE_TASK_FROM_MESSAGE,
    async (_event, req: { name: string; description?: string; listId?: string; assigneeIds?: string[] }) => {
      const gate = requireClickUp();
      if (!gate.ok) return { success: false, error: gate.error };
      const settings = getSettings();
      const listId = (req.listId || settings.clickupListId || '').trim();
      if (!listId) {
        return { success: false, error: 'No ClickUp list configured — set a default list in Settings → Tasks.' };
      }
      const name = (req.name || '').trim().slice(0, 200);
      if (!name) return { success: false, error: 'The task needs a title' };

      return provider.createTask(settings, listId, {
        name,
        description: req.description,
        assignees: (req.assigneeIds || []).map((id) => Number(id)).filter((n) => Number.isFinite(n)),
      });
    },
  );
}
