/**
 * One-shot, text-only runs of the local agent CLI.
 *
 * Several features need the same thing: hand a prompt to whichever agent is
 * installed, get text back, parse the JSON it was asked for. No tools, no
 * filesystem, no session. This module owns that; the callers own the prompts.
 */
import { spawn } from 'child_process';
import { statSync } from 'fs';
import type { AgentProviderId } from '../../shared/types';
import { agentRegistry } from '../ipc/providers/agent-registry';

export const ASSIST_TIMEOUT_MS = 120_000;

/** Keeps the run cheap and predictable, matching the auto-code default rather
 *  than the CLI's interactive default (Opus). */
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

type HeadlessAgent = NonNullable<ReturnType<typeof agentRegistry.get>>;

/**
 * Argv for a one-shot, text-only run.
 *
 * Deliberately NOT agent.buildHeadlessArgs(): that builder exists for the
 * auto-code loop, so it grants the agent the filesystem (`--add-dir <cwd>`,
 * `--dangerously-skip-permissions`, `--yolo`) — which drafting text has no use
 * for. It also puts a local path into argv, and argv is concatenated into a
 * shell command line below (see runHeadless), so a project folder containing
 * `&` or `"` would break out of it. Every element returned here is a constant
 * except `model`, which is validated against a strict pattern before use.
 *
 * Returns null for agents this run cannot drive non-interactively.
 */
function buildAssistArgs(agentId: AgentProviderId, model?: string): string[] | null {
  switch (agentId) {
    case 'claude':
      // -p = single-shot print mode; the prompt arrives on stdin.
      return ['--output-format', 'json', '--model', model || DEFAULT_CLAUDE_MODEL, '-p'];
    case 'gemini': {
      // Gemini CLI goes non-interactive on its own when stdin is piped.
      const args: string[] = [];
      if (model) args.push('-m', model);
      return args;
    }
    default:
      return null;
  }
}

/** Prefer the agent the caller asked for, then Claude, then any installed agent
 *  this module knows how to drive for a text-only run. */
function pickAgent(preferred?: AgentProviderId): HeadlessAgent | null {
  const usable = (a: HeadlessAgent | null | undefined): a is HeadlessAgent =>
    !!a && !!buildAssistArgs(a.id) && a.isAvailable();

  const wanted = preferred ? agentRegistry.get(preferred) : null;
  if (usable(wanted)) return wanted;
  const claude = agentRegistry.get('claude');
  if (usable(claude)) return claude;
  return agentRegistry.getAll().find((a) => usable(a)) || null;
}

/** A directory the child can actually start in. The path never reaches the
 *  shell (spawn passes `cwd` to the OS, not to the command line), but it must
 *  exist or spawn fails with ENOENT — projects get moved and deleted. */
function resolveCwd(preferred?: string): string {
  for (const candidate of [preferred, process.cwd()]) {
    if (!candidate) continue;
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch { /* gone — try the next */ }
  }
  return process.cwd();
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

    // shell:true is required on Windows, where the agent CLIs are .cmd shims
    // that spawn cannot execute directly. That makes argv a shell command line,
    // so nothing user-influenced may appear in it: `agent.command` comes from
    // the built-in registry, `args` is constants plus a strictly-validated
    // model (see buildAssistArgs), the prompt goes in over stdin, and `cwd` is
    // handed to the OS as the child's working directory rather than being
    // concatenated into the command line.
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

/** Pull the first balanced JSON object out of model output that may be wrapped
 *  in prose or fences. */
export function extractJson(text: string): any | null {
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

export interface HeadlessRunRequest {
  prompt: string;
  /** Working directory for the CLI. Any real directory works — the run is pure
   *  text generation and reads no files. */
  cwd?: string;
  provider?: AgentProviderId;
  model?: string;
  /** Shown in the "no agent installed" error, e.g. "draft replies". */
  purpose?: string;
}

export type HeadlessRunResult =
  | { success: true; text: string }
  | { success: false; error: string };

/** Run one prompt through the best available agent CLI and return its text. */
export async function runHeadlessPrompt(req: HeadlessRunRequest): Promise<HeadlessRunResult> {
  const purpose = req.purpose || 'answer';
  const agent = pickAgent(req.provider);
  if (!agent) {
    return {
      success: false,
      error: `No headless-capable agent CLI is installed — install Claude Code to ${purpose}.`,
    };
  }

  // SECURITY: `model` is the only caller-supplied value that reaches argv, and
  // argv becomes a shell command line (shell:true — see runHeadless). It must
  // start alphanumeric (blocks leading-`-` flag smuggling) and hold only
  // model-id characters, which rules out shell metacharacters entirely.
  const model = req.model;
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    return { success: false, error: `Invalid model "${model}" — refusing to run` };
  }

  const args = buildAssistArgs(agent.id, model);
  if (!args) {
    return { success: false, error: `${agent.displayName} cannot ${purpose} non-interactively` };
  }

  try {
    const stdout = await runHeadless(agent, args, req.prompt, resolveCwd(req.cwd));
    return { success: true, text: agent.parseHeadlessResult?.(stdout)?.summary || stdout };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : `Failed to ${purpose}`,
    };
  }
}
