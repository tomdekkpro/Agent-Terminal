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
  /** Supports a non-interactive, single-shot run (prompt piped to stdin)
   *  driven by the auto-code orchestrator. Optional — undefined = false.
   *  Only agents with this can be selected as a task's auto-code agent. */
  headless?: boolean;
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
  /** Selected "Release version" custom-field value (resolved to its option name), if set. */
  releaseVersion?: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** List the task lives in. Lets snapshot refreshes fetch many tasks with one
   *  list-scoped query instead of one request per task. */
  listId?: string;
  providerTaskId: string;
  provider: TaskManagerProvider;
}

// ─── Task comments (ClickUp thread) ───────────────────────────

/** One run of comment content. ClickUp stores a comment as an array of these
 *  blocks (rich text, @mentions, attachments), and `comment_text` is only a
 *  flattened copy — rendering the blocks keeps links, mentions and images. */
export interface TaskCommentBlock {
  /** 'mention' covers @user, task references and task embeds — anything that
   *  renders as a chip; 'attachment' covers files, pasted images and video
   *  frames; 'divider' is a rule with no content. */
  kind: 'text' | 'mention' | 'attachment' | 'divider';
  /** Text run, or the mention's display name. */
  text?: string;
  /** Set when the run is a link (or the chip opens something). */
  url?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  code?: boolean;
  attachment?: {
    id?: string;
    title?: string;
    url?: string;
    thumbnailUrl?: string;
    extension?: string;
    isImage?: boolean;
  };
}

export interface TaskCommentAuthor {
  id: string;
  username: string;
  email?: string;
  initials?: string;
  color?: string;
  profilePicture?: string;
}

/** A normalized comment from the task manager, provider-agnostic. */
export interface TaskComment {
  id: string;
  /** Flattened plain text — used for search, copy, and the AI prompt. */
  text: string;
  blocks: TaskCommentBlock[];
  user: TaskCommentAuthor;
  createdAtMs: number;
  resolved?: boolean;
  assignee?: { id: string; username: string } | null;
  /** Threaded replies hanging off this comment (loaded on demand). */
  replyCount: number;
  reactions?: Array<{ reaction: string; count: number }>;
  /** True when the comment was posted by this app's own automation. */
  bot?: boolean;
  /** Set on replies — the comment they belong to. */
  parentId?: string;
}

/** Cursor for the next (older) page of a comment thread. */
export interface TaskCommentCursor {
  start: number;
  startId: string;
}

export interface TaskCommentThread {
  /** Oldest first — the order the panel renders them in. */
  comments: TaskComment[];
  /** Pass back as `before` to fetch the next older page. */
  older?: TaskCommentCursor | null;
  hasMore: boolean;
  /** The task-manager account this API key belongs to, so the UI can tell
   *  the user's own comments from everyone else's. */
  me?: { id: string; username: string } | null;
}

/** One AI-drafted reply offered in the comments panel. */
export interface CommentSuggestion {
  /** Short label for the angle taken, e.g. "Ask for repro steps". */
  title: string;
  text: string;
}

export type CommentAssistKind = 'suggest' | 'summarize';

export interface CommentAssistResult {
  kind: CommentAssistKind;
  suggestions?: CommentSuggestion[];
  /** Markdown digest for kind === 'summarize'. */
  summary?: string;
  /** Model output that could not be parsed as JSON — shown as-is. */
  raw?: string;
}

/** Data sources a Dashboard Notice's AI run is allowed to use. */
export type NoticeSource = 'clickup' | 'github' | 'web';

/** A scheduled AI "Notice" on the Dashboard: a saved prompt that runs daily at
 *  a chosen local time (and on demand), producing a Markdown digest. */
export interface DashboardNotice {
  id: string;
  title: string;
  /** Natural-language prompt, e.g. "all tasks that need priority today". */
  prompt: string;
  /** Local time-of-day "HH:mm" to auto-run daily. Empty = manual only. */
  scheduleTime: string;
  enabled: boolean;
  /** Optional project path used as the Claude CLI working directory (needed for GitHub/gh). */
  projectPath?: string;
  /** ClickUp list id to pull tasks from (falls back to the configured list). */
  listId?: string;
  /** Which data sources/tools this notice may use. Undefined = legacy ClickUp-only. */
  sources?: NoticeSource[];
  /** Websites to consult when the 'web' source is enabled. */
  urls?: string[];
  /** Manual sort order on the Dashboard (drag to reorder). */
  orderIndex?: number;
  /** Persisted card size in px (drag the corner to resize). */
  width?: number;
  height?: number;
  status: 'idle' | 'running' | 'done' | 'error';
  /** Latest result, Markdown. */
  lastResult?: string;
  /** ISO timestamp of the last run. */
  lastRunAt?: string;
  /** Local YYYY-MM-DD of the last run — guards the once-per-day auto-trigger. */
  lastRunDate?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
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
  /** Selected "Release version" custom-field value, if set. */
  releaseVersion?: string;
  url: string;
  provider: TaskManagerProvider;
}

