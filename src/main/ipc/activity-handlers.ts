import type { BrowserWindow, IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import {
  initActivity,
  listActivity,
  markActivityRead,
  markAllActivityRead,
  clearActivity,
} from '../activity/activity-store';

export function registerActivityHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  initActivity(getWindow);

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_LIST, () => ({
    success: true,
    data: listActivity(),
  }));

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_MARK_READ, (_e, id: string) => {
    markActivityRead(id);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_MARK_ALL_READ, () => {
    markAllActivityRead();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_CLEAR, () => {
    clearActivity();
    return { success: true };
  });
}
