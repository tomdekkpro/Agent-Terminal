import { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage } from 'electron';
import { join } from 'path';
import { TerminalManager } from './terminal/terminal-manager';
import { saveOutputBuffers } from './terminal/terminal-state-store';
import { registerTerminalHandlers } from './ipc/terminal-handlers';
import { registerTaskManagerHandlers } from './ipc/task-manager-handlers';
import { registerChatHandlers } from './ipc/chat-handlers';
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
import { setApiLogFile, flush as flushApiLog, getApiLogFile } from './logging/api-log';
import { IPC_CHANNELS } from '../shared/constants';
import { registerAllAgents } from './ipc/providers/agents';
import { initAnalytics, trackAppStarted, trackShutdown } from './analytics/analytics-service';
import { loadShellPath } from './shell-path';

// Before anything can spawn claude/gh/git/npm — a Finder-launched mac app
// otherwise has none of the user's PATH.
loadShellPath();

let mainWindow: BrowserWindow | null = null;
let terminalManager: TerminalManager | null = null;
let tray: Tray | null = null;
/** Set once a real quit starts, so the mac close-to-hide handler lets it through */
let isQuitting = false;

/** Resolve path to a resource file (works in both dev and packaged) */
function getResourcePath(filename: string): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, filename);
  }
  return join(__dirname, '../../resources', filename);
}

function setApplicationMenu() {
  if (process.platform !== 'darwin') {
    // Remove default menu bar
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS routes Cmd+C/V/X/A/Z, Cmd+Q/H/M/W through menu roles — with no menu
  // none of them work. No reload role: Cmd+R would wipe the renderer's state.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(getResourcePath('tray-icon.png'));
  // The 32px icon would render at 32pt in the 22pt mac menu bar
  tray = new Tray(process.platform === 'darwin' ? trayIcon.resize({ width: 18, height: 18 }) : trayIcon);
  tray.setToolTip('Agent Terminal');
  tray.on('click', showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createWindow() {

  const iconPath = getResourcePath('icon.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#1a1a2e',
    icon: iconPath,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 10 },
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

  // On mac the red button hides the window like other mac apps do; terminals,
  // Auto Code and the renderer's state keep running. Dock click brings it back.
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getWindow(): BrowserWindow | null {
  return mainWindow;
}

// Initialize analytics BEFORE app.whenReady() per Aptabase docs
initAnalytics();

app.whenReady().then(() => {
  // Point the outbound-API log at userData before anything can issue a request,
  // so the very first call of the session is recorded.
  const apiLogPath = join(app.getPath('userData'), 'logs', 'api-requests.log');
  setApiLogFile(apiLogPath);
  // eslint-disable-next-line no-console
  console.log(`[api] request log: ${apiLogPath}`);

  // Register all agent providers before anything else
  registerAllAgents();

  // Track app launch after ready
  trackAppStarted();

  terminalManager = new TerminalManager(getWindow);
  sessionUsageTracker.setWindowGetter(getWindow);

  registerTerminalHandlers(ipcMain, terminalManager, getWindow);
  registerTaskManagerHandlers(ipcMain);
  registerChatHandlers(ipcMain);
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

  // Where the outbound-API request log lives, so Settings can offer to open it.
  ipcMain.handle(IPC_CHANNELS.API_LOG_PATH, async () => {
    // Flush first — the newest lines are the ones being investigated.
    await flushApiLog();
    return getApiLogFile();
  });

  setApplicationMenu();
  createWindow();
  createTray();
});

// Dock icon click on mac
app.on('activate', showWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
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
  void flushApiLog();
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
