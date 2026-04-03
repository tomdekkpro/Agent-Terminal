import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import type { BrowserWindow } from 'electron';
import type { DevServerType, DevServerStatus, DevServerEvent, DevServerConfig } from '../../shared/types';
import { IPC_CHANNELS } from '../../shared/constants';
import { debugLog, debugError } from '../../shared/utils';

interface RunningServer {
  process: ChildProcess;
  status: DevServerStatus;
  type: DevServerType;
  projectId: string;
}

/** Key format: `${projectId}:${type}` */
const servers = new Map<string, RunningServer>();

function key(projectId: string, type: DevServerType): string {
  return `${projectId}:${type}`;
}

function broadcast(getWindow: () => BrowserWindow | null, event: DevServerEvent): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.DEV_SERVER_EVENT, event);
  }
}

export function startDevServer(
  projectId: string,
  type: DevServerType,
  projectPath: string,
  config: DevServerConfig,
  getWindow: () => BrowserWindow | null,
): { success: boolean; error?: string } {
  const k = key(projectId, type);

  // Already running?
  const existing = servers.get(k);
  if (existing && existing.status === 'running') {
    return { success: false, error: 'Server is already running' };
  }

  let cmd = type === 'frontend' ? config.frontendCmd : config.backendCmd;
  const cwd = type === 'frontend' ? config.frontendCwd : config.backendCwd;

  if (!cmd) {
    return { success: false, error: `No ${type} command configured` };
  }

  // Append launch profile for backend dotnet projects
  if (type === 'backend' && config.backendProfile) {
    cmd += ` --launch-profile "${config.backendProfile}"`;
  }

  // Resolve cwd relative to project path
  const resolvedCwd = cwd ? join(projectPath, cwd) : projectPath;

  if (!existsSync(resolvedCwd)) {
    return { success: false, error: `Working directory not found: ${resolvedCwd}` };
  }

  debugLog(`[DevServer] Starting ${type} for project ${projectId}: ${cmd} in ${resolvedCwd}`);

  broadcast(getWindow, { projectId, type, status: 'starting' });

  try {
    // On Windows we need shell: true to handle npm/ng/dotnet commands
    const child = spawn(cmd, [], {
      cwd: resolvedCwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      detached: false,
    });

    const server: RunningServer = {
      process: child,
      status: 'running',
      type,
      projectId,
    };
    servers.set(k, server);

    broadcast(getWindow, { projectId, type, status: 'running', pid: child.pid });

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      debugLog(`[DevServer:${type}:${projectId}] ${text.trimEnd()}`);
      broadcast(getWindow, { projectId, type, status: 'running', output: text });
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      // stderr is not necessarily an error — many tools write progress to stderr
      debugLog(`[DevServer:${type}:${projectId}:stderr] ${text.trimEnd()}`);
      broadcast(getWindow, { projectId, type, status: 'running', output: text });
    });

    child.on('error', (err) => {
      debugError(`[DevServer] ${type} error for ${projectId}:`, err);
      server.status = 'error';
      broadcast(getWindow, { projectId, type, status: 'error', error: err.message });
      servers.delete(k);
    });

    child.on('exit', (code) => {
      debugLog(`[DevServer] ${type} exited for ${projectId} with code ${code}`);
      server.status = 'stopped';
      broadcast(getWindow, { projectId, type, status: 'stopped' });
      servers.delete(k);
    });

    return { success: true };
  } catch (err: any) {
    debugError(`[DevServer] Failed to start ${type} for ${projectId}:`, err);
    broadcast(getWindow, { projectId, type, status: 'error', error: err.message });
    return { success: false, error: err.message };
  }
}

export function stopDevServer(projectId: string, type: DevServerType): { success: boolean; error?: string } {
  const k = key(projectId, type);
  const server = servers.get(k);

  if (!server) {
    return { success: false, error: 'Server is not running' };
  }

  debugLog(`[DevServer] Stopping ${type} for project ${projectId}`);

  try {
    // On Windows, we need to kill the whole process tree since shell: true creates a cmd wrapper
    if (process.platform === 'win32' && server.process.pid) {
      spawn('taskkill', ['/pid', String(server.process.pid), '/f', '/t'], { stdio: 'ignore' });
    } else {
      server.process.kill('SIGTERM');
    }
    servers.delete(k);
    return { success: true };
  } catch (err: any) {
    debugError(`[DevServer] Failed to stop ${type} for ${projectId}:`, err);
    return { success: false, error: err.message };
  }
}

export function getDevServerStatus(projectId: string): { frontend: DevServerStatus; backend: DevServerStatus } {
  const fe = servers.get(key(projectId, 'frontend'));
  const be = servers.get(key(projectId, 'backend'));
  return {
    frontend: fe?.status || 'stopped',
    backend: be?.status || 'stopped',
  };
}

export function stopAllDevServers(): void {
  for (const [k, server] of servers) {
    debugLog(`[DevServer] Shutting down ${k}`);
    try {
      if (process.platform === 'win32' && server.process.pid) {
        spawn('taskkill', ['/pid', String(server.process.pid), '/f', '/t'], { stdio: 'ignore' });
      } else {
        server.process.kill('SIGTERM');
      }
    } catch {
      // ignore cleanup errors
    }
  }
  servers.clear();
}
