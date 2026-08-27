/**
 * AI help for the Chat page.
 *
 * Everything here is text-in/text-out: the caller has already resolved the
 * conversation and the selection, so this module never touches ClickUp. Six
 * jobs, one prompt builder each, all answered by a single headless CLI run.
 */
import type {
  AgentProviderId,
  ChatAssistKind,
  ChatAssistResult,
  ChatLanguage,
  ChatMessage,
  ChatSuggestion,
} from '../../shared/types';
import { extractJson, runHeadlessPrompt } from './headless-agent';
import { debugError } from '../../shared/utils';

export interface ChatAssistRequest {
  kind: ChatAssistKind;
  /** Where the conversation is happening, for context in the prompt. */
  channel: { name: string; kind: string; topic?: string };
  /** Recent messages, oldest first. */
  messages: ChatMessage[];
  /** Text the user highlighted. Drives 'explain', and narrows 'summarize'
   *  and 'translate' to just that passage. */
  selection?: string;
  /** What the user has typed into the composer. Turns 'suggest' into "polish
   *  this" and is what 'translate'/'rewrite' operate on when there's no
   *  selection. */
  draft?: string;
  /** Target for 'translate'. */
  language?: ChatLanguage;
  /** Tone for 'rewrite'. */
  tone?: 'polite' | 'shorter' | 'direct' | 'formal';
  /** Who "I" am, so drafts are written in the right voice. */
  me?: { id: string; username: string } | null;
  cwd?: string;
  provider?: AgentProviderId;
  model?: string;
}

/** Messages included in the prompt, newest last. Enough for the thread's arc
 *  without paying for a year of chatter. */
const MAX_PROMPT_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 1000;
const MAX_SELECTION_CHARS = 6000;
const MAX_DRAFT_CHARS = 4000;

const LANGUAGE_NAMES: Record<ChatLanguage, string> = {
  vi: 'Vietnamese',
  en: 'English',
  no: 'Norwegian (bokmål)',
};

const TONE_RULES: Record<NonNullable<ChatAssistRequest['tone']>, string> = {
  polite: 'Warmer and more polite, without becoming wordy or obsequious.',
  shorter: 'As short as it can be while keeping every fact. Cut filler ruthlessly.',
  direct: 'Direct and unambiguous. Say the thing; drop the hedging.',
  formal: 'Professional and neutral, suitable for a customer or a manager.',
};

function truncate(text: string, max: number): string {
  const clean = (text || '').trim();
  return clean.length > max ? `${clean.slice(0, max)}…(truncated)` : clean;
}

/** Strip the noise that makes a chat log expensive and hard to read: pasted
 *  image markdown collapses to a marker, long bodies get cut. */
function renderMessage(message: ChatMessage, me?: { id: string } | null): string {
  const who = me && message.user.id && message.user.id === me.id
    ? `${message.user.username} (me)`
    : message.user.username;
  const when = message.createdAtMs
    ? new Date(message.createdAtMs).toISOString().slice(0, 16).replace('T', ' ')
    : '';
  const body = (message.content || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image]')
    .trim();
  const thread = message.replyCount > 0 ? ` [${message.replyCount} repl${message.replyCount === 1 ? 'y' : 'ies'} in thread]` : '';
  return `--- ${who} · ${when}${thread}\n${truncate(body, MAX_MESSAGE_CHARS) || '[no text]'}`;
}

function renderConversation(req: ChatAssistRequest): string {
  const recent = req.messages.slice(-MAX_PROMPT_MESSAGES);
  if (recent.length === 0) return '(no messages yet)';
  return recent.map((m) => renderMessage(m, req.me)).join('\n');
}

function channelHeader(req: ChatAssistRequest): string {
  const where = req.channel.kind === 'CHANNEL'
    ? `CHANNEL #${req.channel.name}`
    : `DIRECT MESSAGE with ${req.channel.name}`;
  return [where, req.channel.topic ? `Topic: ${req.channel.topic}` : ''].filter(Boolean).join('\n');
}

const NO_TOOLS = 'Do not use any tools and do not read any files — answer from the text above alone.';

