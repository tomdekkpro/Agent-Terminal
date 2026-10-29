import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '../shared/constants';
import { debugLog, debugError } from '../shared/utils';
import { getSettings } from './ipc/settings-handlers';
import {
  downloadMacUpdate,
  findMacZip,
  hasStagedMacUpdate,
  macInstallBlocker,
  startMacInstall,
} from './mac-updater';

/** On mac electron-updater only checks; mac-updater.ts downloads and installs
 *  (Squirrel.Mac rejects the ad-hoc signed build). */
const IS_MAC = process.platform === 'darwin';
const RELEASES_URL = 'https://github.com/tomdekkpro/Agent-Terminal/releases';

let latestInfo: UpdateInfo | undefined;

/** mac can't update in place: release has no zip, or the app is on the DMG /
 *  translocated / not writable. Download then just opens the release page. */
function isManualUpdate(info: UpdateInfo): boolean {
  return IS_MAC && (!findMacZip(info) || macInstallBlocker() !== null);
}
let getWindowRef: (() => BrowserWindow | null) | null = null;

function sendToRenderer(channel: string, ...args: any[]) {
  getWindowRef?.()?.webContents?.send(channel, ...args);
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null) {
  getWindowRef = getWindow;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = !IS_MAC;
  if (IS_MAC) {
    // Same as Windows: a downloaded update installs when the app quits
    app.on('will-quit', () => {
      if (hasStagedMacUpdate()) startMacInstall(false);
    });
  }

  autoUpdater.on('checking-for-update', () => {
    debugLog('[Updater] Checking for updates...');
    sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    debugLog('[Updater] Update available:', info.version);
    latestInfo = info;
    sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, {
      status: 'available',
      version: info.version,
      releaseNotes: info.releaseNotes,
      releaseDate: info.releaseDate,
      manual: isManualUpdate(info),
    });
  });

  autoUpdater.on('update-not-available', () => {
    debugLog('[Updater] No updates available');
    sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, { status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, {
      status: 'downloading',
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    debugLog('[Updater] Update downloaded:', info.version);
    sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, {
      status: 'ready',
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    debugError('[Updater] Error:', err.message);
    sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, {
      status: 'error',
      error: err.message,
    });
  });

  // IPC handlers
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, version: result?.updateInfo?.version };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    if (IS_MAC) {
      if (!latestInfo || isManualUpdate(latestInfo)) {
        const blocker = macInstallBlocker();
        if (blocker) debugLog('[Updater] mac in-place update unavailable:', blocker);
        await shell.openExternal(latestInfo ? `${RELEASES_URL}/tag/v${latestInfo.version}` : `${RELEASES_URL}/latest`);
        return { success: true, manual: true };
      }
      const info = latestInfo;
      try {
        await downloadMacUpdate(info, (percent, transferred, total) => {
          sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, { status: 'downloading', version: info.version, percent, transferred, total });
        });
        debugLog('[Updater] Update downloaded:', info.version);
        sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, { status: 'ready', version: info.version });
        return { success: true };
      } catch (err: any) {
        debugError('[Updater] mac download failed:', err.message);
        sendToRenderer(IPC_CHANNELS.UPDATE_STATUS, { status: 'error', error: err.message });
        return { success: false, error: err.message };
      }
    }
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    if (IS_MAC) {
      if (startMacInstall(true)) app.quit();
      return;
    }
    autoUpdater.quitAndInstall(false, true);
  });

  // Check for updates after a short delay on startup (if enabled)
  setTimeout(() => {
    const settings = getSettings();
    if (settings.autoUpdate) {
      autoUpdater.checkForUpdates().catch(() => {});
    }
  }, 5000);
}
