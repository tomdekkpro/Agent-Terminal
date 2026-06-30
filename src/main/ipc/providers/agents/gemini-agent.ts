import { execSync } from 'child_process';
import type { IAgentProvider } from '../agent-types';
import type {
  AgentCapabilities,
  AgentModelOption,
  AgentInvokeOptions,
  AgentSettingsField,
  AgentUsageData,
} from '../../../../shared/types';

export class GeminiAgentProvider implements IAgentProvider {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini CLI';
  readonly command = 'gemini';
  readonly iconName = 'Sparkles';
  readonly color = '#4285f4';
  readonly installHint = 'Install with: npm install -g @anthropic-ai/gemini-cli';
  readonly capabilities: AgentCapabilities = {
    resume: true,
    continue: false,
    yolo: false,
    sessionDetection: false,
    remoteControl: false,
    insights: false,
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
    if (options.model) cmd += ` -m ${options.model}`;
    return cmd;
  }

  buildResumeCommand(_options: AgentInvokeOptions): string {
    return `${this.command} --resume`;
  }

  buildHeadlessArgs(options: { model?: string; cwd: string }): string[] {
    // Gemini CLI goes non-interactive automatically when input is piped to
    // stdin (the orchestrator pipes the fix prompt), so no `-p` is needed —
    // the piped content becomes the prompt. `--yolo` auto-approves all tool
    // calls so it can edit/commit unattended; `-m` selects the model.
    // Flags verified against google-gemini/gemini-cli docs (v0.36+).
    const args: string[] = ['--yolo'];
    if (options.model) args.push('-m', options.model);
    return args;
  }

  parseUsageFromOutput(_data: string): AgentUsageData | null {
    // Gemini CLI usage output parsing can be added later
    return null;
  }

  detectExit(data: string): boolean {
    return /Goodbye/i.test(data);
  }

  getModels(): AgentModelOption[] {
    return [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ];
  }

  getDefaultModel(): string {
    return 'gemini-2.5-pro';
  }

  getSettingsFields(): AgentSettingsField[] {
    return [];
  }
}
