import { app, type IpcMain } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { IPC_CHANNELS } from '../../shared/constants';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types';
import { track } from '../analytics/analytics-service';

const SETTINGS_DIR = join(app.getPath('userData'), 'config');
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json');

let settingsCache: AppSettings | null = null;

export function getSettings(): AppSettings {
  if (settingsCache) return settingsCache;

  try {
    if (existsSync(SETTINGS_FILE)) {
      const data = readFileSync(SETTINGS_FILE, 'utf-8');
      const raw = JSON.parse(data);

      // ─── Migrations ─────────────────────────────────────────

      // Migrate legacy clickupEnabled → taskManagerProvider
      if (raw.taskManagerProvider === undefined) {
        if (raw.clickupEnabled === true) {
          raw.taskManagerProvider = 'clickup';
        } else {
          raw.taskManagerProvider = 'none';
        }
        delete raw.clickupEnabled;
      }

      // Migrate legacy defaultCopilotProvider → defaultAgentProvider
      if (raw.defaultAgentProvider === undefined && raw.defaultCopilotProvider) {
        raw.defaultAgentProvider = raw.defaultCopilotProvider;
      }

      // Migrate legacy defaultModel → agentModels.claude
      if (!raw.agentModels) {
        raw.agentModels = { ...DEFAULT_SETTINGS.agentModels };
        if (raw.defaultModel) {
          raw.agentModels.claude = raw.defaultModel;
        }
        if (raw.defaultCopilotModel) {
          raw.agentModels.copilot = raw.defaultCopilotModel;
        }
      }

      // Initialize agentConfig if missing
      if (!raw.agentConfig) {
        raw.agentConfig = {};
      }

      // Migrate Auto-Fix → Auto Code settings (renamed in the Auto Code refactor).
      // Copy any legacy autoFix* key into its autoCode* counterpart, then drop
      // the old key. autoFixRetestStatus became autoCodeReviewStatus.
      const autoCodeKeyMap: Record<string, string> = {
        autoFixEnabled: 'autoCodeEnabled',
        autoFixMaxIterations: 'autoCodeMaxIterations',
        autoFixPollIntervalMinutes: 'autoCodePollIntervalMinutes',
        autoFixFailedStatus: 'autoCodeFailedStatus',
        autoFixRetestStatus: 'autoCodeReviewStatus',
        autoFixDoneStatus: 'autoCodeDoneStatus',
        autoFixProjectPath: 'autoCodeProjectPath',
        autoFixAutoMerge: 'autoCodeAutoMerge',
        autoFixReviewGate: 'autoCodeReviewGate',
      };
      for (const [oldKey, newKey] of Object.entries(autoCodeKeyMap)) {
        if (raw[oldKey] !== undefined) {
          if (raw[newKey] === undefined) raw[newKey] = raw[oldKey];
          delete raw[oldKey];
        }
      }

      // Clean up deprecated fields from persisted data
      delete raw.defaultCopilotProvider;
      delete raw.defaultCopilotModel;

      settingsCache = { ...DEFAULT_SETTINGS, ...raw };
    } else {
      settingsCache = { ...DEFAULT_SETTINGS };
    }
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }

  return settingsCache!;
}

function saveSettings(settings: AppSettings): void {
  try {
    if (!existsSync(SETTINGS_DIR)) {
      mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    // Strip deprecated fields before saving
    const { defaultCopilotProvider: _, defaultCopilotModel: __, ...clean } = settings as any;
    writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2));
    settingsCache = settings;
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

export function registerSettingsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, async () => {
    return { success: true, data: getSettings() };
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_event, key: string) => {
    const settings = getSettings();
    return { success: true, data: settings[key as keyof AppSettings] };
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, updates: Partial<AppSettings>) => {
    const settings = getSettings();
    const updated = { ...settings, ...updates };
    saveSettings(updated);

    // Track non-sensitive setting changes
    const trackedKeys = ['taskManagerProvider', 'defaultAgentProvider', 'theme', 'telemetryEnabled'] as const;
    for (const key of trackedKeys) {
      if (key in updates) {
        track('setting_changed', { key, value: String(updates[key as keyof AppSettings]) });
      }
    }

    return { success: true, data: updated };
  });
}
