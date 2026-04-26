export type WindowsShellType = 'cmd' | 'powershell' | 'bash';
export type AgentProviderId = 'claude' | 'copilot' | 'gemini' | 'qwen' | 'aider';
/** @deprecated Use AgentProviderId instead */
export type CopilotProvider = AgentProviderId;
export type TaskManagerProvider = 'clickup' | 'jira' | 'none';

export interface AgentCapabilities {
  resume: boolean;
  continue: boolean;
  yolo: boolean;
  sessionDetection: boolean;
  remoteControl: boolean;
  insights: boolean;
}

export interface AgentModelOption {
  id: string;
  label: string;
}

export interface AgentInvokeOptions {
  cwd?: string;
  model?: string;
  skipPermissions?: boolean;
  sessionId?: string;
  task?: string;
  env?: Record<string, string>;
  /** Pass-through to Claude's `-w/--worktree <name>` flag.
   *  Claude creates / reuses a worktree at `<repo>/.claude/worktrees/<name>`
   *  with branch `worktree-<name>`. When set, the CLI is run from the
   *  project root (not the worktree path) — Claude handles the cd internally
   *  and resume works across worktrees of the same repo. */
  worktreeName?: string;
}

export interface AgentSettingsField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  placeholder?: string;
  description?: string;
  options?: { value: string; label: string }[];
}

/** Serializable agent metadata sent to the renderer */
export interface AgentProviderMeta {
  id: AgentProviderId;
  displayName: string;
  command: string;
  iconName: string;
  color: string;
  capabilities: AgentCapabilities;
  installHint: string;
  available: boolean;
  models: AgentModelOption[];
  defaultModel: string;
  settingsFields: AgentSettingsField[];
}

