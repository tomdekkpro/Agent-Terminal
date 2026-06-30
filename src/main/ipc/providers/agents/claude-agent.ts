import { execSync } from 'child_process';
import type { IAgentProvider } from '../agent-types';
import type {
  AgentCapabilities,
  AgentModelOption,
  AgentInvokeOptions,
  AgentSettingsField,
  AgentUsageData,
  InsightsMessage,
  InsightsModel,
} from '../../../../shared/types';

const COST_PATTERN = /(?:Total )?Cost:?\s*\$([0-9.]+)/i;
const INPUT_TOKENS_PATTERN = /(?:Input tokens|Tokens in):?\s*([0-9,]+)/i;
const OUTPUT_TOKENS_PATTERN = /(?:Output tokens|Tokens out):?\s*([0-9,]+)/i;
const EXIT_PATTERNS = [/Goodbye!?\s*$/im, /Session ended/i];

const INSIGHTS_MODEL_MAP: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

export class ClaudeAgentProvider implements IAgentProvider {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly command = 'claude';
  readonly iconName = 'Bot';
  readonly color = '#6366f1';
  readonly installHint = 'Install with: npm install -g @anthropic-ai/claude-code';
  readonly capabilities: AgentCapabilities = {
    resume: true,
    continue: true,
    yolo: true,
    sessionDetection: true,
    remoteControl: true,
    insights: true,
    headless: true,
  };

  isAvailable(): boolean {
    try {
      const check = process.platform === 'win32' ? `where ${this.command}` : `which ${this.command}`;
      execSync(check, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  buildInvokeCommand(options: AgentInvokeOptions): string {
    let cmd = this.command;
    if (options.worktreeName) cmd += ` --worktree "${options.worktreeName}"`;
    if (options.skipPermissions) cmd += ' --dangerously-skip-permissions';
    if (options.model) cmd += ` --model ${options.model}`;
    return cmd;
  }

  buildResumeCommand(options: AgentInvokeOptions): string {
    let cmd = this.command;
    if (options.worktreeName) cmd += ` --worktree "${options.worktreeName}"`;
    if (options.sessionId) {
      cmd += ` --resume "${options.sessionId}"`;
    } else {
      cmd += ' --continue';
    }
    if (options.skipPermissions) cmd += ' --dangerously-skip-permissions';
    return cmd;
  }

  buildHeadlessArgs(options: { model?: string; cwd: string; jsonOutput?: boolean }): string[] {
    // Single-shot, non-interactive run. Prompt is piped to stdin by the caller.
    // Defaults to Sonnet to keep auto-code cost predictable (the interactive
    // default is Opus); pass options.model to override per task.
    // jsonOutput → emit a single result JSON object so the orchestrator can
    // recover session_id (to resume/inspect later) and the final summary.
    return [
      '--output-format', options.jsonOutput ? 'json' : 'text',
      '--model', options.model || 'claude-sonnet-4-6',
      '--add-dir', options.cwd,
      '--dangerously-skip-permissions',
      '-p',
    ];
  }

  /** Parse the JSON result object emitted by `--output-format json`. Claude
   *  prints one object: { type, subtype, session_id, result, total_cost_usd, … }.
   *  `result` is the agent's final assistant message. */
  parseHeadlessResult(stdout: string): { sessionId?: string; summary?: string } | null {
    const tryParse = (s: string): { sessionId?: string; summary?: string } | null => {
      try {
        const obj = JSON.parse(s);
        if (obj && (typeof obj.session_id === 'string' || typeof obj.result === 'string')) {
          return {
            sessionId: typeof obj.session_id === 'string' ? obj.session_id : undefined,
            summary: typeof obj.result === 'string' ? obj.result.trim() : undefined,
          };
        }
      } catch { /* not JSON — fall through */ }
      return null;
    };
    const trimmed = stdout.trim();
    const direct = tryParse(trimmed);
    if (direct) return direct;
    // Defensive: pull the largest {...} block out of any surrounding noise.
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return tryParse(trimmed.slice(first, last + 1));
    return null;
  }

  parseUsageFromOutput(data: string): AgentUsageData | null {
    const costMatch = data.match(COST_PATTERN);
    const inputMatch = data.match(INPUT_TOKENS_PATTERN);
    const outputMatch = data.match(OUTPUT_TOKENS_PATTERN);

    if (!costMatch && !inputMatch && !outputMatch) return null;

    const result: AgentUsageData = {};
    if (costMatch) result.cost = parseFloat(costMatch[1]);
    if (inputMatch) result.inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10);
    if (outputMatch) result.outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10);
    return result;
  }

  detectExit(data: string): boolean {
    return EXIT_PATTERNS.some((p) => p.test(data));
  }

  getModels(): AgentModelOption[] {
    // Aliases auto-resolve to the latest version Anthropic ships — picking
    // these means new releases work immediately without an app update.
    // Pinned IDs let users hold a specific release; the Custom field in
    // settings accepts any future ID the CLI accepts.
    return [
      { id: 'opus', label: 'Opus (latest)' },
      { id: 'sonnet', label: 'Sonnet (latest)' },
      { id: 'haiku', label: 'Haiku (latest)' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ];
  }

  getDefaultModel(): string {
    return 'opus';
  }

  getSettingsFields(): AgentSettingsField[] {
    return [];
  }

  // ─── Insights ─────────────────────────────────────────

  buildInsightsPrompt(messages: InsightsMessage[], userMessage: string): string {
    const history = messages
      .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    return history ? `${history}\n\nHuman: ${userMessage}` : userMessage;
  }

  buildInsightsArgs(model: InsightsModel | string, projectPath?: string): string[] {
    const modelId = INSIGHTS_MODEL_MAP[model] || model;
    const args = ['--output-format', 'stream-json', '--verbose', '--model', modelId];
    if (projectPath) args.push('--add-dir', projectPath);
    return args;
  }

  parseInsightsStreamLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        return parsed.delta.text;
      }
      if (parsed.type === 'result' && parsed.result) {
        const text =
          typeof parsed.result === 'string'
            ? parsed.result
            : parsed.result.content
                ?.filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('') || '';
        return text || null;
      }
      if (parsed.type === 'assistant' && parsed.content) {
        const text = parsed.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('');
        return text || null;
      }
    } catch {
      if (trimmed && !trimmed.startsWith('{')) {
        return trimmed + '\n';
      }
    }
    return null;
  }
}