const HOUSE_STYLE = [
  '- Write in the language the conversation is written in, unless told otherwise.',
  '- Never invent facts, dates, ticket numbers, commits or promises that the text above does not support.',
  '  If something is unknown, ask for it instead of guessing.',
  '- Plain and specific. No greetings, no sign-offs, no corporate filler, no emoji unless the conversation uses them.',
];

function buildPrompt(req: ChatAssistRequest): string {
  const header = channelHeader(req);
  const conversation = renderConversation(req);
  const selection = truncate(req.selection || '', MAX_SELECTION_CHARS);
  const draft = truncate(req.draft || '', MAX_DRAFT_CHARS);
  const meLine = req.me?.username
    ? `You are writing as ${req.me.username}, a software developer on this team.`
    : 'You are writing as a software developer on this team.';

  switch (req.kind) {
    case 'summarize': {
      // A highlighted passage means "explain THIS to me", not "recap the room".
      const target = selection
        ? ['THE PASSAGE TO SUMMARIZE:', '"""', selection, '"""', '', 'Use the conversation above only as background.']
        : [];
      return [
        'You are catching a developer up on a team chat conversation.',
        '',
        header,
        '',
        'CONVERSATION (oldest first):',
        conversation,
        '',
        ...target,
        '',
        'Write a short Markdown digest. Omit any section that has nothing in it:',
        '- **What this is about** — one or two sentences.',
        '- **Decisions** — what has been agreed, and by whom.',
        '- **Open questions** — what is unanswered, and who is waiting on whom.',
        '- **Anything for me** — requests, mentions or deadlines aimed at me. Say "nothing" if there are none.',
        '',
        ...HOUSE_STYLE,
        '',
        NO_TOOLS,
        'Reply with ONLY a JSON object, no prose and no code fences:',
        '{"summary": "<markdown>"}',
      ].join('\n');
    }

    case 'explain': {
      return [
        'A developer highlighted part of a team chat message and wants to know what it means.',
        'They may be reading a language they are not fluent in, or unfamiliar jargon,',
        'or an abbreviation only this team uses.',
        '',
        header,
        '',
        'CONVERSATION (oldest first, for context):',
        conversation,
        '',
        'THE HIGHLIGHTED TEXT:',
        '"""',
        selection || '(nothing highlighted — explain the most recent message instead)',
        '"""',
        '',
        'Answer in Markdown, in at most 6 short lines:',
        '- What it says, in plain words.',
        '- Any jargon, abbreviation or product name in it, spelled out.',
        '- What (if anything) it is asking of the reader.',
        '',
        'Write in English unless the highlighted text is already English, in which',
        'case still answer in English. Do not translate it — explain it.',
        '',
        NO_TOOLS,
        'Reply with ONLY a JSON object, no prose and no code fences:',
        '{"summary": "<markdown>"}',
      ].join('\n');
    }

    case 'translate': {
      const language = LANGUAGE_NAMES[req.language || 'vi'];
      const source = selection || draft;
      return [
        `You are translating team chat text into ${language}.`,
        '',
        header,
        '',
        'CONVERSATION (oldest first, for context — names, products and ticket ids should keep their original form):',
        conversation,
        '',
        'TEXT TO TRANSLATE:',
        '"""',
        source || '(nothing to translate)',
        '"""',
        '',
        `Translate it into ${language}. Rules:`,
        '- Keep it natural, the way a developer on this team would actually write it — not a literal word-for-word rendering.',
        '- Leave code, file paths, ticket ids (like DP2-12345), product names, @mentions and URLs exactly as they are.',
        '- Keep the Markdown structure, line breaks and lists intact.',
        '- Translate only. Do not answer, summarize, or add anything.',
        '',
        NO_TOOLS,
        'Reply with ONLY a JSON object, no prose and no code fences:',
        '{"text": "<translation>"}',
      ].join('\n');
    }

    case 'action-items': {
      return [
        'You are pulling the actionable parts out of a team chat conversation.',
        '',
        header,
        '',
        'CONVERSATION (oldest first):',
        conversation,
        '',
        selection ? `Focus on this passage:\n"""\n${selection}\n"""\n` : '',
        'List every concrete action the conversation implies, as a Markdown checklist.',
        'For each one give: what has to be done, who owes it (a name from the',
        'conversation, or "unassigned"), and any deadline that was actually stated.',
        'If a ticket id is mentioned, keep it. If there are no actions, say so in one line.',
        '',
        ...HOUSE_STYLE,
        '',
        NO_TOOLS,
        'Reply with ONLY a JSON object, no prose and no code fences:',
        '{"summary": "<markdown checklist>"}',
      ].join('\n');
    }

    case 'rewrite': {
      const rule = TONE_RULES[req.tone || 'polite'];
      return [
        'You are polishing a chat message a developer is about to send.',
        meLine,
        '',
        header,
        '',
        'CONVERSATION (oldest first, so the message fits what came before):',
        conversation,
        '',
        'THEIR DRAFT:',
        '"""',
        draft || selection || '(empty)',
        '"""',
        '',
        `Rewrite it. Target: ${rule}`,
        '- Keep every fact, number, name and ticket id. Add nothing that is not in the draft.',
        '- Keep the same language as the draft.',
        '- Return the message body only — no preamble, no explanation of what you changed.',
        '',
        NO_TOOLS,
        'Reply with ONLY a JSON object, no prose and no code fences:',
        '{"text": "<rewritten message>"}',
      ].join('\n');
    }

    case 'suggest':
    default: {
      const intent = draft
        ? [
            'The developer already started writing this reply — treat it as the intent to express,',
            'and return polished versions of it (fix wording, add what is obviously missing):',
            '"""',
            draft,
            '"""',
          ].join('\n')
        : 'The developer has not started writing. Offer distinct, useful angles for the next reply.';
      const focus = selection
        ? `They are replying specifically to this:\n"""\n${selection}\n"""\n`
        : '';

      return [
        'You are helping a developer reply in a team chat (ClickUp Chat).',
        meLine,
        '',
        header,
        '',
        'CONVERSATION (oldest first):',
        conversation,
        '',
        focus,
        intent,
        '',
        'Draft exactly 3 alternative replies. Rules:',
        '- Answer what was actually asked in the most recent messages; address the newest first.',
        '- Keep each reply short (1-4 sentences).',
        ...HOUSE_STYLE,
        '- Make the three genuinely different (e.g. a direct answer, a question back, a status update),',
        '  and give each a 2-5 word title describing its angle.',
        '',
        NO_TOOLS,
        'Reply with ONLY a JSON object, no prose and no code fences:',
        '{"suggestions": [{"title": "<angle>", "text": "<reply>"}]}',
      ].join('\n');
    }
  }
}