/** Ordering options for the Kanban Backlog column. */
export type BacklogSortBy =
  | 'priority'      // Priority (Urgent → Low), then newest-created
  | 'created-desc'  // Newest created first
  | 'created-asc'   // Oldest created first
  | 'updated-desc'; // Recently updated first

export const BACKLOG_SORT_LABELS: Record<BacklogSortBy, string> = {
  'priority': 'Priority',
  'created-desc': 'Newest first',
  'created-asc': 'Oldest first',
  'updated-desc': 'Recently updated',
};

/** Filters accepted by task-manager search across providers. */
export interface TaskSearchFilters {
  statuses?: string[];
  assignees?: string[];
  includeClosed?: boolean;
  /** Server-side ordering. ClickUp maps to order_by/reverse; Jira maps to JQL ORDER BY. */
  orderBy?: 'id' | 'created' | 'updated' | 'due_date';
  reverse?: boolean;
}

/** Map a backlog sort to server-side ordering so pagination fetches the right
 *  subset first. ClickUp's order_by doesn't support priority — for that sort we
 *  fetch newest-created first and let the client order the loaded set. */
export const BACKLOG_SORT_API_PARAMS: Record<BacklogSortBy, { orderBy: 'created' | 'updated'; reverse: boolean }> = {
  'priority': { orderBy: 'created', reverse: false },
  'created-desc': { orderBy: 'created', reverse: false },
  'created-asc': { orderBy: 'created', reverse: true },
  'updated-desc': { orderBy: 'updated', reverse: false },
};

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
  // Kanban filter — persisted assignee id; empty = show all tasks; also gates the auto-code loop
  kanbanFilterAssigneeId: string;
  /** Persisted project filter for the Kanban board. Empty = show all projects. */
  kanbanFilterProjectId: string;
  /** ClickUp status names (comma-separated) that count as backlog candidates — shown in the leftmost column when not yet imported */
  kanbanBacklogStatuses: string;
  /** How the Backlog column is ordered. Persisted so the choice survives restarts. */
  kanbanBacklogSortBy: BacklogSortBy;
  /** ClickUp list id used to populate the backlog (falls back to clickupListId) */
  kanbanBacklogListId: string;
  /** ClickUp status names (comma-separated) that map to the "In Progress" Kanban column */
  kanbanInProgressStatuses: string;
  /** ClickUp status names (comma-separated) that map to the "Review / QC" Kanban column */
  kanbanReviewStatuses: string;
  /** ClickUp status names (comma-separated) that map to the "Failed" Kanban column */
  kanbanFailedStatuses: string;
  /** ClickUp status names (comma-separated) that map to the "Done" Kanban column */
  kanbanDoneStatuses: string;
  /** How often (in minutes) to auto-refresh ClickUp snapshots for imported tasks. Set to 0 to disable. */
  kanbanSnapshotIntervalMinutes: number;
  /** ClickUp status names (comma-separated, case-insensitive) whose board columns are hidden — their cards aren't rendered. */
  kanbanHiddenStatuses: string;
  /** ClickUp status names (comma-separated, case-insensitive) whose board columns are collapsed to a thin rail. */
  kanbanCollapsedStatuses: string;
  // Auto Code Loop — autonomously implements tasks from their description and
  // fixes them from QC feedback: watches trigger statuses, dispatches the agent,
  // pushes, opens a PR, re-requests QC, and (optionally) auto-merges.
  autoCodeEnabled: boolean;
  autoCodeMaxIterations: number;
  autoCodePollIntervalMinutes: number;
  /** ClickUp status(es) that trigger IMPLEMENT mode (build the task from its
   *  description). Accepts a comma-separated list. Blank = start as soon as a
   *  task is enabled (no status gate). */
  autoCodeStartStatus: string;
  /** ClickUp status name(s) that trigger FIX mode (address QC feedback).
   *  Accepts a comma-separated list (e.g. "failed, review failed"). */
  autoCodeFailedStatus: string;
  /** ClickUp status name(s) that trigger REVIEW-FIX mode (address Code Review
   *  findings, then hand the task back to the Code Review loop to re-verify).
   *  Accepts a comma-separated list. Set by the Code Review subsystem when an
   *  AI review fails. */
  autoCodeReviewFailedStatus: string;
  /** ClickUp status to flip the task TO when the agent starts coding (so the
   *  remote board reflects active work instead of sitting in its failed/start
   *  status for the whole run). Accepts a list for matching; the FIRST entry is
   *  written back. Blank = don't touch the status when coding starts. */
  autoCodeInProgressStatus: string;
  /** ClickUp status to flip the task back to after pushing a fix (so QC
   *  re-tests). Accepts a list for matching; the FIRST entry is written back. */
  autoCodeReviewStatus: string;
  /** Project path used for git worktrees + gh CLI */
  autoCodeProjectPath: string;
  /** Auto-merge PR when the QC→Done transition happens */
  autoCodeAutoMerge: boolean;
  /** ClickUp status(es) that signal QC passed and the PR should be merged.
   *  Accepts a comma-separated list. */
  autoCodeDoneStatus: string;
  /** Run a second agent to review the fix diff before flipping to retest.
   *  Critical findings hold the task back (escalate) instead of going to QC. */
  autoCodeReviewGate: boolean;
  /** Native OS notifications for autonomous-loop events (fix pushed/escalated,
   *  QC failed, PR auto-merged, review rejected). */
  notificationsEnabled: boolean;
  /** During QC runs, capture browser console errors + failed network requests
   *  and attach them to the failure report (and the auto-code prompt). */
  qcCaptureDiagnostics: boolean;
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

