import type { IpcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { DevServerType } from '../../shared/types';
import { startDevServer, stopDevServer, getDevServerStatus } from '../dev-server/dev-server-manager';
import { detectDevServers } from '../dev-server/dev-server-detect';
import { getProjects } from '../project/project-store';

export function registerDevServerHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle(
    IPC_CHANNELS.DEV_SERVER_START,
    async (_event, projectId: string, type: DevServerType) => {
      const project = getProjects().find((p) => p.id === projectId);
      if (!project) return { success: false, error: 'Project not found' };
      if (!project.devServer) return { success: false, error: 'Dev server not configured. Open Project Settings to set up commands.' };

      const result = startDevServer(projectId, type, project.path, project.devServer, getWindow);
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DEV_SERVER_STOP,
    async (_event, projectId: string, type: DevServerType) => {
      return stopDevServer(projectId, type);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DEV_SERVER_STATUS,
    async (_event, projectId: string) => {
      return { success: true, data: getDevServerStatus(projectId) };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.DEV_SERVER_DETECT,
    async (_event, projectPath: string) => {
      const result = detectDevServers(projectPath);
      return { success: true, data: result };
    },
  );
}
