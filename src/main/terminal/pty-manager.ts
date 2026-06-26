import * as pty from '@lydell/node-pty';
import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import type { TerminalProcess, WindowGetter } from './types';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog, debugError } from '../../shared/utils';

let isShuttingDown = false;

export function setShuttingDown(value: boolean): void {
  isShuttingDown = value;
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

function detectShellType(shellPath: string): 'cmd' | 'powershell' | 'bash' {
  const filename = shellPath.split(/[/\\]/).pop()?.toLowerCase() || '';
  if (filename === 'powershell.exe' || filename === 'pwsh.exe') return 'powershell';
  if (
    filename === 'bash.exe' ||
    filename === 'git-bash.exe' ||
    filename === 'zsh.exe' ||
    filename === 'sh.exe' ||
    filename === 'fish.exe'
  ) return 'bash';
  return 'cmd';
}

export interface SpawnPtyResult {
  pty: pty.IPty;
  shellType?: 'cmd' | 'powershell' | 'bash';
  /** The directory the PTY was actually spawned in. Differs from the requested
   *  cwd when that path was missing/invalid and we fell back to the home dir. */
  cwd: string;
}

/**
 * Resolve a usable spawn directory. node-pty throws (Windows error 267 —
 * "The directory name is invalid") when handed a cwd that doesn't exist, which
 * happens routinely for deleted worktrees or renamed/removed project folders.
 * Validate the path up front and fall back to the home directory so terminal
 * creation degrades gracefully instead of crashing.
 */
function resolveSpawnCwd(cwd: string | undefined): string {
  const home = os.homedir();
  if (!cwd) return home;
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd;
    debugError('[PtyManager] cwd is not a directory, falling back to home:', cwd);
  } catch {
    debugError('[PtyManager] cwd does not exist, falling back to home:', cwd);
  }
  return home;
}

export function spawnPtyProcess(
  cwd: string,
  cols: number,
  rows: number,
  profileEnv?: Record<string, string>
): SpawnPtyResult {
  let shell: string;
  let shellType: 'cmd' | 'powershell' | 'bash' | undefined;

  if (isWindows()) {
    shell = process.env.COMSPEC || 'cmd.exe';
    shellType = detectShellType(shell);
  } else {
    shell = process.env.SHELL || '/bin/zsh';
    shellType = undefined;
  }

  const shellArgs = isWindows() ? [] : ['-l'];
  const { DEBUG: _DEBUG, ...cleanEnv } = process.env;
  const spawnCwd = resolveSpawnCwd(cwd);

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spawnCwd,
    env: {
      ...cleanEnv,
      ...profileEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PROMPT_EOL_MARK: '',
    },
  });

  return { pty: ptyProcess, shellType, cwd: spawnCwd };
}

export function setupPtyHandlers(
  terminal: TerminalProcess,
  terminals: Map<string, TerminalProcess>,
  getWindow: WindowGetter,
  onDataCallback: (terminal: TerminalProcess, data: string) => void,
  onExitCallback: (terminal: TerminalProcess) => void
): void {
  const { id, pty: ptyProcess } = terminal;
  terminal.hasExited = false;

  ptyProcess.onData((data) => {
    if (isShuttingDown || terminal.hasExited) return;
    // Only accumulate output buffer for agent terminals (for session restore)
    if (terminal.isAgentMode || terminal.agentSessionId) {
      terminal.outputBuffer = (terminal.outputBuffer + data).slice(-100000);
    }

    try {
      onDataCallback(terminal, data);
    } catch (error) {
      debugError('[PtyManager] onData callback failed:', id, error);
    }

    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.TERMINAL_OUTPUT, id, data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    terminal.hasExited = true;
    debugLog('[PtyManager] Terminal exited:', id, 'code:', exitCode);

    if (isShuttingDown) return;

    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.TERMINAL_EXIT, id, exitCode);
    }

    try {
      onExitCallback(terminal);
    } catch (error) {
      debugError('[PtyManager] onExit callback failed:', id, error);
    }

    if (terminals.get(id) === terminal) {
      terminals.delete(id);
    }
  });
}

const CHUNKED_WRITE_THRESHOLD = 16_384;
const CHUNK_SIZE = 8_192;
const pendingWrites = new Map<string, Promise<void>>();

function performWrite(terminal: TerminalProcess, data: string): Promise<void> {
  return new Promise((resolve) => {
    if (terminal.hasExited) {
      resolve();
      return;
    }

    if (data.length > CHUNKED_WRITE_THRESHOLD) {
      let offset = 0;
      const writeChunk = () => {
        if (!terminal.pty || terminal.hasExited || offset >= data.length) {
          resolve();
          return;
        }
        const chunk = data.slice(offset, offset + CHUNK_SIZE);
        try {
          terminal.pty.write(chunk);
          offset += CHUNK_SIZE;
          setImmediate(writeChunk);
        } catch {
          resolve();
        }
      };
      setImmediate(writeChunk);
    } else {
      try {
        terminal.pty.write(data);
      } catch {
        // Swallow write errors for exited terminals
      }
      resolve();
    }
  });
}

export function writeToPty(terminal: TerminalProcess, data: string): void {
  if (terminal.hasExited) return;
  const previousWrite = pendingWrites.get(terminal.id) || Promise.resolve();
  const currentWrite = previousWrite.then(() => performWrite(terminal, data));
  pendingWrites.set(terminal.id, currentWrite);
  currentWrite.finally(() => {
    if (pendingWrites.get(terminal.id) === currentWrite) {
      pendingWrites.delete(terminal.id);
    }
  });
}

export function resizePty(terminal: TerminalProcess, cols: number, rows: number): boolean {
  if (terminal.hasExited) return false;
  if (cols <= 0 || rows <= 0 || !Number.isFinite(cols) || !Number.isFinite(rows)) return false;

  try {
    const prevCols = terminal.pty.cols;
    const prevRows = terminal.pty.rows;
    if (prevCols === cols && prevRows === rows) {
      terminal.pty.resize(Math.max(1, cols - 1), rows);
    }
    terminal.pty.resize(cols, rows);
    return true;
  } catch {
    return false;
  }
}

export function killPty(terminal: TerminalProcess): void {
  if (terminal.hasExited) return;

  const pid = terminal.pty.pid;

  // On Windows, kill the entire process tree so child processes (Claude CLI, etc.) are cleaned up
  if (isWindows() && pid) {
    try {
      // taskkill /T kills the process tree, /F forces termination
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
        if (err) {
          debugLog('[PtyManager] taskkill tree failed, falling back to pty.kill():', err.message);
          try { terminal.pty.kill(); } catch { /* swallow */ }
        }
      });
    } catch {
      try { terminal.pty.kill(); } catch { /* swallow */ }
    }
  } else {
    try {
      terminal.pty.kill();
    } catch {
      // Swallow kill errors
    }
  }
}