/** 7-day usage rollup for one model, derived from session JSONL entries. */
export interface ModelUsageSummary {
  /** Normalized model id (date suffix stripped), e.g. "claude-opus-4-8". */
  model: string;
  /** Human label, e.g. "Opus 4.8". */
  label: string;
  costToday: number;
  /** Cost over the last 7 days inclusive of today. */
  costWeek: number;
  /** Token totals over the last 7 days. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Assistant messages over the last 7 days. */
  messages: number;
}

/** Per-day cost breakdown across all imported Kanban tasks, derived from
 *  Claude session JSONL timestamps. `byDay` is sorted oldest → newest and
 *  always covers the most recent 7 calendar days (entries with $0 included
 *  so the chart has a stable shape). */
export interface KanbanDailyCostBreakdown {
  /** YYYY-MM-DD (local TZ) → cost */
  byDay: { date: string; cost: number }[];
  today: number;
  yesterday: number;
  /** Sum of the last 7 days inclusive of today. */
  week: number;
  /** Sum across the entire history found on disk. */
  total: number;
  /** Per-model rollup for the last 7 days, sorted by costWeek desc. */
  byModel: ModelUsageSummary[];
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
  /** Where a disk-discovered skill came from. Absent for skills configured by
   *  hand in project settings. */
  source?: 'project' | 'user' | 'plugin';
  /** Absolute path of the backing SKILL.md. The panel reads this directly
   *  instead of reconstructing a path from the id, which only ever worked for
   *  project-local skills. */
  filePath?: string;
  /** Owning plugin for `source: 'plugin'`, e.g. `dp` for `dp:ship`. */
  pluginName?: string;
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
  /** Browser console errors captured during the run (when diagnostics on). */
  consoleErrors?: string[];
  /** Failed/erroring network requests captured during the run. */
  networkErrors?: string[];
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

export type AutoCodeTaskState =
  | 'idle'
  | 'coding'
  | 'awaiting-review'
  | 'escalated'
  | 'merging'
  | 'done';

/** Snapshot + working state for a task the user has imported to the Kanban board.
 *  Source of truth for per-task metadata (session, worktree, auto-code state).
 *  The `clickup*` fields are a snapshot refreshed on poll. */
export interface KanbanTask {
  id: string;                       // local uuid
  /** 'clickup' = imported from ClickUp; the auto-code orchestrator and
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
  /** Selected "Release version" custom-field value (snapshot), if set. */
  clickupReleaseVersion?: string;
  clickupUpdatedAt?: string;
  /** ClickUp list this task belongs to. Recorded on the first snapshot refresh
   *  so later refreshes can batch every tracked task into a few list-scoped
   *  queries instead of one request per task. */
  clickupListId?: string;

  /** Local project path for worktree + gh CLI */
  projectPath: string;
  projectId?: string;               // optional link to project store

  /** Our workflow status */
  kanbanStatus: KanbanTaskStatus;

  /** Stable ordering key. Tasks render in ascending orderIndex within each
   *  column, so ordering survives refreshes and only changes when the user
   *  drags+drops (which bumps it to "newest" in the destination column).
   *  Backfilled from createdAt for tasks created before this field existed. */
  orderIndex?: number;

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
  /** Worktree mode is opt-in: a worktree is used only when this is explicitly
   *  true (chosen via the Start button, which persists it). Default / undefined
   *  / false → the agent runs directly against the project's current branch, no
   *  worktree created and no `--worktree` passed to Claude. NOTE: records from
   *  before this default flip are backfilled to true on load (see
   *  kanban-task-store) so existing worktree tasks keep their behavior. */
  useWorktree?: boolean;

