import * as os from 'os';
import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { TerminalCreateOptions, AgentProviderId, AgentInvokeOptions } from '../../shared/types';
import type { TerminalProcess, WindowGetter, TerminalOperationResult } from './types';
import * as PtyManager from './pty-manager';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog, debugError } from '../../shared/utils';
import { agentRegistry } from '../ipc/providers/agent-registry';
import { track } from '../analytics/analytics-service';
import { sessionUsageTracker } from '../usage/session-usage-tracker';

/** Encode a project path to match Claude Code's project directory naming.
 *  Claude maps `:`, `/`, `\`, AND `.` all to `-` — so e.g.
 *  `D:\proj\.task-worktrees\T-1` becomes `D--proj--task-worktrees-T-1`
 *  (not `D--proj-.task-worktrees-T-1`). Missing the dot mapping previously
 *  caused worktree session lookups to point at a non-existent project dir. */
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[:/\\.]/g, '-');
}

/** Get Claude Code's project data directory for a given cwd */
function getClaudeProjectDir(cwd: string): string {
  return join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd));
}

/** Build the cd command, clear command, and separator for a given shell type */
function buildShellCommand(
  shellType: string | undefined,
  dir: string,
): { cdCmd: string; clearCmd: string; separator: string } {
  if (shellType === 'powershell') {
    return { cdCmd: `cd "${dir}"`, clearCmd: 'cls', separator: '; ' };
  }
  if (shellType === 'bash') {
    return { cdCmd: `cd "${dir}"`, clearCmd: 'clear', separator: ' && ' };
  }
  return { cdCmd: `cd /d "${dir}"`, clearCmd: 'cls', separator: ' && ' };
}

/** Get snapshot of existing session files with their mtimes */
function getSessionSnapshot(claudeDir: string): Map<string, number> {
  const result = new Map<string, number>();
  try {
    if (!existsSync(claudeDir)) return result;
    for (const f of readdirSync(claudeDir)) {
      if (!f.endsWith('.jsonl')) continue;
      result.set(f, statSync(join(claudeDir, f)).mtimeMs);
    }
  } catch { /* ignore */ }
  return result;
}

/** Claude Code v2.1+ session-state directory — one `<pid>.json` per running
 *  Claude process, written on launch (before the first prompt). The JSON has
 *  the real session UUID plus the cwd, so we can identify the right one
 *  immediately instead of waiting for the .jsonl to appear. */
function getClaudeSessionsDir(): string {
  return join(os.homedir(), '.claude', 'sessions');
}

/** Snapshot the PIDs of existing Claude session-state files so we only match
 *  newly-started processes. */
function getClaudeSessionPidSnapshot(): Set<string> {
  const result = new Set<string>();
  const dir = getClaudeSessionsDir();
  try {
    if (!existsSync(dir)) return result;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) result.add(f.replace('.json', ''));
    }
  } catch { /* ignore */ }
  return result;
}

/** Read a Claude session-state JSON file and pull out (sessionId, cwd). */
interface ClaudeSessionState {
  sessionId?: string;
  cwd?: string;
  version?: string;
}
function readClaudeSessionState(file: string): ClaudeSessionState | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (typeof data.sessionId === 'string') return data as ClaudeSessionState;
  } catch { /* skip malformed */ }
  return null;
}

export class TerminalManager {
  private terminals: Map<string, TerminalProcess> = new Map();
  private getWindow: WindowGetter;

  constructor(getWindow: WindowGetter) {
    this.getWindow = getWindow;
  }

