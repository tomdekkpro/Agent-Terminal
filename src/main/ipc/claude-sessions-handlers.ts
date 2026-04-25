import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { ClaudeSessionEntry } from '../../shared/types';

function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[:/\\]/g, '-');
}

export function registerClaudeSessionsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.CLAUDE_SESSIONS_LIST, async (_event, cwd: string) => {
    try {
      const encoded = encodeProjectPath(cwd);
      const indexPath = join(os.homedir(), '.claude', 'projects', encoded, 'sessions-index.json');

      if (!existsSync(indexPath)) {
        return { success: true, data: [] };
      }

      const raw = await readFile(indexPath, 'utf-8');
      const parsed = JSON.parse(raw);

      const entries: ClaudeSessionEntry[] = (parsed.entries || [])
        .filter((e: ClaudeSessionEntry) => !e.isSidechain)
        .sort((a: ClaudeSessionEntry, b: ClaudeSessionEntry) =>
          new Date(b.modified).getTime() - new Date(a.modified).getTime()
        );

      return { success: true, data: entries };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load Claude sessions',
      };
    }
  });

  // Check if a specific session file exists for a given cwd. Used by the
  // Kanban restore path to verify the stored agentCwd is still the right
  // place to resume from before invoking `claude --resume`.
  ipcMain.handle(
    IPC_CHANNELS.CLAUDE_SESSION_EXISTS,
    async (_event, cwd: string, sessionId: string) => {
      try {
        if (!cwd || !sessionId) return { success: true, data: false };
        const encoded = encodeProjectPath(cwd);
        const sessionPath = join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
        return { success: true, data: existsSync(sessionPath) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to check session file',
        };
      }
    },
  );
}