  /** Auto-fix loop state */
  autoCodeState: AutoCodeTaskState;
  iterationCount: number;
  lastSeenFailureCommentId: string | null;
  lastFixActionAt?: string;
  lastError?: string | null;
  autoMergeOverride?: boolean | null;
  autoMergeQueuedAt?: string;
  /** Per-task opt-in for the auto-code loop. The orchestrator only follows
   *  tasks where this is explicitly true — undefined/false = OFF (default).
   *  Replaces the pre-1.25 tri-state `autoCodeOverride` (which defaulted to
   *  following the global toggle, i.e. effectively on for every task). */
  autoCodeEnabled?: boolean;
  /** Runtime diagnostics captured by the last failing QC run, fed into the
   *  next auto-code attempt so the agent sees console/network errors. */
  qcDiagnostics?: {
    consoleErrors: string[];
    networkErrors: string[];
    capturedAt: string;
  };

  prUrl?: string;

  createdAt: string;
  updatedAt: string;
}

// ─── Activity Feed ────────────────────────────────────────────

/** Which autonomous subsystem produced an activity event. */
export type ActivitySource = 'auto-code' | 'qc' | 'code-review' | 'dashboard';
export type ActivityLevel = 'info' | 'success' | 'warn' | 'error';

/** A single entry in the cross-project activity timeline. Emitted by the
 *  auto-code orchestrator, QC runner, and code-review engine whenever something
 *  noteworthy happens while the user may be away. Also the trigger source for
 *  native OS notifications. */
export interface ActivityEvent {
  id: string;
  /** ISO timestamp. */
  at: string;
  source: ActivitySource;
  level: ActivityLevel;
  /** Stable machine kind, e.g. 'fix-pushed' | 'fix-escalated' | 'pr-auto-merged'
   *  | 'qc-failed' | 'review-rejected'. Used to gate notifications. */
  kind: string;
  title: string;
  message?: string;
  projectPath?: string;
  projectName?: string;
  /** Local KanbanTask id (for deep-linking the board). */
  taskId?: string;
  clickupTaskId?: string;
  taskName?: string;
  /** Optional URL opened when the OS notification / feed row is clicked. */
  url?: string;
  read?: boolean;
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
  /** Head branch — the source branch the PR is built from */
  prBranch?: string;
  /** Base branch — the branch the PR merges into (e.g. main, Develop) */
  prBaseBranch?: string;
  /** GitHub login of the PR author */
  prAuthor?: string;
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
  /** True while the task's PRs are still being resolved in the background.
   *  The task list is returned as soon as ClickUp answers; matching each task
   *  to its PRs needs a `gh` listing (~2s) and sometimes a comment read, so
   *  that runs after the first paint and arrives via a `prs` event. */
  prsResolving?: boolean;
}

export interface CodeReviewEvent {
  type: 'progress' | 'finding' | 'done' | 'error' | 'prs';
  taskId: string;
  message?: string;
  finding?: CodeReviewFinding;
  status?: CodeReviewStatus;
  findings?: CodeReviewFinding[];
  /** `prs` events only — resolved PRs for `taskId`. */
  prs?: CodeReviewPR[];
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
  defaultModel: 'claude-opus-4-8',
  workingDirectory: '',
  maxTerminals: 12,
  theme: 'dark',
  autoUpdate: true,
  telemetryEnabled: true,
  defaultAgentProvider: 'claude',
  agentModels: {
    claude: 'claude-opus-4-8',
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
  kanbanFilterProjectId: '',
  kanbanBacklogStatuses: 'to do, open, backlog, planning, ready',
  kanbanBacklogSortBy: 'priority',
  kanbanBacklogListId: '',
  kanbanInProgressStatuses: 'in progress, in development, developing, working',
  kanbanReviewStatuses: 'review, in review, ready for review',
  kanbanFailedStatuses: 'failed',
  kanbanDoneStatuses: 'done, complete, closed',
  kanbanSnapshotIntervalMinutes: 5,
  kanbanHiddenStatuses: '',
  kanbanCollapsedStatuses: '',
  autoCodeEnabled: false,
  autoCodeMaxIterations: 3,
  autoCodePollIntervalMinutes: 30,
  autoCodeStartStatus: '',
  autoCodeFailedStatus: 'failed',
  autoCodeReviewFailedStatus: 'review failed',
  autoCodeInProgressStatus: 'in progress',
  autoCodeReviewStatus: 'ready for review',
  autoCodeProjectPath: '',
  autoCodeAutoMerge: false,
  autoCodeDoneStatus: 'done',
  autoCodeReviewGate: false,
  notificationsEnabled: true,
  qcCaptureDiagnostics: true,
};
