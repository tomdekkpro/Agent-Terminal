import type {
  AgentProviderId,
  CommentAssistKind,
  CommentAssistResult,
  CommentSuggestion,
  TaskComment,
} from '../../shared/types';
import { extractJson, runHeadlessPrompt } from './headless-agent';
import { debugError } from '../../shared/utils';

/** A comment-panel AI request. The caller resolves the thread and the task
 *  summary first, so this module never talks to the task manager itself — it
 *  only turns text into text. */
export interface CommentAssistRequest {
  kind: CommentAssistKind;
  task: {
    label: string;
    name: string;
    status?: string;
    url?: string;
    description?: string;
  };
  comments: TaskComment[];
  /** Rough draft or intent the user typed into the composer. When present the
   *  suggestions are polished versions of THIS, not free-form replies. */
  draft?: string;
  /** Who "I" am in the thread, so the drafts are written in the right voice. */
  me?: { id: string; username: string } | null;
  /** Working directory for the CLI. Any real directory works — the run is pure
   *  text generation and reads no files. */
  cwd?: string;
  provider?: AgentProviderId;
  model?: string;
}

/** Comments included in the prompt, newest last. Enough for the thread's arc
 *  without paying for a year of chatter. */
const MAX_PROMPT_COMMENTS = 40;
const MAX_COMMENT_CHARS = 1200;
const MAX_DESCRIPTION_CHARS = 2000;

function truncate(text: string, max: number): string {
  const clean = (text || '').trim();
  return clean.length > max ? `${clean.slice(0, max)}…(truncated)` : clean;
}

function renderThread(comments: TaskComment[], me?: { id: string } | null): string {
  const recent = comments.slice(-MAX_PROMPT_COMMENTS);
  if (recent.length === 0) return '(no comments yet)';
  return recent
    .map((c) => {
      const who = me && c.user.id && c.user.id === me.id ? `${c.user.username} (me)` : c.user.username;
      const when = c.createdAtMs ? new Date(c.createdAtMs).toISOString().slice(0, 16).replace('T', ' ') : '';
      const tag = c.bot ? ' [posted by Agent Terminal automation]' : '';
      return `--- ${who}${tag} · ${when}\n${truncate(c.text, MAX_COMMENT_CHARS)}`;
    })
    .join('\n');
}

function buildPrompt(req: CommentAssistRequest): string {
  const { task } = req;
  const header = [
    `TASK ${task.label}: ${task.name}`,
    task.status ? `Status: ${task.status}` : '',
    task.url ? `URL: ${task.url}` : '',
    task.description ? `Description:\n${truncate(task.description, MAX_DESCRIPTION_CHARS)}` : '',
  ].filter(Boolean).join('\n');

  const thread = renderThread(req.comments, req.me);
  const meLine = req.me?.username
    ? `You are drafting on behalf of ${req.me.username}, the developer working on this task.`
    : 'You are drafting on behalf of the developer working on this task.';

  if (req.kind === 'summarize') {
    return [
      'You are summarizing a task-tracker comment thread for the developer who owns the task.',
      '',
      header,
      '',
      'COMMENT THREAD (oldest first):',
      thread,
      '',
      'Write a short Markdown digest with these sections, omitting any that have nothing in them:',
      '- **State** — one or two sentences on where the task stands.',
      '- **Decisions** — what has been agreed.',
      '- **Open questions** — anything unanswered, and who is waiting on whom.',
      '- **My next action** — the single most useful thing the developer should do next.',
      '',
      'Write in the language the thread is written in. Be specific, quote names and',
      'numbers from the thread, and never invent facts that are not in it.',
      '',
      'Do not use any tools — answer from the text above alone.',
      'Reply with ONLY a JSON object, no prose and no code fences:',
      '{"summary": "<markdown>"}',
    ].join('\n');
  }

  const intent = req.draft?.trim()
    ? [
        'The developer already started writing this reply — treat it as the intent to express,',
        'and return polished versions of it (fix wording, add what is obviously missing):',
        '"""',
        truncate(req.draft, 2000),
        '"""',
      ].join('\n')
    : 'The developer has not started writing. Offer distinct, useful angles for the next reply.';

  return [
    'You are helping a developer reply to a comment thread on a task tracker (ClickUp).',
    meLine,
    '',
    header,
    '',
    'COMMENT THREAD (oldest first):',
    thread,
    '',
    intent,
    '',
    'Draft exactly 3 alternative replies. Rules:',
    '- Answer what was actually asked in the most recent comments; address the newest first.',
    '- Write in the language the thread is written in.',
    '- Keep each reply short (1-4 sentences), plain and specific. No greetings, no sign-offs,',
    '  no corporate filler, no emoji unless the thread uses them.',
    '- Never invent facts, dates, commits or promises that are not supported by the text above.',
    '  If something is unknown, the reply should ask for it instead of guessing.',
    '- Make the three genuinely different (e.g. an answer, a question back, a status update),',
    '  and give each a 2-5 word title describing its angle.',
    '',
    'Do not use any tools — answer from the text above alone.',
    'Reply with ONLY a JSON object, no prose and no code fences:',
    '{"suggestions": [{"title": "<angle>", "text": "<reply>"}]}',
  ].join('\n');
}

/**
 * Draft replies for — or summarize — a task's comment thread.
 *
 * Runs the local agent CLI once, headlessly, with the thread in the prompt and
 * no tools needed, then parses the JSON it was asked for. Falls back to
 * handing back the raw text when the model answers in prose, so the user still
 * gets something usable instead of an error.
 */
export async function runCommentAssist(
  req: CommentAssistRequest,
): Promise<{ success: true; data: CommentAssistResult } | { success: false; error: string }> {
  const run = await runHeadlessPrompt({
    prompt: buildPrompt(req),
    cwd: req.cwd,
    provider: req.provider,
    model: req.model,
    purpose: 'draft replies',
  });

  if (!run.success) {
    debugError('[CommentAssist] run failed:', run.error);
    return { success: false, error: run.error };
  }

  const answer = run.text;
  const parsed = extractJson(answer);

  if (req.kind === 'summarize') {
    const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
    if (summary) return { success: true, data: { kind: 'summarize', summary } };
    return { success: true, data: { kind: 'summarize', raw: answer.trim() } };
  }

  const rawList = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const suggestions: CommentSuggestion[] = rawList
    .map((s: any, i: number) => ({
      title: String(s?.title || `Option ${i + 1}`).trim().slice(0, 60),
      text: String(s?.text || '').trim(),
    }))
    .filter((s: CommentSuggestion) => s.text.length > 0)
    .slice(0, 5);

  if (suggestions.length > 0) return { success: true, data: { kind: 'suggest', suggestions } };
  return { success: true, data: { kind: 'suggest', raw: answer.trim() } };
}
