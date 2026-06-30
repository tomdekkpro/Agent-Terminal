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

const PREMIUM_PATTERN = /Total usage est:\s*(\d+)\s*Premium requests/i;
const INPUT_PATTERN = /input:\s*([0-9,]+)\s*tokens/i;
const OUTPUT_PATTERN = /output:\s*([0-9,]+)\s*tokens/i;
const DURATION_API_PATTERN = /Total duration \(API\):\s*(.+)/i;
const DURATION_WALL_PATTERN = /Total duration \(wall\):\s*(.+)/i;
const CODE_CHANGES_PATTERN = /Total code changes:\s*(\d+)\s*lines?\s*added,?\s*(\d+)\s*lines?\s*removed/i;

export class CopilotAgentProvider implements IAgentProvider {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot';
  readonly command = 'copilot';
  readonly iconName = 'GitBranch';
  readonly color = '#22c55e';
  readonly installHint = 'Install with: npm install -g @github/copilot';
  readonly capabilities: AgentCapabilities = {
    resume: true,
    continue: true,
    yolo: true,
    sessionDetection: true,
    remoteControl: false,
    insights: true,
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
    if (options.skipPermissions) cmd += ' --yolo';
    if (options.model) cmd += ` --model ${options.model}`;
    return cmd;
  }

  buildResumeCommand(options: AgentInvokeOptions): string {
    // If we have a session ID, just start copilot — /resume will follow via getResumeInput
    if (options.sessionId) return this.command;
    return `${this.command} --continue`;
  }

  getResumeInput(options: AgentInvokeOptions): string | null {
    if (options.sessionId) {
      return `/resume ${options.sessionId}`;
    }
    return null;
  }

  parseUsageFromOutput(data: string): AgentUsageData | null {
    const premiumMatch = data.match(PREMIUM_PATTERN);
    const inputMatch = data.match(INPUT_PATTERN);
    const outputMatch = data.match(OUTPUT_PATTERN);
    const durationApiMatch = data.match(DURATION_API_PATTERN);
    const durationWallMatch = data.match(DURATION_WALL_PATTERN);
    const codeChangesMatch = data.match(CODE_CHANGES_PATTERN);

    if (!premiumMatch && !inputMatch && !outputMatch && !durationApiMatch && !durationWallMatch && !codeChangesMatch) return null;

    const result: AgentUsageData = {};
    if (premiumMatch) result.premiumRequests = parseInt(premiumMatch[1], 10);
    if (inputMatch) result.inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10);
    if (outputMatch) result.outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10);
    if (durationApiMatch) result.durationApi = durationApiMatch[1].trim();
    if (durationWallMatch) result.durationWall = durationWallMatch[1].trim();
    if (codeChangesMatch) {
      result.linesAdded = parseInt(codeChangesMatch[1], 10);
      result.linesRemoved = parseInt(codeChangesMatch[2], 10);
    }
    return result;
  }

  detectExit(_data: string): boolean {
    // Copilot doesn't have a clear exit pattern detected in output
    return false;
  }

  getModels(): AgentModelOption[] {
    return [
      { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (default)' },
      { id: 'claude-opus-4.5', label: 'Claude Opus 4.5' },
      { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
      { id: 'gpt-5.1', label: 'GPT-5.1' },
      { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1-Codex-Mini' },
      { id: 'gpt-5.1-codex', label: 'GPT-5.1-Codex' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5-Mini' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    ];
  }

  getDefaultModel(): string {
    return 'claude-sonnet-4.5';
  }

  getSettingsFields(): AgentSettingsField[] {
    return [];
  }

  // ─── Insights ─────────────────────────────────────────

  buildInsightsPrompt(messages: InsightsMessage[], userMessage: string): string {
    if (messages.length === 0) return userMessage;

    const history = messages
      .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
      .join('\n\n');

    return `Here is our conversation so far:\n\n${history}\n\n<user>\n${userMessage}\n</user>\n\nPlease respond to the latest user message, taking the full conversation history into account.`;
  }

  buildInsightsArgs(_model: InsightsModel | string, _projectPath?: string): string[] {
    return ['-s', '--allow-all-tools'];
  }

  parseInsightsStreamLine(line: string): string | null {
    // Copilot outputs plain text to stdout
    return line;
  }
}