/** Kinds that hand back a single body meant to replace the composer's text,
 *  as opposed to a digest the user reads or a set of options they pick from. */
const TEXT_KINDS: ChatAssistKind[] = ['translate', 'rewrite'];

/**
 * Run one Chat AI request.
 *
 * Falls back to the raw model output when the answer isn't the JSON it was
 * asked for, so the user still sees something usable instead of an error.
 */
export async function runChatAssist(
  req: ChatAssistRequest,
): Promise<{ success: true; data: ChatAssistResult } | { success: false; error: string }> {
  const purpose = req.kind === 'translate' ? 'translate' : 'draft replies';
  const run = await runHeadlessPrompt({
    prompt: buildPrompt(req),
    cwd: req.cwd,
    provider: req.provider,
    model: req.model,
    purpose,
  });

  if (!run.success) {
    debugError('[ChatAssist] run failed:', run.error);
    return { success: false, error: run.error };
  }

  const answer = run.text.trim();
  const parsed = extractJson(answer);

  if (req.kind === 'suggest') {
    const rawList = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
    const suggestions: ChatSuggestion[] = rawList
      .map((s: any, i: number) => ({
        title: String(s?.title || `Option ${i + 1}`).trim().slice(0, 60),
        text: String(s?.text || '').trim(),
      }))
      .filter((s: ChatSuggestion) => s.text.length > 0)
      .slice(0, 5);
    if (suggestions.length > 0) return { success: true, data: { kind: 'suggest', suggestions } };
    return { success: true, data: { kind: 'suggest', raw: answer } };
  }

  if (TEXT_KINDS.includes(req.kind)) {
    const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    if (text) return { success: true, data: { kind: req.kind, text } };
    return { success: true, data: { kind: req.kind, raw: answer } };
  }

  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
  if (summary) return { success: true, data: { kind: req.kind, summary } };
  return { success: true, data: { kind: req.kind, raw: answer } };
}
