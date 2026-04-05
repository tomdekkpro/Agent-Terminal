import type {
  AgentProviderId,
  AgentCapabilities,
  AgentModelOption,
  AgentInvokeOptions,
  AgentSettingsField,
  AgentProviderMeta,
  AgentUsageData,
  InsightsMessage,
  InsightsModel,
} from '../../../shared/types';

/**
 * IAgentProvider — the plugin interface every AI agent must implement.
 *
 * Adding a new agent (Gemini CLI, Qwen Code, Aider, …) only requires
 * creating a class that implements this interface and registering it
 * in the agent registry.
 */
export interface IAgentProvider {
  readonly id: AgentProviderId;
  readonly displayName: string;
  /** CLI binary name (e.g. 'claude', 'copilot', 'gemini') */
  readonly command: string;
  /** Lucide icon key for the UI */
  readonly iconName: string;
  /** CSS color string for UI theming */
  readonly color: string;
  readonly capabilities: AgentCapabilities;
  /** Human-readable install instruction shown when the CLI is missing */
  readonly installHint: string;

  /** Check if the CLI binary is available on PATH */
  isAvailable(): boolean;

  /** Build the shell command string to invoke the agent fresh */
  buildInvokeCommand(options: AgentInvokeOptions): string;

  /** Build the shell command string to resume / continue a session */
  buildResumeCommand(options: AgentInvokeOptions): string;

  /** Extract usage / cost data from a chunk of terminal output */
  parseUsageFromOutput(data: string): AgentUsageData | null;

  /** Return true if the terminal output indicates the agent exited */
  detectExit(data: string): boolean;

  /** (Optional) Detect an existing session in the working directory */
  detectSession?(cwd: string): Promise<string | null>;

  /** (Optional) Return slash-command input to send after the agent starts (e.g. /resume SESSION-ID) */
  getResumeInput?(options: AgentInvokeOptions): string | null;

  /** Return the list of models the user can choose from */
  getModels(): AgentModelOption[];

  /** Return the default model id */
  getDefaultModel(): string;

  /** Return provider-specific settings fields (e.g. API keys for Aider) */
  getSettingsFields(): AgentSettingsField[];

  // ─── Insights chat support (optional) ───────────────────────────

  /** Build the text prompt that will be piped to stdin */
  buildInsightsPrompt?(messages: InsightsMessage[], userMessage: string): string;

  /** Build the CLI args array for the insights subprocess */
  buildInsightsArgs?(model: InsightsModel | string, projectPath?: string): string[];

  /** Parse a single line of stdout into displayable text (return null to skip) */
  parseInsightsStreamLine?(line: string): string | null;
}

/** Convert an IAgentProvider to a serializable meta object for the renderer */
export function toAgentProviderMeta(p: IAgentProvider): AgentProviderMeta {
  return {
    id: p.id,
    displayName: p.displayName,
    command: p.command,
    iconName: p.iconName,
    color: p.color,
    capabilities: { ...p.capabilities },
    installHint: p.installHint,
    available: p.isAvailable(),
    models: p.getModels(),
    defaultModel: p.getDefaultModel(),
    settingsFields: p.getSettingsFields(),
  };
}
