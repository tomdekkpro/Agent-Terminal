import { spawn } from 'child_process';
import type {
  AgentProviderId,
  CommentAssistKind,
  CommentAssistResult,
  CommentSuggestion,
  TaskComment,
} from '../../shared/types';
import { agentRegistry } from '../ipc/providers/agent-registry';
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

const ASSIST_TIMEOUT_MS = 120_000;
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

/** Pull the first balanced JSON object out of model output that may be wrapped
 *  in prose or fences. */
function extractJson(text: string): any | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], trimmed].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch { /* try the next shape */ }
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch { /* fall through */ }
    }
  }
  return null;
}

type HeadlessAgent = NonNullable<ReturnType<typeof agentRegistry.get>>;

/** Prefer the agent the caller asked for, then Claude, then anything installed
 *  that can run headlessly. */
function pickAgent(preferred?: AgentProviderId): HeadlessAgent | null {
  const usable = (a: HeadlessAgent | null | undefined): a is HeadlessAgent =>
    !!a && !!a.capabilities.headless && a.isAvailable() && !!a.buildHeadlessArgs;

  const wanted = preferred ? agentRegistry.get(preferred) : null;
  if (usable(wanted)) return wanted;
  const claude = agentRegistry.get('claude');
  if (usable(claude)) return claude;
  return agentRegistry.getAll().find((a) => usable(a)) || null;
}

function runHeadless(
  agent: HeadlessAgent,
  args: string[],
  prompt: string,
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Claude refuses to nest inside another Claude session; harmless elsewhere.
    delete env.CLAUDECODE;

    // shell:true so Windows resolves the PATH-installed CLI shim. The prompt
    // goes via stdin (never argv) and the only interpolated args are the
    // validated model and the local cwd.
    const child = spawn(agent.command, args, {
      env,
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.write(prompt);
    child.stdin?.end();

    let settled = false;
    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      reject(new Error(`${agent.displayName} took too long to answer`));
    }, ASSIST_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim().slice(0, 400) || `${agent.displayName} exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });
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
  const agent = pickAgent(req.provider);
  if (!agent?.buildHeadlessArgs) {
    return {
      success: false,
      error: 'No headless-capable agent CLI is installed — install Claude Code to draft replies.',
    };
  }

  // SECURITY: `model` reaches argv under shell:true. Must start alphanumeric
  // (blocks leading-`-` flag smuggling) and hold only model-id characters.
  const model = req.model;
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    return { success: false, error: `Invalid model "${model}" — refusing to run` };
  }

  const cwd = req.cwd || process.cwd();
  const args = agent.buildHeadlessArgs({ model, cwd, jsonOutput: true });
  if (!args) {
    return { success: false, error: `${agent.displayName} does not support headless runs` };
  }

  try {
    const stdout = await runHeadless(agent, args, buildPrompt(req), cwd);
    const answer = agent.parseHeadlessResult?.(stdout)?.summary || stdout;
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
  } catch (error) {
    debugError('[CommentAssist] run failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to draft a reply',
    };
  }
}
