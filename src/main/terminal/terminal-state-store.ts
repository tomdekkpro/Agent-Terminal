import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { debugLog, debugError } from '../../shared/utils';

export interface SavedTerminal {
  id: string;
  groupId: string;
  title: string;
  cwd: string;
  projectId?: string;
  isClaudeMode: boolean;
  agentSessionId?: string;
  /** @deprecated Use agentSessionId */
  claudeSessionId?: string;
  claudeCwd?: string;
  agentProvider?: string;
  /** @deprecated Use agentProvider */
  copilotProvider?: string;
  skipPermissions?: boolean;
  task?: Record<string, unknown>;
  /** @deprecated Use task */
  clickUpTask?: Record<string, unknown>;
  worktreePath?: string;
  worktreeBranch?: string;
  baseBranch?: string;
  timeTracking?: Record<string, unknown>;
  previewUrl?: string;
}

export interface SavedTerminalState {
  terminals: SavedTerminal[];
  activeTerminalId: string | null;
  activeGroupId: string | null;
}

const STORE_DIR = join(app.getPath('userData'), 'store');
const STORE_FILE = join(STORE_DIR, 'terminals.json');
const BUFFERS_FILE = join(STORE_DIR, 'terminal-buffers.json');

const DEFAULT_STATE: SavedTerminalState = {
  terminals: [],
  activeTerminalId: null,
  activeGroupId: null,
};

export function loadTerminalState(): SavedTerminalState {
  try {
    if (existsSync(STORE_FILE)) {
      const data = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
      debugLog('[TerminalStateStore] Loaded', data.terminals?.length ?? 0, 'terminals');
      return {
        terminals: data.terminals || [],
        activeTerminalId: data.activeTerminalId || null,
        activeGroupId: data.activeGroupId || null,
      };
    }
  } catch (error) {
    debugError('[TerminalStateStore] Failed to load:', error);
  }
  return { ...DEFAULT_STATE };
}

export function saveTerminalState(state: SavedTerminalState): void {
  try {
    if (!existsSync(STORE_DIR)) {
      mkdirSync(STORE_DIR, { recursive: true });
    }
    writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    debugError('[TerminalStateStore] Failed to save:', error);
  }
}

export function saveOutputBuffers(buffers: Record<string, string>): void {
  try {
    if (!existsSync(STORE_DIR)) {
      mkdirSync(STORE_DIR, { recursive: true });
    }
    writeFileSync(BUFFERS_FILE, JSON.stringify(buffers));
    debugLog('[TerminalStateStore] Saved output buffers for', Object.keys(buffers).length, 'terminals');
  } catch (error) {
    debugError('[TerminalStateStore] Failed to save buffers:', error);
  }
}

export function loadOutputBuffers(): Record<string, string> {
  try {
    if (existsSync(BUFFERS_FILE)) {
      const data = JSON.parse(readFileSync(BUFFERS_FILE, 'utf-8'));
      debugLog('[TerminalStateStore] Loaded output buffers for', Object.keys(data).length, 'terminals');
      return data;
    }
  } catch (error) {
    debugError('[TerminalStateStore] Failed to load buffers:', error);
  }
  return {};
}
