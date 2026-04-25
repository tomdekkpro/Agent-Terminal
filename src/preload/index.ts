import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';

const electronAPI = {
  // Terminal
  createTerminal: (options: any) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, options),
  destroyTerminal: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_DESTROY, id),
  sendTerminalInput: (id: string, data: string) => ipcRenderer.send(IPC_CHANNELS.TERMINAL_WRITE, id, data),
  resizeTerminal: (id: string, cols: number, rows: number) => ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, id, cols, rows),
  // Unified agent API
  invokeAgent: (id: string, agentId: string, options?: any) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_INVOKE_AGENT, id, agentId, options),
  resumeAgent: (id: string, agentId: string, options?: any) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESUME_AGENT, id, agentId, options),
  getAgentProviders: () => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_AGENT_LIST),
  // Legacy agent API (delegates to unified)
  invokeClaude: (id: string, cwd?: string, skipPermissions?: boolean, model?: string) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_INVOKE_CLAUDE, id, cwd, skipPermissions, model),
  invokeCopilot: (id: string, cwd?: string, model?: string) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_INVOKE_COPILOT, id, cwd, model),
  resumeCopilot: (id: string, cwd?: string) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESUME_COPILOT, id, cwd),
  resumeClaude: (id: string, sessionId?: string, cwd?: string) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESUME_CLAUDE, id, sessionId, cwd),
  saveTerminalState: (state: any) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_STATE_SAVE, state),
  saveTerminalStateSync: (state: any) => ipcRenderer.sendSync(IPC_CHANNELS.TERMINAL_STATE_SAVE_SYNC, state),
  loadTerminalState: () => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_STATE_LOAD),
  loadTerminalBuffers: () => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_BUFFERS_LOAD),

  // Terminal events
  onTerminalOutput: (callback: (id: string, data: string) => void) => {
    const handler = (_event: any, id: string, data: string) => callback(id, data);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_OUTPUT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_OUTPUT, handler);
  },
  onTerminalExit: (callback: (id: string, exitCode: number) => void) => {
    const handler = (_event: any, id: string, exitCode: number) => callback(id, exitCode);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, handler);
  },
  onTerminalTitleChange: (callback: (id: string, title: string) => void) => {
    const handler = (_event: any, id: string, title: string) => callback(id, title);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_TITLE_CHANGE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_TITLE_CHANGE, handler);
  },
  // Agent-generic event listeners
  onTerminalAgentBusy: (callback: (id: string, isBusy: boolean) => void) => {
    const handler = (_event: any, id: string, isBusy: boolean) => callback(id, isBusy);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_AGENT_BUSY, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_AGENT_BUSY, handler);
  },
  onTerminalAgentSession: (callback: (id: string, sessionId: string) => void) => {
    const handler = (_event: any, id: string, sessionId: string) => callback(id, sessionId);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_AGENT_SESSION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_AGENT_SESSION, handler);
  },
  // Legacy event listeners (still fired for backward compat)
  onTerminalClaudeBusy: (callback: (id: string, isBusy: boolean) => void) => {
    const handler = (_event: any, id: string, isBusy: boolean) => callback(id, isBusy);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_CLAUDE_BUSY, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_CLAUDE_BUSY, handler);
  },
  onTerminalClaudeSession: (callback: (id: string, sessionId: string) => void) => {
    const handler = (_event: any, id: string, sessionId: string) => callback(id, sessionId);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_CLAUDE_SESSION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_CLAUDE_SESSION, handler);
  },

  // Task Manager
  checkTaskManagerConnection: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_CHECK_CONNECTION),
  getTaskManagerLists: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_GET_LISTS),
  getTaskManagerTasks: (listId?: string, page?: number) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_GET_TASKS, listId, page),
  searchTaskManagerTasks: (query: string, filters?: { statuses?: string[]; assignees?: string[]; includeClosed?: boolean }, listId?: string, page?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_SEARCH_TASKS, query, filters, listId, page),
  getTaskManagerTask: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_GET_TASK, taskId),
  createTaskManagerTask: (listId: string, data: any) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_CREATE_TASK, listId, data),
  postTaskComment: (taskId: string, comment: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_POST_COMMENT, taskId, comment),
  updateTaskStatus: (taskId: string, status: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_UPDATE_STATUS, taskId, status),
  postTaskTimeEntry: (taskId: string, startMs: number, durationMs: number, description?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_POST_TIME_ENTRY, taskId, startMs, durationMs, description),
  getTaskTimeEntries: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_GET_TIME_ENTRIES, taskId),
  getTaskStatuses: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_GET_TASK_STATUSES, taskId),
  getListStatuses: (listId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_GET_LIST_STATUSES, listId),
  getTaskManagerMembers: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_GET_MEMBERS),

  // Usage Monitor
  requestUsageUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.USAGE_REQUEST),
  onUsageUpdated: (callback: (snapshot: any) => void) => {
    const handler = (_event: any, snapshot: any) => callback(snapshot);
    ipcRenderer.on(IPC_CHANNELS.USAGE_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.USAGE_UPDATED, handler);
  },
  onUsageCostUpdate: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.USAGE_COST_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.USAGE_COST_UPDATE, handler);
  },
  onTerminalUsage: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_USAGE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_USAGE, handler);
  },
  requestCopilotUsageUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.COPILOT_USAGE_REQUEST),
  onCopilotUsageUpdated: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.COPILOT_USAGE_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COPILOT_USAGE_UPDATED, handler);
  },

  // Projects
  getProjects: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
  addProject: (path: string, name?: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_ADD, path, name),
  removeProject: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REMOVE, id),
  updateProject: (id: string, updates: any) => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE, id, updates),
  selectProjectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SELECT_FOLDER),
  getTabState: () => ipcRenderer.invoke(IPC_CHANNELS.TAB_STATE_GET),
  saveTabState: (tabState: any) => ipcRenderer.invoke(IPC_CHANNELS.TAB_STATE_SAVE, tabState),

  // Files
  listDir: (dirPath: string, depth?: number) => ipcRenderer.invoke(IPC_CHANNELS.FILES_LIST_DIR, dirPath, depth),
  loadClaudeSkills: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILES_LOAD_CLAUDE_SKILLS, projectPath),
  readFile: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILES_READ_FILE, filePath),
  saveClaudeSkill: (projectPath: string, skillName: string, content: string) => ipcRenderer.invoke(IPC_CHANNELS.FILES_SAVE_CLAUDE_SKILL, projectPath, skillName, content),

  // Git
  createTaskWorktree: (projectPath: string, taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_CREATE_WORKTREE, projectPath, taskId),
  removeTaskWorktree: (projectPath: string, worktreePath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_REMOVE_WORKTREE, projectPath, worktreePath),
  mergeTaskBranch: (projectPath: string, worktreePath: string, taskBranch: string, targetBranch: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_MERGE_TASK, projectPath, worktreePath, taskBranch, targetBranch),
  listBranches: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_LIST_BRANCHES, projectPath),
  createPR: (projectPath: string, worktreePath: string, taskBranch: string, targetBranch: string, title: string, body: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CREATE_PR, projectPath, worktreePath, taskBranch, targetBranch, title, body),
  createBranchPR: (cwd: string, newBranch: string, targetBranch: string, title: string, body: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_CREATE_BRANCH_PR, cwd, newBranch, targetBranch, title, body),
  getTaskSummary: (cwd: string, taskBranch: string, baseBranch: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_TASK_SUMMARY, cwd, taskBranch, baseBranch),
  getDiffFiles: (cwd: string, baseBranch?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF_FILES, cwd, baseBranch),
  enablePRAutoMerge: (projectPath: string, branch: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_ENABLE_PR_AUTO_MERGE, projectPath, branch),
  pushBranch: (cwd: string, branch?: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH_BRANCH, cwd, branch),
  gitFetch: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_FETCH, cwd),
  gitPull: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, cwd),
  gitCommit: (cwd: string, message: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, cwd, message),

  // Insights
  insightsListSessions: () => ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_LIST_SESSIONS),
  insightsGetSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_GET_SESSION, id),
  insightsCreateSession: (model: string, projectPath?: string, provider?: string, copilotModel?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_CREATE_SESSION, model, projectPath, provider, copilotModel),
  insightsDeleteSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_DELETE_SESSION, id),
  insightsRenameSession: (id: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_RENAME_SESSION, id, title),
  insightsSendMessage: (sessionId: string, content: string, model?: string, projectPath?: string, copilotModel?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_SEND_MESSAGE, sessionId, content, model, projectPath, copilotModel),
  insightsAbortStream: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_ABORT_STREAM, sessionId),
  insightsPinSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_PIN_SESSION, id),
  insightsDeleteMessage: (sessionId: string, messageId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_DELETE_MESSAGE, sessionId, messageId),
  insightsExportSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_EXPORT_SESSION, id),
  insightsSendPersonaMessage: (sessionId: string, content: string, persona: any, model?: string, projectPath?: string, copilotModel?: string, userMessage?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_SEND_PERSONA_MESSAGE, sessionId, content, persona, model, projectPath, copilotModel, userMessage),
  insightsUpdateSession: (sessionId: string, updates: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_UPDATE_SESSION, sessionId, updates),
  // Personas
  personasList: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONAS_LIST),
  personasSave: (personas: any[]) => ipcRenderer.invoke(IPC_CHANNELS.PERSONAS_SAVE, personas),
  personasAdd: (persona: any) => ipcRenderer.invoke(IPC_CHANNELS.PERSONAS_ADD, persona),
  personasUpdate: (id: string, updates: any) => ipcRenderer.invoke(IPC_CHANNELS.PERSONAS_UPDATE, id, updates),
  personasDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PERSONAS_DELETE, id),
  personasReset: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONAS_RESET),
  onInsightsStreamEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.INSIGHTS_STREAM_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSIGHTS_STREAM_EVENT, handler);
  },

  // Dev Server
  startDevServer: (projectId: string, type: string) => ipcRenderer.invoke(IPC_CHANNELS.DEV_SERVER_START, projectId, type),
  stopDevServer: (projectId: string, type: string) => ipcRenderer.invoke(IPC_CHANNELS.DEV_SERVER_STOP, projectId, type),
  getDevServerStatus: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.DEV_SERVER_STATUS, projectId),
  detectDevServers: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.DEV_SERVER_DETECT, projectPath),
  onDevServerEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.DEV_SERVER_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEV_SERVER_EVENT, handler);
  },

  // Service Status
  requestServiceStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SERVICE_STATUS_REQUEST),
  onServiceStatusUpdated: (callback: (summary: any) => void) => {
    const handler = (_event: any, summary: any) => callback(summary);
    ipcRenderer.on(IPC_CHANNELS.SERVICE_STATUS_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SERVICE_STATUS_UPDATED, handler);
  },

  // System Monitor
  requestSystemMonitor: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_MONITOR_REQUEST),
  onSystemMonitorUpdated: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SYSTEM_MONITOR_UPDATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SYSTEM_MONITOR_UPDATED, handler);
  },

  // Settings
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_ALL),
  getSetting: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key),
  setSettings: (updates: any) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, updates),

  // Updates
  checkForUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),
  onUpdateStatus: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATUS, handler);
  },

  // Team Chat
  teamGetIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.TEAM_GET_IDENTITY),
  teamGetRepo: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_GET_REPO, projectPath),
  teamConnect: (serverUrl: string, user: any) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_CONNECT, serverUrl, user),
  teamDisconnect: () => ipcRenderer.invoke(IPC_CHANNELS.TEAM_DISCONNECT),
  teamSendMessage: (content: string, meta?: { personaId?: string; personaName?: string; personaColor?: string; replyTo?: string; image?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_SEND_MESSAGE, content, meta),
  teamSendTyping: () => ipcRenderer.invoke(IPC_CHANNELS.TEAM_SEND_TYPING),
  teamStartServer: (port?: number) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_START_SERVER, port),
  teamStopServer: () => ipcRenderer.invoke(IPC_CHANNELS.TEAM_STOP_SERVER),
  teamShareSession: (session: any) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_SHARE_SESSION, session),
  teamUnshareSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_UNSHARE_SESSION, sessionId),
  teamJoinSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_JOIN_SESSION, sessionId),
  teamLeaveSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_LEAVE_SESSION, sessionId),
  teamSendSessionMessage: (sessionId: string, message: any) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_SEND_SESSION_MESSAGE, sessionId, message),
  teamTestConnection: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_TEST_CONNECTION, url),
  teamPersonaReply: (content: string, persona: any, model?: string, projectPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_PERSONA_REPLY, content, persona, model, projectPath),
  teamLoadHistory: (repo: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_LOAD_HISTORY, repo),
  teamSaveHistory: (repo: string, messages: any[]) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_SAVE_HISTORY, repo, messages),
  onTeamEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TEAM_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TEAM_EVENT, handler);
  },

  // QC Testing
  qcGenerateTests: (sessionId: string, title: string, description: string, targetUrl: string, model: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.QC_GENERATE_TESTS, sessionId, title, description, targetUrl, model),
  qcRunTests: (sessionId: string, model: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.QC_RUN_TESTS, sessionId, model),
  qcRunSingleTest: (sessionId: string, testCaseId: string, model: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.QC_RUN_SINGLE_TEST, sessionId, testCaseId, model),
  qcAbort: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.QC_ABORT, sessionId),
  onQCEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.QC_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.QC_EVENT, handler);
  },

  // Task Manager — Tags
  addTaskTag: (taskId: string, tagName: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_ADD_TAG, taskId, tagName),
  removeTaskTag: (taskId: string, tagName: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_MANAGER_REMOVE_TAG, taskId, tagName),

  // Code Review
  codeReviewGetTasks: (reviewStatuses?: string[], projectPath?: string, listId?: string) => ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_GET_TASKS, reviewStatuses, projectPath, listId),
  codeReviewGetPRInfo: (projectPath: string, prNumber: number) => ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_GET_PR_INFO, projectPath, prNumber),
  codeReviewRun: (projectPath: string, taskId: string, prNumber: number) => ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_RUN, projectPath, taskId, prNumber),
  codeReviewSubmit: (projectPath: string, taskId: string, prNumber: number, passed: boolean, findings: any[], prTitle: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_SUBMIT, projectPath, taskId, prNumber, passed, findings, prTitle),
  codeReviewForceApprove: (projectPath: string, taskId: string, prNumber: number, prTitle: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_FORCE_APPROVE, projectPath, taskId, prNumber, prTitle),
  codeReviewStop: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_STOP, taskId),
  codeReviewStopAll: () => ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_STOP_ALL),
  codeReviewSchedulerStart: () => ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_SCHEDULER_START),
  codeReviewSchedulerStop: () => ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_SCHEDULER_STOP),
  codeReviewSchedulerStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CODE_REVIEW_SCHEDULER_STATUS),
  onCodeReviewEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CODE_REVIEW_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CODE_REVIEW_EVENT, handler);
  },

  // Kanban Tasks
  kanbanList: () => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_LIST),
  kanbanGet: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_GET, id),
  kanbanImport: (input: any) => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_IMPORT, input),
  kanbanUpdate: (id: string, patch: any) => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_UPDATE, id, patch),
  kanbanDelete: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_DELETE, id),
  kanbanRefreshClickup: () => ipcRenderer.invoke(IPC_CHANNELS.KANBAN_REFRESH_CLICKUP),
  onKanbanEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.KANBAN_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.KANBAN_EVENT, handler);
  },

  // Auto-Fix Loop
  autoFixStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AUTO_FIX_STATUS),
  autoFixStart: () => ipcRenderer.invoke(IPC_CHANNELS.AUTO_FIX_START),
  autoFixStop: () => ipcRenderer.invoke(IPC_CHANNELS.AUTO_FIX_STOP),
  autoFixRunNow: () => ipcRenderer.invoke(IPC_CHANNELS.AUTO_FIX_RUN_NOW),
  autoFixRequeue: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTO_FIX_REQUEUE, taskId),
  autoFixSetTaskAutoMerge: (taskId: string, override: boolean | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTO_FIX_SET_TASK_AUTOMERGE, taskId, override),
  onAutoFixEvent: (callback: (event: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.AUTO_FIX_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTO_FIX_EVENT, handler);
  },

  // Claude Sessions Browser
  claudeSessionsList: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_SESSIONS_LIST, cwd),
  claudeSessionExists: (cwd: string, sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_SESSION_EXISTS, cwd, sessionId),

  // File utilities
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // App
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
  openPath: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_PATH, filePath),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