  async create(options: TerminalCreateOptions): Promise<TerminalOperationResult> {
    const { id, cwd, cols = 80, rows = 24, env: customEnv } = options;

    if (this.terminals.has(id)) {
      return { success: true };
    }

    try {
      const { pty: ptyProcess, shellType } = PtyManager.spawnPtyProcess(
        cwd || os.homedir(),
        cols,
        rows,
        customEnv
      );

      const terminal: TerminalProcess = {
        id,
        pty: ptyProcess,
        isAgentMode: false,
        hasExited: false,
        cwd: cwd || os.homedir(),
        outputBuffer: '',
        title: `Terminal ${this.terminals.size + 1}`,
        shellType,
      };

      this.terminals.set(id, terminal);

      track('terminal_created', { terminalCount: this.terminals.size });

      PtyManager.setupPtyHandlers(
        terminal,
        this.terminals,
        this.getWindow,
        (term, data) => this.handleTerminalData(term, data),
        (term) => {
          // When PTY exits while agent is active (e.g. Ctrl+C), clear agent state
          if (term.isAgentMode || term.isClaudeMode) {
            term.isAgentMode = false;
            term.isClaudeMode = false;
            const win = this.getWindow();
            if (win && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.TERMINAL_AGENT_BUSY, term.id, false);
              win.webContents.send(IPC_CHANNELS.TERMINAL_CLAUDE_BUSY, term.id, false);
            }
          }
        }
      );

      return { success: true };
    } catch (error) {
      debugError('[TerminalManager] Error creating terminal:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create terminal',
      };
    }
  }

  async destroy(id: string): Promise<TerminalOperationResult> {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return { success: false, error: 'Terminal not found' };
    }

    try {
      this.terminals.delete(id);
      sessionUsageTracker.stop(id);

      // If an agent (Claude CLI, etc.) is active, send graceful exit before killing
      if (terminal.isAgentMode && !terminal.hasExited) {
        try {
          // Send /exit followed by Ctrl+C as graceful shutdown signals
          PtyManager.writeToPty(terminal, '/exit\r');
          PtyManager.writeToPty(terminal, '\x03'); // Ctrl+C
        } catch { /* non-critical — force kill follows */ }

        // Give the agent a brief moment to exit gracefully, then force kill
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            PtyManager.killPty(terminal);
            resolve();
          }, 500);
        });
      } else {
        PtyManager.killPty(terminal);
      }

      track('terminal_closed', { terminalCount: this.terminals.size });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to destroy terminal',
      };
    }
  }

  async killAll(): Promise<void> {
    PtyManager.setShuttingDown(true);
    sessionUsageTracker.stopAll();

    // Send graceful exit to all active agents first
    this.terminals.forEach((terminal) => {
      if (terminal.isAgentMode && !terminal.hasExited) {
        try {
          PtyManager.writeToPty(terminal, '/exit\r');
          PtyManager.writeToPty(terminal, '\x03');
        } catch { /* non-critical */ }
      }
    });

    // Brief grace period, then force kill everything
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        this.terminals.forEach((terminal) => {
          PtyManager.killPty(terminal);
        });
        this.terminals.clear();
        resolve();
      }, 300);
    });
  }

  write(id: string, data: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      PtyManager.writeToPty(terminal, data);
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    return PtyManager.resizePty(terminal, cols, rows);
  }

  // ─── Unified Agent Invoke / Resume ──────────────────────────────

  invokeAgent(
    id: string,
    agentId: AgentProviderId,
    options: AgentInvokeOptions = {},
  ): { success: boolean; error?: string } {
    debugLog('[InvokeAgent] Called:', { id, agentId, options });
    const terminal = this.terminals.get(id);
    if (!terminal) return { success: false, error: 'Terminal not found' };

    const provider = agentRegistry.get(agentId);
    if (!provider) return { success: false, error: `Unknown agent provider: ${agentId}` };

    if (!provider.isAvailable()) {
      return { success: false, error: `${provider.displayName} CLI is not installed. ${provider.installHint}` };
    }

    terminal.isAgentMode = true;
    terminal.agentProvider = agentId;
    // Keep deprecated aliases in sync
    terminal.isClaudeMode = true;
    terminal.copilotProvider = agentId;

    const dir = options.cwd || terminal.cwd;
    terminal.agentCwd = dir;
    terminal.claudeCwd = dir;

    // Claude --worktree: the session file lands in the worktree's encoded
    // dir, not the cwd's. Compute the storage dir accordingly so detection
    // polls the right location.
    const sessionStorageDir = agentId === 'claude' && options.worktreeName
      ? join(dir, '.claude', 'worktrees', options.worktreeName)
      : dir;

    let preSnapshot: Map<string, number> | undefined;
    let preSessionPids: Set<string> | undefined;
    if (agentId === 'claude') {
      const claudeDir = getClaudeProjectDir(sessionStorageDir);
      preSnapshot = getSessionSnapshot(claudeDir);
      preSessionPids = getClaudeSessionPidSnapshot();
    }

    const { cdCmd, clearCmd, separator } = buildShellCommand(terminal.shellType, dir);
    const agentCmd = provider.buildInvokeCommand(options);
    const command = `${cdCmd}${separator}${clearCmd}${separator}${agentCmd}\r`;
    PtyManager.writeToPty(terminal, command);

    track('agent_invoked', {
      agent: agentId,
      model: options.model || '',
    });

    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.TERMINAL_TITLE_CHANGE, id, provider.displayName);
    }

    // Claude session detection (filesystem-based)
    if (agentId === 'claude' && preSnapshot && preSessionPids) {
      const claudeDir = getClaudeProjectDir(sessionStorageDir);
      this.detectAgentSession(terminal, claudeDir, preSnapshot, sessionStorageDir, preSessionPids);
    }

    // Copilot session detection (filesystem-based, like Claude)
    if (agentId === 'copilot') {
      const copilotSnapshot = this.getCopilotSessionSnapshot();
      this.detectCopilotSession(terminal, copilotSnapshot);
    }

    return { success: true };
  }

  resumeAgent(
    id: string,
    agentId: AgentProviderId,
    options: AgentInvokeOptions = {},
  ): void {
    debugLog('[ResumeAgent] Called:', { id, agentId, sessionId: options.sessionId, cwd: options.cwd });

    const terminal = this.terminals.get(id);
    if (!terminal) {
      debugLog('[ResumeAgent] Terminal not found:', id);
      return;
    }

    const provider = agentRegistry.get(agentId);
    if (!provider) {
      debugLog('[ResumeAgent] Provider not found:', agentId);
      return;
    }

    terminal.isAgentMode = true;
    terminal.agentProvider = agentId;
    terminal.isClaudeMode = true;
    terminal.copilotProvider = agentId;

    const dir = options.cwd || terminal.agentCwd || terminal.cwd;
    terminal.agentCwd = dir;
    terminal.claudeCwd = dir;

    // Store session ID on the terminal object so enrichWithSessionIds can find it
    if (options.sessionId) {
      terminal.agentSessionId = options.sessionId;
      terminal.claudeSessionId = options.sessionId;
      // Start usage tracking for the resumed session. The session JSONL lives
      // under the worktree's encoded dir when --worktree was used, otherwise
      // under the cwd's encoded dir.
      if (agentId === 'claude') {
        const sessionStorageDir = options.worktreeName
          ? join(dir, '.claude', 'worktrees', options.worktreeName)
          : dir;
        const sessionFile = join(getClaudeProjectDir(sessionStorageDir), `${options.sessionId}.jsonl`);
        sessionUsageTracker.start(terminal.id, sessionFile);
      }
    }

    const { cdCmd, separator } = buildShellCommand(terminal.shellType, dir);
    const agentCmd = provider.buildResumeCommand(options);
    // Skip clear command on resume so restored session history remains visible
    const command = `${cdCmd}${separator}${agentCmd}\r`;
    debugLog('[ResumeAgent] Shell command:', command.replace(/\r/g, '\\r'));
    PtyManager.writeToPty(terminal, command);

    // Send follow-up slash command after agent starts (e.g. /resume SESSION-ID for Copilot)
    const resumeInput = provider.getResumeInput?.(options);
    debugLog('[ResumeAgent] Resume input:', resumeInput ?? '(none)');
    if (resumeInput) {
      setTimeout(() => {
        if (!terminal.hasExited) {
          debugLog('[ResumeAgent] Sending follow-up input:', resumeInput);
          PtyManager.writeToPty(terminal, resumeInput);
          // Send Enter separately after a short delay to let autocomplete resolve
          setTimeout(() => {
            if (!terminal.hasExited) {
              PtyManager.writeToPty(terminal, '\r');
            }
          }, 500);
        } else {
          debugLog('[ResumeAgent] Terminal already exited, skipping follow-up input');
        }
      }, 3000);
    }

    // Copilot session detection on resume — only if session ID not already known
    if (agentId === 'copilot' && !options.sessionId && !terminal.agentSessionId) {
      const copilotSnapshot = this.getCopilotSessionSnapshot();
      this.detectCopilotSession(terminal, copilotSnapshot);
    }

    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.TERMINAL_TITLE_CHANGE, id, provider.displayName);
    }
  }

  // ─── Legacy Convenience Wrappers ──────────────────────────────

  invokeClaude(id: string, cwd?: string, skipPermissions?: boolean, model?: string): { success: boolean; error?: string } {
    return this.invokeAgent(id, 'claude', { cwd, skipPermissions, model });
  }

  resumeClaude(id: string, sessionId?: string, cwd?: string): void {
    this.resumeAgent(id, 'claude', { sessionId, cwd });
  }

  invokeCopilot(id: string, cwd?: string, model?: string): { success: boolean; error?: string } {
    return this.invokeAgent(id, 'copilot', { cwd, model });
  }

  resumeCopilot(id: string, cwd?: string): void {
    this.resumeAgent(id, 'copilot', { cwd });
  }

  // ─── Session Detection ──────────────────────────────────────

  private detectAgentSession(
    terminal: TerminalProcess,
    claudeDir: string,
    preSnapshot: Map<string, number>,
    sessionStorageDir: string,
    preSessionPids: Set<string>,
  ): void {
    // Two detection paths, both polled until the terminal exits or a session
    // is found:
    //   1. Claude Code v2.1+ session-state — `~/.claude/sessions/<pid>.json`
    //      created on launch with `{sessionId, cwd, ...}`. Fires immediately
    //      after Claude boots — no need to wait for the first prompt.
    //   2. Legacy `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` —
    //      created on first prompt. Kept as a fallback for older versions.
    // Adaptive cadence: 1s for the first 30s, then 3s.
    let elapsedMs = 0;
    const targetCwd = sessionStorageDir.toLowerCase();

    const emit = (sessionId: string, jsonlPath?: string) => {
      terminal.agentSessionId = sessionId;
      terminal.claudeSessionId = sessionId; // deprecated alias
      debugLog('[TerminalManager] Detected agent session:', sessionId, 'for terminal:', terminal.id);
      if (jsonlPath) sessionUsageTracker.start(terminal.id, jsonlPath);
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.TERMINAL_AGENT_SESSION, terminal.id, sessionId);
        win.webContents.send(IPC_CHANNELS.TERMINAL_CLAUDE_SESSION, terminal.id, sessionId);
      }
    };

    /** Try the new session-state dir. Returns true if a match was found. */
    const checkSessionState = (): boolean => {
      const dir = getClaudeSessionsDir();
      if (!existsSync(dir)) return false;
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          const pid = f.replace('.json', '');
          if (preSessionPids.has(pid)) continue; // pre-existing session, not ours
          const state = readClaudeSessionState(join(dir, f));
          if (!state || !state.sessionId || !state.cwd) continue;
          if (state.cwd.toLowerCase() !== targetCwd) continue;
          // Match — also try to attach the JSONL path (if it exists yet) for
          // the cost tracker; if not, the tracker will pick it up later when
          // the file appears since the watcher uses the session id directly.
          const jsonlPath = join(claudeDir, `${state.sessionId}.jsonl`);
          emit(state.sessionId, existsSync(jsonlPath) ? jsonlPath : undefined);
          return true;
        }
      } catch { /* ignore */ }
      return false;
    };

    /** Try the legacy projects dir. Returns true if a match was found. */
    const checkProjectsDir = (): boolean => {
      if (!existsSync(claudeDir)) return false;
      try {
        for (const f of readdirSync(claudeDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const mtime = statSync(join(claudeDir, f)).mtimeMs;
          const prevMtime = preSnapshot.get(f);
          if (prevMtime === undefined || mtime > prevMtime + 500) {
            const sessionId = f.replace('.jsonl', '');
            emit(sessionId, join(claudeDir, f));
            return true;
          }
        }
      } catch { /* ignore */ }
      return false;
    };

    const poll = () => {
      if (terminal.hasExited || terminal.agentSessionId) return;
      if (checkSessionState()) return;
      if (checkProjectsDir()) return;
      const next = elapsedMs < 30_000 ? 1000 : 3000;
      elapsedMs += next;
      setTimeout(poll, next);
    };

    setTimeout(poll, 2000);
  }

  // ─── Misc ──────────────────────────────────────────────────

  setTitle(id: string, title: string): void {
    const terminal = this.terminals.get(id);
    if (terminal) {
      terminal.title = title;
    }
  }

  getOutputBuffers(): Record<string, string> {
    const buffers: Record<string, string> = {};
    this.terminals.forEach((terminal, id) => {
      // Only save output buffers for agent terminals — plain shells start fresh
      if (terminal.outputBuffer && (terminal.agentSessionId || terminal.isAgentMode)) {
        buffers[id] = terminal.outputBuffer;
      }
    });
    return buffers;
  }

  /** Detect Copilot session by watching ~/.copilot/session-state/ for new directories */
  private detectCopilotSession(
    terminal: TerminalProcess,
    preSnapshot: Set<string>,
  ): void {
    const sessionDir = join(os.homedir(), '.copilot', 'session-state');
    // Poll for as long as the terminal is alive (Copilot may take a while to
    // create its session dir, especially before the first prompt). 2s for the
    // first 30s, then 5s.
    let elapsedMs = 0;

    const poll = () => {
      if (terminal.hasExited || terminal.agentSessionId) return;

      try {
        if (!existsSync(sessionDir)) {
          const next = elapsedMs < 30_000 ? 2000 : 5000;
          elapsedMs += next;
          setTimeout(poll, next);
          return;
        }

        for (const entry of readdirSync(sessionDir)) {
          if (preSnapshot.has(entry)) continue;
          // New directory found — check if it's a UUID
          const fullPath = join(sessionDir, entry);
          if (!statSync(fullPath).isDirectory()) continue;
          const uuidMatch = entry.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
          if (!uuidMatch) continue;

          const sessionId = entry;
          terminal.agentSessionId = sessionId;
          terminal.claudeSessionId = sessionId;
          debugLog('[TerminalManager] Detected Copilot session from filesystem:', sessionId, 'for terminal:', terminal.id);
          const win = this.getWindow();
          if (win && !win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.TERMINAL_AGENT_SESSION, terminal.id, sessionId);
            win.webContents.send(IPC_CHANNELS.TERMINAL_CLAUDE_SESSION, terminal.id, sessionId);
          }
          return;
        }
      } catch { /* ignore */ }

      const next = elapsedMs < 30_000 ? 2000 : 5000;
      elapsedMs += next;
      setTimeout(poll, next);
    };

    setTimeout(poll, 3000);
  }

  /** Snapshot existing Copilot session directories */
  private getCopilotSessionSnapshot(): Set<string> {
    const sessionDir = join(os.homedir(), '.copilot', 'session-state');
    const result = new Set<string>();
    try {
      if (existsSync(sessionDir)) {
        for (const entry of readdirSync(sessionDir)) {
          result.add(entry);
        }
      }
    } catch { /* ignore */ }
    return result;
  }

  getTerminal(id: string): TerminalProcess | undefined {
    return this.terminals.get(id);
  }

  getActiveTerminalIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  isClaudeMode(id: string): boolean {
    return this.terminals.get(id)?.isAgentMode ?? false;
  }

  // ─── Terminal Data Handler ─────────────────────────────────

  private handleTerminalData(terminal: TerminalProcess, data: string): void {
    if (!terminal.isAgentMode) return;

    const providerId = terminal.agentProvider;
    if (!providerId) return;

    const provider = agentRegistry.get(providerId);
    if (!provider) return;

    // Detect exit
    if (provider.detectExit(data)) {
      terminal.isAgentMode = false;
      terminal.isClaudeMode = false;
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.TERMINAL_AGENT_BUSY, terminal.id, false);
        win.webContents.send(IPC_CHANNELS.TERMINAL_CLAUDE_BUSY, terminal.id, false);
      }
    }

    // Extract usage data
    const usageData = provider.parseUsageFromOutput(data);
    if (usageData) {
      const win = this.getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.USAGE_COST_UPDATE, {
          terminalId: terminal.id,
          provider: providerId,
          ...usageData,
          timestamp: new Date(),
        });
      }
    }
  }
}