/** Per-agent usage data extracted from terminal output */
export interface AgentUsageData {
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  premiumRequests?: number;
  durationApi?: string;
  durationWall?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface TerminalCreateOptions {
  id: string;
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

/** Normalized task shape all providers map to */
export interface TaskManagerTask {
  id: string;
  customId?: string;
  name: string;
  description?: string;
  status: { name: string; color: string };
  /** ClickUp priority — id: "1" (Urgent) | "2" (High) | "3" (Normal) | "4" (Low). Lower = more important. */
  priority?: { id?: string; name: string; color: string };
  assignees: Array<{ id: string; username: string; email?: string; initials?: string }>;
  tags: Array<{ name: string; bgColor: string; fgColor: string }>;
  url: string;
  createdAt: string;
  updatedAt: string;
  providerTaskId: string;
  provider: TaskManagerProvider;
}

/** List/container that holds tasks (ClickUp list, Jira project, etc.) */
export interface TaskManagerList {
  id: string;
  name: string;
  space?: string;
  folder?: string;
}

/** Slim task shape stored on terminals */
export interface TerminalTask {
  id: string;
  customId?: string;
  name: string;
  status: string;
  statusColor: string;
  url: string;
  provider: TaskManagerProvider;
}

export interface AppSettings {
  // Terminal
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalCursorStyle: 'block' | 'underline' | 'bar';
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  terminalGpuAcceleration: boolean;
  // Task Manager
  taskManagerProvider: TaskManagerProvider;
  clickupApiKey: string;
  clickupWorkspaceId: string;
  clickupListId: string;
  clickupListIds: string;
  jiraEmail: string;
  jiraApiToken: string;
  jiraDomain: string;
  jiraProjectKey: string;
  // Agent
  defaultModel: string;
  workingDirectory: string;
  maxTerminals: number;
  // Appearance
  theme: 'dark' | 'light';
  // General
  autoUpdate: boolean;
  telemetryEnabled: boolean;
  // Team
  teamServerUrl: string;
  teamAutoConnect: boolean;
  teamAutoStartServer: boolean;
  // Agent providers
  defaultAgentProvider: AgentProviderId;
  agentModels: Partial<Record<AgentProviderId, string>>;
  agentConfig: Partial<Record<AgentProviderId, Record<string, string>>>;
  // QC Testing
  qcTestingUrl: string;
  qcTestingCredentials: QCCredential[];
  // Code Review
  codeReviewEnabled: boolean;
  codeReviewIntervalMinutes: number;
  codeReviewStatuses: string;
  codeReviewProjectPath: string;
  codeReviewTagName: string;
  // Kanban filter — persisted assignee id; empty = show all tasks; also gates the auto-fix loop
  kanbanFilterAssigneeId: string;
  /** ClickUp status names (comma-separated) that count as backlog candidates — shown in the leftmost column when not yet imported */
  kanbanBacklogStatuses: string;
  /** ClickUp list id used to populate the backlog (falls back to clickupListId) */
  kanbanBacklogListId: string;
  /** ClickUp status names (comma-separated) that map to the "In Progress" Kanban column */
  kanbanInProgressStatuses: string;
  /** How often (in minutes) to auto-refresh ClickUp snapshots for imported tasks. Set to 0 to disable. */
  kanbanSnapshotIntervalMinutes: number;
  // Auto-Fix Loop — watches Failed tasks, dispatches fix prompts, pushes, re-requests QC
  autoFixEnabled: boolean;
  autoFixMaxIterations: number;
  autoFixPollIntervalMinutes: number;
  /** ClickUp status name that triggers the fix loop */
  autoFixFailedStatus: string;
  /** ClickUp status to flip the task back to after pushing a fix (so QC re-tests) */
  autoFixRetestStatus: string;
  /** Project path used for git worktrees + gh CLI */
  autoFixProjectPath: string;
  /** Auto-merge PR when the QC→Done transition happens */
  autoFixAutoMerge: boolean;
  /** ClickUp status that signals QC passed and the PR should be merged */
  autoFixDoneStatus: string;
  /** @deprecated Use defaultAgentProvider */
  defaultCopilotProvider?: AgentProviderId;
  /** @deprecated Use agentModels.copilot */
  defaultCopilotModel?: string;
}

// Usage Monitor
export interface UsageSnapshot {
  sessionPercent: number;
  weeklyPercent: number;
  sessionResetTime?: string;
  weeklyResetTime?: string;
  fetchedAt: Date;
}

export interface UsageCostData {
  terminalId: string;
  provider?: AgentProviderId;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  premiumRequests?: number;
  durationApi?: string;
  durationWall?: string;
  linesAdded?: number;
  linesRemoved?: number;
  timestamp: Date;
}

/** Cumulative per-terminal usage accumulated from the session JSONL.
 *  Sent on every poll cycle as absolute totals (not deltas). */
export interface TerminalUsageData {
  terminalId: string;
  /** Latest model seen in the session (e.g. "claude-sonnet-4-6"). */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** USD — sum of (tokens × per-1M-rate) for every assistant turn. */
  cost: number;
}

export interface CopilotUsageData {
  premiumRequests?: number;
  totalTurns: number;
  models: string[];
  tokenLimit?: number;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationApi?: string;
  durationWall?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

// Dev Server
export type DevServerType = 'frontend' | 'backend';

export interface DevServerConfig {
  frontendCmd: string;
  frontendCwd: string;  // relative to project path
  backendCmd: string;
  backendCwd: string;   // relative to project path
  backendProfile?: string; // dotnet launch profile name
}

export type DevServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface DevServerState {
  projectId: string;
  type: DevServerType;
  status: DevServerStatus;
  pid?: number;
  error?: string;
}

export interface DevServerEvent {
  projectId: string;
  type: DevServerType;
  status: DevServerStatus;
  pid?: number;
  error?: string;
  output?: string;
}

export interface LaunchProfile {
  name: string;
  environment: string;  // ASPNETCORE_ENVIRONMENT value
  applicationUrl?: string;
}

export interface DetectedServer {
  cmd: string;
  cwd: string;
  label: string;
  confidence: number;
  profiles?: LaunchProfile[];
}

export interface DetectResult {
  frontend: DetectedServer[];
  backend: DetectedServer[];
}

// Project Management
export interface ProjectSkill {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  agentProvider?: AgentProviderId;
  icon?: string;
  color?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  agentProvider?: AgentProviderId;
  agentModel?: string;
  agentConfig?: Record<string, string>;
  skills?: ProjectSkill[];
  devServer?: DevServerConfig;
  /** Path to documentation/reference files for this project */
  docsPath?: string;
}

export interface ProjectTabState {
  openProjectIds: string[];
  activeProjectId: string | null;
  tabOrder: string[];
}

// Insights
export type InsightsModel = 'opus' | 'sonnet' | 'haiku';

export interface PersonaIntegrations {
  /** Allow this persona to fetch ClickUp task details when task IDs are referenced */
  clickup?: boolean;
  /** Allow this persona to fetch GitHub info (PRs, issues, repo status) via gh CLI */
  github?: boolean;
}

export interface Persona {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  color: string;
  icon: string;
  /** Optional integrations this persona can access for context enrichment */
  integrations?: PersonaIntegrations;
}

export type DiscussionStatus = 'discussing' | 'spec-ready' | 'implementing' | 'reviewing' | 'completed';

// ─── QC Testing ─────────────────────────────────────────────────

export interface QCTestStep {
  id: string;
  order: number;
  action: string;
  expected: string;
  actual?: string;
  screenshot?: string; // base64 data URI or file path
  status: 'pending' | 'passed' | 'failed' | 'skipped';
}

export interface QCTestCase {
  id: string;
  name: string;
  description: string;
  steps: QCTestStep[];
  status: 'pending' | 'running' | 'passed' | 'failed' | 'error';
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface QCCredential {
  label: string;   // e.g. "Email", "Username", "Password"
  value: string;
}

export interface QCTask {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  targetUrl: string;
  credentials?: QCCredential[];
  testCases: QCTestCase[];
  status: 'draft' | 'generating' | 'ready' | 'running' | 'completed';
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
  /** Linked ClickUp (or other task manager) task */
  linkedTask?: {
    id: string;
    customId?: string;
    name: string;
    status: string;
    statusColor: string;
    url: string;
  };
}

export interface InsightsMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  model?: InsightsModel;
  personaId?: string;
  /** GitHub username if this message is from a remote teammate */
  teamUser?: string;
  /** Special message types for pipeline cards */
  messageType?: 'message' | 'spec' | 'implementation' | 'review' | 'pr' | 'status' | 'qc-plan' | 'qc-result';
  metadata?: Record<string, any>;
}

export interface InsightsSession {
  id: string;
  title: string;
  messages: InsightsMessage[];
  model: InsightsModel;
  provider?: AgentProviderId;
  copilotModel?: string;
  projectPath?: string;
  pinned?: boolean;
  /** Chat mode: single persona, round table discussion, or QC testing */
  mode?: 'single' | 'roundtable' | 'qc';
  /** Persona IDs participating in round table */
  personas?: string[];
  /** Current persona turn index */
  activePersonaIndex?: number;
  /** Linked terminal for implementation */
  linkedTerminalId?: string;
  /** Linked task from ClickUp/Jira */
  linkedTask?: TerminalTask;
  /** Discussion pipeline status */
  discussionStatus?: DiscussionStatus;
  /** Whether this session is shared with the team */
  shared?: boolean;
  /** GitHub usernames of remote participants */
  participants?: string[];
  /** QC testing task */
  qcTask?: QCTask;
  createdAt: string;
  updatedAt: string;
}

export interface InsightsSessionMeta {
  id: string;
  title: string;
  messageCount: number;
  model: InsightsModel;
  provider?: AgentProviderId;
  projectPath?: string;
  pinned?: boolean;
  mode?: 'single' | 'roundtable' | 'qc';
  discussionStatus?: DiscussionStatus;
  qcStatus?: QCTask['status'];
  qcPassed?: number;
  qcFailed?: number;
  qcTotal?: number;
  qcDurationMs?: number;
  linkedTaskName?: string;
  linkedTaskColor?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Claude CLI Sessions Browser ─────────────────────────────────
export interface ClaudeSessionEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

export interface InsightsStreamEvent {
  type: 'text' | 'done' | 'error';
  sessionId: string;
  text?: string;
  error?: string;
  personaId?: string;
}

export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 'pm',
    name: 'PM',
    role: 'Product Manager',
    systemPrompt: 'You are an experienced Product Manager. Focus on user requirements, acceptance criteria, user stories, business logic, and prioritization. Break down features into clear, actionable specifications. Consider edge cases from the user\'s perspective. When discussing implementation, focus on WHAT needs to be built and WHY, not HOW.',
    color: '#6366f1',
    icon: 'ClipboardList',
    integrations: { clickup: true },
  },
  {
    id: 'developer',
    name: 'Developer',
    role: 'Senior Developer',
    systemPrompt: 'You are a Senior Software Developer. Focus on architecture, code implementation, design patterns, technical debt, and best practices. When discussing features, propose concrete technical approaches — which files to modify, data structures, APIs, and component design. Consider performance, maintainability, and scalability.',
    color: '#22c55e',
    icon: 'Code',
    integrations: { clickup: true, github: true },
  },
  {
    id: 'qc',
    name: 'QC',
    role: 'Quality Engineer',
    systemPrompt: 'You are a Quality Assurance Engineer. Focus on test cases, edge cases, regression risks, error handling, and quality criteria. When reviewing features or code, identify potential bugs, missing validations, accessibility issues, and security concerns. Define clear pass/fail criteria for every requirement.',
    color: '#f59e0b',
    icon: 'ShieldCheck',
    integrations: { clickup: true, github: true },
  },
];

// ─── Kanban Tasks ─────────────────────────────────────────────

/** Local Kanban workflow status — separate from (but influenced by) ClickUp status */
export type KanbanTaskStatus = 'todo' | 'in-progress' | 'review' | 'failed' | 'done';

export type AutoFixTaskState =
  | 'idle'
  | 'fixing'
  | 'awaiting-qc'
  | 'escalated'
  | 'merging'
  | 'done';

/** Snapshot + working state for a task the user has imported to the Kanban board.
 *  Source of truth for per-task metadata (session, worktree, auto-fix state).
 *  The `clickup*` fields are a snapshot refreshed on poll. */
export interface KanbanTask {
  id: string;                       // local uuid
  /** 'clickup' = imported from ClickUp; the auto-fix orchestrator and
   *  ClickUp-sync flows process these. 'local' = user-created on this
   *  machine; clickupUrl is empty and orchestrator skips the task. */
  provider?: 'clickup' | 'local';
  /** For local tasks: `local:<uuid>` (= the local id). For clickup: real id. */
  clickupTaskId: string;
  clickupCustomId?: string;
  clickupName: string;
  clickupStatus: string;            // current ClickUp status name (snapshot)
  clickupStatusColor?: string;
  /** Empty string for local tasks. */
  clickupUrl: string;
  /** Free-text body for local tasks, used as the first prompt to the agent.
   *  ClickUp tasks fetch description live from the API. */
  description?: string;
  clickupAssignees?: Array<{ id: string; username: string; initials?: string; color?: string }>;
  clickupPriority?: { name: string; color: string };
  clickupTags?: Array<{ name: string; bgColor: string; fgColor: string }>;
  clickupUpdatedAt?: string;

  /** Local project path for worktree + gh CLI */
  projectPath: string;
  projectId?: string;               // optional link to project store

  /** Our workflow status */
  kanbanStatus: KanbanTaskStatus;

  /** Agent session data — persisted across terminal recreation */
  agentSessionId?: string;
  agentProvider?: AgentProviderId;
  /** The cwd where the agent session was actually started.
   *  Claude CLI scopes `--resume <id>` lookups by encoded cwd, so we must
   *  resume from the same directory the session was created in (not a
   *  freshly-created worktree, which would be a different Claude project dir). */
  agentCwd?: string;

  /** Latest cumulative usage for this task's active agent session.
   *  Sourced from the session JSONL by the main-side usage tracker and
   *  written here so the Kanban board can show cost even when the terminal
   *  for this task is closed. Reflects ONLY the current `agentSessionId` —
   *  if the user starts a fresh session, this resets. */
  usage?: {
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost: number;
    /** ISO timestamp of the last update. */
    updatedAt: string;
  };

  worktreePath?: string;
  worktreeBranch?: string;
  baseBranch?: string;

  /** Auto-fix loop state */
  autoFixState: AutoFixTaskState;
  iterationCount: number;
  lastSeenFailureCommentId: string | null;
  lastFixActionAt?: string;
  lastError?: string | null;
  autoMergeOverride?: boolean | null;
  autoMergeQueuedAt?: string;
  /** Per-task override for the auto-fix loop — true = always process, false = skip, null/undefined = follow global toggle */
  autoFixOverride?: boolean | null;

  prUrl?: string;

  createdAt: string;
  updatedAt: string;
}

// ─── Code Review ──────────────────────────────────────────────

export type CodeReviewSeverity = 'critical' | 'major' | 'minor' | 'suggestion';
export type CodeReviewStatus = 'pending' | 'reviewing' | 'passed' | 'failed' | 'error' | 'skipped';

export interface CodeReviewFinding {
  severity: CodeReviewSeverity;
  file: string;
  line?: number;
  description: string;
  suggestion?: string;
}

export interface CodeReviewPR {
  prNumber: number;
  prUrl?: string;
  prBranch?: string;
  prTitle?: string;
  status: CodeReviewStatus;
  findings: CodeReviewFinding[];
  reviewedAt?: string;
  error?: string;
}

export interface CodeReviewItem {
  taskId: string;
  taskName: string;
  taskUrl: string;
  customId?: string;
  /** @deprecated Use prs array instead */
  prNumber?: number;
  /** @deprecated Use prs array instead */
  prUrl?: string;
  prBranch?: string;
  prTitle?: string;
  status: CodeReviewStatus;
  findings: CodeReviewFinding[];
  reviewedAt?: string;
  error?: string;
  prs: CodeReviewPR[];
}

export interface CodeReviewEvent {
  type: 'progress' | 'finding' | 'done' | 'error';
  taskId: string;
  message?: string;
  finding?: CodeReviewFinding;
  status?: CodeReviewStatus;
  findings?: CodeReviewFinding[];
}

// ─── Team Chat ────────────────────────────────────────────────

export interface TeamUser {
  username: string;
  avatarUrl?: string;
  repo: string; // owner/repo — the room key
  status: 'online' | 'away' | 'busy';
  connectedAt: string;
}

export interface TeamMessage {
  id: string;
  from: string; // username
  content: string;
  timestamp: string;
  repo: string;
  /** If this message is from an AI persona */
  personaId?: string;
  personaName?: string;
  personaColor?: string;
  /** If this message is a reply to a mention */
  replyTo?: string;
  /** Base64 data URL for an attached image */
  image?: string;
}

/** Minimal session info broadcast to teammates */
export interface SharedSessionInfo {
  id: string;
  title: string;
  owner: string; // GitHub username of creator
  repo: string;
  mode: 'single' | 'roundtable' | 'qc';
  personas: string[]; // persona names (for display)
  participantCount: number;
  messageCount: number;
}

/** Wire protocol for WebSocket messages */
export type TeamWireMessage =
  | { type: 'join'; user: TeamUser }
  | { type: 'leave'; username: string; repo: string }
  | { type: 'presence'; users: TeamUser[] }
  | { type: 'message'; message: TeamMessage }
  | { type: 'typing'; username: string; repo: string }
  | { type: 'error'; error: string }
  // Session sharing
  | { type: 'session-share'; session: SharedSessionInfo }
  | { type: 'session-unshare'; sessionId: string; repo: string }
  | { type: 'session-join'; sessionId: string; username: string; repo: string }
  | { type: 'session-leave'; sessionId: string; username: string; repo: string }
  | { type: 'session-message'; sessionId: string; message: InsightsMessage; repo: string }
  | { type: 'session-participants'; sessionId: string; participants: string[]; repo: string }
  | { type: 'session-list'; sessions: SharedSessionInfo[] }
  // Chat history (sent to late joiners)
  | { type: 'history'; messages: TeamMessage[] };

// Service Status
export type ServiceStatusLevel = 'operational' | 'degraded' | 'major' | 'critical' | 'unknown';

export interface ServiceStatusIncident {
  name: string;
  impact: string;
  status: string;
  url?: string;
  updatedAt: string;
}

export interface ProviderStatus {
  provider: AgentProviderId;
  level: ServiceStatusLevel;
  description: string;
  incidents: ServiceStatusIncident[];
  components?: { name: string; status: string }[];
  lastChecked: number;
}

export interface ServiceStatusSummary {
  providers: Record<string, ProviderStatus>;
  worstLevel: ServiceStatusLevel;
}

// System Monitor
export interface GpuInfo {
  name: string;
  utilization: number;   // percent
  memoryUsed: number;    // MB
  memoryTotal: number;   // MB
  memoryPercent: number;
  temperature: number;   // celsius
}

export interface SystemMonitorData {
  cpu: {
    percent: number;
    cores: { model: string; speed: number; percent: number }[];
    count: number;
  };
  memory: {
    total: number;       // bytes
    used: number;        // bytes
    free: number;        // bytes
    percent: number;
  };
  gpu: GpuInfo[] | null; // null if no GPU detected
  uptime: number;        // seconds
  timestamp: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  terminalFontFamily: 'Cascadia Code, Consolas, Courier New, monospace',
  terminalFontSize: 14,
  terminalLineHeight: 1.2,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalScrollback: 10000,
  terminalGpuAcceleration: true,
  taskManagerProvider: 'none',
  clickupApiKey: '',
  clickupWorkspaceId: '',
  clickupListId: '',
  clickupListIds: '',
  jiraEmail: '',
  jiraApiToken: '',
  jiraDomain: '',
  jiraProjectKey: '',
  teamServerUrl: '',
  teamAutoConnect: false,
  teamAutoStartServer: false,
  defaultModel: 'claude-opus-4-6',
  workingDirectory: '',
  maxTerminals: 12,
  theme: 'dark',
  autoUpdate: true,
  telemetryEnabled: true,
  defaultAgentProvider: 'claude',
  agentModels: {
    claude: 'claude-opus-4-6',
    copilot: 'claude-sonnet-4.5',
    gemini: 'gemini-2.5-pro',
    qwen: 'qwen3-coder',
    aider: '',
  },
  agentConfig: {},
  qcTestingUrl: '',
  qcTestingCredentials: [],
  codeReviewEnabled: false,
  codeReviewIntervalMinutes: 60,
  codeReviewStatuses: 'ready for review, in review, review',
  codeReviewProjectPath: '',
  codeReviewTagName: 'reviewpass',
  kanbanFilterAssigneeId: '',
  kanbanBacklogStatuses: 'to do, open, backlog, planning, ready',
  kanbanBacklogListId: '',
  kanbanInProgressStatuses: 'in progress, in development, developing, working',
  kanbanSnapshotIntervalMinutes: 5,
  autoFixEnabled: false,
  autoFixMaxIterations: 3,
  autoFixPollIntervalMinutes: 30,
  autoFixFailedStatus: 'failed',
  autoFixRetestStatus: 'qc',
  autoFixProjectPath: '',
  autoFixAutoMerge: false,
  autoFixDoneStatus: 'done',
};
