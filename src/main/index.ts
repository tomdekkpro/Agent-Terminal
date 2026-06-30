import { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage } from 'electron';
import { join } from 'path';
import { TerminalManager } from './terminal/terminal-manager';
import { saveOutputBuffers } from './terminal/terminal-state-store';
import { registerTerminalHandlers } from './ipc/terminal-handlers';
import { registerTaskManagerHandlers } from './ipc/task-manager-handlers';
import { registerSettingsHandlers } from './ipc/settings-handlers';
import { registerUsageHandlers, stopUsagePolling } from './ipc/usage-handlers';
import { sessionUsageTracker } from './usage/session-usage-tracker';
import { registerServiceStatusHandlers, stopServiceStatusPolling } from './ipc/service-status-handlers';
import { registerSystemMonitorHandlers, stopSystemMonitorPolling } from './ipc/system-monitor-handlers';
import { registerProjectHandlers } from './ipc/project-handlers';
import { registerGitHandlers } from './ipc/git-handlers';
import { registerInsightsHandlers, cleanupInsights } from './ipc/insights-handlers';
import { registerTeamHandlers, cleanupTeam } from './ipc/team-handlers';
import { registerQCHandlers } from './ipc/qc-handlers';
import { registerCodeReviewHandlers } from './ipc/code-review-handlers';
import { registerAutoCodeHandlers, stopAutoCodeOrchestrator } from './ipc/auto-code-handlers';
import { registerKanbanHandlers } from './ipc/kanban-handlers';
import { registerActivityHandlers } from './ipc/activity-handlers';
import { registerDashboardHandlers, stopDashboardScheduler } from './ipc/dashboard-handlers';
import { flushKanbanTasks } from './kanban/kanban-task-store';
import { flushNotices } from './dashboard/notice-store';
import { registerClaudeSessionsHandlers } from './ipc/claude-sessions-handlers';
import { registerDevServerHandlers } from './ipc/dev-server-handlers';
import { registerFilesHandlers } from './ipc/files-handlers';
import { stopAllDevServers } from './dev-server/dev-server-manager';
import { cleanupAllQC } from './qc/qc-executor';
import { initAutoUpdater } from './updater';
import { IPC_CHANNELS } from '../shared/constants';
import { registerAllAgents } from './ipc/providers/agents';
import { initAnalytics, trackAppStarted, trackShutdown } from './analytics/analytics-service';

let mainWindow: BrowserWindow | null = null;
let terminalManager: TerminalManager | null = null;
let tray: Tray | null = null;

/** Resolve path to a resource file (works in both dev and packaged) */
function getResourcePath(filename: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, filename);
  }
  return join(__dirname, '../../resources', filename);
}

function createWindow() {
  // Remove default menu bar
  Menu.setApplicationMenu(null);

  const iconPath = getResourcePath('icon.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    icon: iconPath,
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? false : true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
    },
  });

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Create tray icon
  const trayIconPath = getResourcePath('tray-icon.png');
  const trayIcon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(trayIcon);
  tray.setToolTip('Agent Terminal');
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function getWindow(): BrowserWindow | null {
  return mainWindow;
}

// Initialize analytics BEFORE app.whenReady() per Aptabase docs
initAnalytics();

app.whenReady().then(() => {
  // Register all agent providers before anything else
  registerAllAgents();

  // Track app launch after ready
  trackAppStarted();

  terminalManager = new TerminalManager(getWindow);
  sessionUsageTracker.setWindowGetter(getWindow);

  registerTerminalHandlers(ipcMain, terminalManager, getWindow);
  registerTaskManagerHandlers(ipcMain);
  registerSettingsHandlers(ipcMain);
  registerUsageHandlers(ipcMain, getWindow);
  registerProjectHandlers(ipcMain, getWindow);
  registerGitHandlers(ipcMain);
  registerInsightsHandlers(ipcMain, getWindow);
  registerTeamHandlers(ipcMain, getWindow);
  registerQCHandlers(ipcMain, getWindow);
  registerCodeReviewHandlers(ipcMain, getWindow);
  registerKanbanHandlers(ipcMain, getWindow);
  registerActivityHandlers(ipcMain, getWindow);
  registerDashboardHandlers(ipcMain, getWindow);
  registerAutoCodeHandlers(ipcMain, getWindow);
  registerClaudeSessionsHandlers(ipcMain);
  registerDevServerHandlers(ipcMain, getWindow);
  registerFilesHandlers(ipcMain);
  registerServiceStatusHandlers(ipcMain, getWindow);
  registerSystemMonitorHandlers(ipcMain, getWindow);
  initAutoUpdater(getWindow);

  // Open external links
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, async (_event, url: string) => {
    await shell.openExternal(url);
  });

  // Open local file paths (e.g., screenshots)
  ipcMain.handle(IPC_CHANNELS.OPEN_PATH, async (_event, filePath: string) => {
    await shell.openPath(filePath);
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  trackShutdown();
  cleanupInsights();
  cleanupTeam();
  cleanupAllQC();
  stopAllDevServers();
  stopUsagePolling();
  stopServiceStatusPolling();
  stopSystemMonitorPolling();
  stopAutoCodeOrchestrator();
  stopDashboardScheduler();
  flushKanbanTasks();
  flushNotices();
  if (terminalManager) {
    // Save output buffers while terminals are still alive
    // (terminals are killed later in will-quit, after renderer has saved state)
    saveOutputBuffers(terminalManager.getOutputBuffers());
  }
});

// Kill terminals AFTER all windows are closed (after beforeunload has saved state)
app.on('will-quit', () => {
  if (terminalManager) {
    terminalManager.killAll();
  }
});
