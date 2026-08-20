import { useState, useEffect } from 'react';
import { Settings, Terminal, CheckSquare, Bot, Palette, Save, RotateCcw, Loader2, CheckCircle, XCircle, Info, RefreshCw, Download, Users, ShieldCheck, Plus, Trash2, Eye, EyeOff, Wifi, Server, Square, Wrench, FolderOpen } from 'lucide-react';
import { useSettingsStore } from '../../stores/settings-store';
import { useTeamStore } from '../../stores/team-store';
import { useProjectStore } from '../../stores/project-store';
import type { AppSettings, AgentProviderMeta, QCCredential } from '../../../shared/types';
import { cn } from '../../../shared/utils';
import { APP_VERSION } from '../../lib/version';

type SettingsSection = 'general' | 'terminal' | 'tasks' | 'testing' | 'auto-code' | 'agent' | 'team' | 'appearance';

const sections: { id: SettingsSection; icon: typeof Terminal; label: string; description: string }[] = [
  { id: 'general', icon: Info, label: 'General', description: 'Version and update settings' },
  { id: 'terminal', icon: Terminal, label: 'Terminal', description: 'Font, cursor, and display settings' },
  { id: 'tasks', icon: CheckSquare, label: 'Tasks', description: 'Task manager integration' },
  { id: 'testing', icon: ShieldCheck, label: 'Testing', description: 'QC Testing default URL and credentials' },
  { id: 'auto-code', icon: Wrench, label: 'Auto Code Loop', description: 'Autonomously implement & fix tasks from description and QC feedback' },
  { id: 'agent', icon: Bot, label: 'Agent', description: 'AI agent provider configuration' },
  { id: 'team', icon: Users, label: 'Team', description: 'Real-time team chat settings' },
  { id: 'appearance', icon: Palette, label: 'Appearance', description: 'Theme and display options' },
];

export function SettingsView() {
  const { settings, loadSettings, updateSettings, isLoading } = useSettingsStore();
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error'>('idle');
  const [updateInfo, setUpdateInfo] = useState<{ version?: string; percent?: number; error?: string }>({});

  const [agentProviders, setAgentProviders] = useState<AgentProviderMeta[]>([]);
  const [visibleCredValues, setVisibleCredValues] = useState<Record<number, boolean>>({});
  const projects = useProjectStore((s) => s.projects);

  useEffect(() => {
    loadSettings();
    window.electronAPI.getAgentProviders?.()
      .then((result: any) => {
        if (result.success && result.data) setAgentProviders(result.data);
      })
      .catch(() => {});
  }, [loadSettings]);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  useEffect(() => {
    const cleanup = window.electronAPI.onUpdateStatus((data: any) => {
      setUpdateStatus(data.status);
      setUpdateInfo({
        version: data.version,
        percent: data.percent,
        error: data.error,
      });
    });
    return () => { cleanup(); };
  }, []);

  const handleChange = (key: keyof AppSettings, value: any) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    setSaving(true);
    await updateSettings(localSettings);
    setHasChanges(false);
    setSaving(false);
  };

  const handleReset = () => {
    setLocalSettings(settings);
    setHasChanges(false);
  };

  const testConnection = async () => {
    setConnectionStatus('checking');
    setConnectionMessage('');
    try {
      // Save provider-specific fields first
      const providerFields: Partial<AppSettings> = {
        taskManagerProvider: localSettings.taskManagerProvider,
      };
      if (localSettings.taskManagerProvider === 'clickup') {
        providerFields.clickupApiKey = localSettings.clickupApiKey;
        providerFields.clickupWorkspaceId = localSettings.clickupWorkspaceId;
      } else if (localSettings.taskManagerProvider === 'jira') {
        providerFields.jiraEmail = localSettings.jiraEmail;
        providerFields.jiraApiToken = localSettings.jiraApiToken;
        providerFields.jiraDomain = localSettings.jiraDomain;
        providerFields.jiraProjectKey = localSettings.jiraProjectKey;
      }

      await updateSettings(providerFields);

      const result = await window.electronAPI.checkTaskManagerConnection();
      if (result.success) {
        setConnectionStatus('connected');
        if (localSettings.taskManagerProvider === 'clickup') {
          const workspace = result.data?.workspaces?.[0];
          setConnectionMessage(`Connected to ${workspace?.name || 'workspace'}`);
        } else if (localSettings.taskManagerProvider === 'jira') {
          const user = result.data?.user;
          setConnectionMessage(`Connected as ${user?.displayName || user?.emailAddress || 'user'}`);
        }
      } else {
        setConnectionStatus('error');
        setConnectionMessage(result.error || 'Connection failed');
      }
    } catch (err) {
      setConnectionStatus('error');
      setConnectionMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-12 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center px-4 justify-between drag-region">
        <div className="flex items-center gap-2 no-drag">
          <Settings className="w-4 h-4 text-[var(--text-muted)]" />
          <h1 className="text-sm font-semibold text-[var(--text-primary)]">Settings</h1>
        </div>
        <div className="flex items-center gap-2 no-drag">
          {hasChanges && (
            <>
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save Changes
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-56 bg-[var(--bg-secondary)] border-r border-[var(--border)] p-3 space-y-1">
          {sections.map(({ id, icon: Icon, label, description }) => (
            <button
              key={id}
              onClick={() => setActiveSection(id)}
              className={cn(
                'w-full text-left p-3 rounded-lg transition-colors',
                activeSection === id
                  ? 'bg-[var(--bg-card)] border border-[var(--border)]'
                  : 'hover:bg-[var(--bg-tertiary)]'
              )}
            >
              <div className="flex items-center gap-2">
                <Icon className={cn('w-4 h-4', activeSection === id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')} />
                <span className={cn('text-sm', activeSection === id ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
                  {label}
                </span>
              </div>
              <p className="text-[10px] text-[var(--text-muted)] mt-1 ml-6">{description}</p>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeSection === 'general' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">General</h2>

              <div className="space-y-4">
                {/* Version */}
                <div className="p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">Agent Terminal</p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">Version {APP_VERSION}</p>
                      <p className="text-[10px] text-[var(--text-muted)] mt-1">&copy; {new Date().getFullYear()} Tom. All rights reserved.</p>
                    </div>
                    {updateStatus === 'up-to-date' && (
                      <span className="flex items-center gap-1.5 text-xs text-[var(--success)]">
                        <CheckCircle className="w-3.5 h-3.5" />
                        Up to date
                      </span>
                    )}
                    {updateStatus === 'available' && (
                      <span className="flex items-center gap-1.5 text-xs text-[var(--warning)]">
                        <Download className="w-3.5 h-3.5" />
                        v{updateInfo.version} available
                      </span>
                    )}
                    {updateStatus === 'ready' && (
                      <span className="flex items-center gap-1.5 text-xs text-[var(--success)]">
                        <CheckCircle className="w-3.5 h-3.5" />
                        v{updateInfo.version} ready to install
                      </span>
                    )}
                  </div>
                </div>

                {/* Auto Update */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm text-[var(--text-secondary)]">Automatic Updates</label>
                    <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Check for updates when the app starts</p>
                  </div>
                  <button
                    onClick={() => handleChange('autoUpdate', !localSettings.autoUpdate)}
                    className={cn(
                      'w-10 h-5 rounded-full transition-colors relative',
                      localSettings.autoUpdate ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                    )}
                  >
                    <div className={cn(
                      'w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform',
                      localSettings.autoUpdate ? 'translate-x-5' : 'translate-x-0.5'
                    )} />
                  </button>
                </div>

                {/* Anonymous Analytics */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm text-[var(--text-secondary)]">Anonymous Analytics</label>
                    <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Help improve Agent Terminal by sending anonymous usage data. No personal data is collected.</p>
                  </div>
                  <button
                    onClick={() => handleChange('telemetryEnabled', !localSettings.telemetryEnabled)}
                    className={cn(
                      'w-10 h-5 rounded-full transition-colors relative shrink-0',
                      localSettings.telemetryEnabled !== false ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                    )}
                  >
                    <div className={cn(
                      'w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform',
                      localSettings.telemetryEnabled !== false ? 'translate-x-5' : 'translate-x-0.5'
                    )} />
                  </button>
                </div>

                {/* Check for Updates */}
                <div>
                  <button
                    onClick={async () => {
                      setUpdateStatus('checking');
                      setUpdateInfo({});
                      try {
                        const result = await window.electronAPI.checkForUpdate();
                        if (!result.success) {
                          setUpdateStatus('error');
                          setUpdateInfo({ error: result.error || 'Failed to check for updates' });
                        }
                      } catch {
                        setUpdateStatus('error');
                        setUpdateInfo({ error: 'Failed to check for updates' });
                      }
                    }}
                    disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-50"
                  >
                    {updateStatus === 'checking' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                    Check for Updates
                  </button>

                  {updateStatus === 'downloading' && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
                        <span>Downloading v{updateInfo.version}...</span>
                        <span>{updateInfo.percent ?? 0}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded-full transition-all"
                          style={{ width: `${updateInfo.percent ?? 0}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {updateStatus === 'available' && (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={() => window.electronAPI.downloadUpdate()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download v{updateInfo.version}
                      </button>
                    </div>
                  )}

                  {updateStatus === 'ready' && (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={() => window.electronAPI.installUpdate()}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-[var(--success)] text-white hover:opacity-90 transition-opacity"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Restart & Install
                      </button>
                    </div>
                  )}

                  {updateStatus === 'error' && (
                    <p className="text-xs text-[var(--error)] mt-2">{updateInfo.error || 'Failed to check for updates'}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'terminal' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Terminal Settings</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Font Family</label>
                  <input
                    type="text"
                    value={localSettings.terminalFontFamily}
                    onChange={(e) => handleChange('terminalFontFamily', e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Font Size</label>
                    <input
                      type="number"
                      min={8}
                      max={32}
                      value={localSettings.terminalFontSize}
                      onChange={(e) => handleChange('terminalFontSize', parseInt(e.target.value))}
                      className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Line Height</label>
                    <input
                      type="number"
                      min={1}
                      max={2}
                      step={0.1}
                      value={localSettings.terminalLineHeight}
                      onChange={(e) => handleChange('terminalLineHeight', parseFloat(e.target.value))}
                      className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Cursor Style</label>
                    <select
                      value={localSettings.terminalCursorStyle}
                      onChange={(e) => handleChange('terminalCursorStyle', e.target.value)}
                      className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    >
                      <option value="block">Block</option>
                      <option value="underline">Underline</option>
                      <option value="bar">Bar</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Scrollback Lines</label>
                    <input
                      type="number"
                      min={1000}
                      max={100000}
                      step={1000}
                      value={localSettings.terminalScrollback}
                      onChange={(e) => handleChange('terminalScrollback', parseInt(e.target.value))}
                      className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <label className="text-sm text-[var(--text-secondary)]">Cursor Blink</label>
                  <button
                    onClick={() => handleChange('terminalCursorBlink', !localSettings.terminalCursorBlink)}
                    className={cn(
                      'w-10 h-5 rounded-full transition-colors relative',
                      localSettings.terminalCursorBlink ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                    )}
                  >
                    <div className={cn(
                      'w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform',
                      localSettings.terminalCursorBlink ? 'translate-x-5' : 'translate-x-0.5'
                    )} />
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm text-[var(--text-secondary)]">GPU Acceleration</label>
                    <p className="text-[10px] text-[var(--text-muted)] mt-0.5">Use WebGL renderer for faster terminal output. Restart terminals to apply.</p>
                  </div>
                  <button
                    onClick={() => handleChange('terminalGpuAcceleration', !localSettings.terminalGpuAcceleration)}
                    className={cn(
                      'w-10 h-5 rounded-full transition-colors relative shrink-0',
                      localSettings.terminalGpuAcceleration ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
                    )}
                  >
                    <div className={cn(
                      'w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform',
                      localSettings.terminalGpuAcceleration ? 'translate-x-5' : 'translate-x-0.5'
                    )} />
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'tasks' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Task Manager Integration</h2>

              <div className="space-y-4">
                {/* Provider selector */}
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Task Manager Provider</label>
                  <select
                    value={localSettings.taskManagerProvider}
                    onChange={(e) => {
                      handleChange('taskManagerProvider', e.target.value);
                      setConnectionStatus('idle');
                      setConnectionMessage('');
                    }}
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  >
                    <option value="none">None</option>
                    <option value="clickup">ClickUp</option>
                    <option value="jira">Jira Cloud</option>
                  </select>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">Connect a task manager to link terminals with tasks</p>
                </div>

                {/* ClickUp config */}
                {localSettings.taskManagerProvider === 'clickup' && (
                  <>
                    <div>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">API Token</label>
                      <input
                        type="password"
                        value={localSettings.clickupApiKey}
                        onChange={(e) => handleChange('clickupApiKey', e.target.value)}
                        placeholder="pk_xxxxx..."
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                      <p className="text-[10px] text-[var(--text-muted)] mt-1">
                        Get your token from ClickUp Settings → Apps
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Workspace ID</label>
                      <input
                        type="text"
                        value={localSettings.clickupWorkspaceId}
                        onChange={(e) => handleChange('clickupWorkspaceId', e.target.value)}
                        placeholder="Enter workspace ID"
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>

                    <div>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">List IDs (Optional)</label>
                      <textarea
                        value={localSettings.clickupListIds}
                        onChange={(e) => handleChange('clickupListIds', e.target.value)}
                        placeholder="e.g. 901234567890, 901234567891"
                        rows={3}
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none"
                      />
                      <p className="text-[10px] text-[var(--text-muted)] mt-1">
                        Comma-separated List IDs. If your token doesn't have permission to auto-discover lists, enter them manually here.
                      </p>
                    </div>

                    <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
                      <h4 className="text-xs font-semibold text-[var(--text-primary)] mb-2">Setup Instructions</h4>
                      <ol className="text-[11px] text-[var(--text-muted)] space-y-1 list-decimal list-inside">
                        <li>Go to ClickUp Settings → Apps</li>
                        <li>Generate a personal API token</li>
                        <li>Paste it in the API Token field above</li>
                        <li>Enter your Workspace ID (found in URL)</li>
                        <li>If your token can't auto-discover lists, enter List IDs manually above</li>
                        <li>Click "Test Connection" to verify</li>
                      </ol>
                    </div>
                  </>
                )}

                {/* Jira config */}
                {localSettings.taskManagerProvider === 'jira' && (
                  <>
                    <div>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Email</label>
                      <input
                        type="email"
                        value={localSettings.jiraEmail}
                        onChange={(e) => handleChange('jiraEmail', e.target.value)}
                        placeholder="you@company.com"
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>

                    <div>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">API Token</label>
                      <input
                        type="password"
                        value={localSettings.jiraApiToken}
                        onChange={(e) => handleChange('jiraApiToken', e.target.value)}
                        placeholder="Enter your Jira API token"
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>

                    <div>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Domain</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={localSettings.jiraDomain}
                          onChange={(e) => handleChange('jiraDomain', e.target.value)}
                          placeholder="mycompany"
                          className="flex-1 px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                        />
                        <span className="text-xs text-[var(--text-muted)]">.atlassian.net</span>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Project Key</label>
                      <input
                        type="text"
                        value={localSettings.jiraProjectKey}
                        onChange={(e) => handleChange('jiraProjectKey', e.target.value.toUpperCase())}
                        placeholder="PROJ"
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>

                    <div className="p-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
                      <h4 className="text-xs font-semibold text-[var(--text-primary)] mb-2">Setup Instructions</h4>
                      <ol className="text-[11px] text-[var(--text-muted)] space-y-1 list-decimal list-inside">
                        <li>Go to id.atlassian.com/manage-profile/security/api-tokens</li>
                        <li>Create a new API token</li>
                        <li>Enter your Atlassian email above</li>
                        <li>Paste the token in the API Token field</li>
                        <li>Enter your Jira domain (e.g. "mycompany")</li>
                        <li>Enter the project key (e.g. "PROJ")</li>
                        <li>Click "Test Connection" to verify</li>
                      </ol>
                    </div>
                  </>
                )}

                {/* Test connection button */}
                {localSettings.taskManagerProvider !== 'none' && (
                  <div>
                    <button
                      onClick={testConnection}
                      disabled={connectionStatus === 'checking'}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {connectionStatus === 'checking' ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : connectionStatus === 'connected' ? (
                        <CheckCircle className="w-4 h-4" />
                      ) : connectionStatus === 'error' ? (
                        <XCircle className="w-4 h-4" />
                      ) : null}
                      Test Connection
                    </button>
                    {connectionMessage && (
                      <p className={cn(
                        'text-xs mt-2',
                        connectionStatus === 'connected' ? 'text-[var(--success)]' : 'text-[var(--error)]'
                      )}>
                        {connectionMessage}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeSection === 'testing' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">QC Testing</h2>
              <p className="text-sm text-[var(--text-muted)]">
                Configure default URL and login credentials for QC Testing. These will be pre-filled when creating a new QC test.
              </p>

              <div className="space-y-4">
                {/* Default Target URL */}
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Default Target URL</label>
                  <input
                    type="url"
                    value={localSettings.qcTestingUrl || ''}
                    onChange={(e) => handleChange('qcTestingUrl', e.target.value)}
                    placeholder="https://your-app.example.com"
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <p className="text-[11px] text-[var(--text-muted)] mt-1">The URL that QC tests will navigate to by default.</p>
                </div>

                {/* Default Login Credentials */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-sm text-[var(--text-secondary)]">Default Login Credentials</label>
                    <button
                      onClick={() => {
                        const creds = [...(localSettings.qcTestingCredentials || []), { label: '', value: '' }];
                        handleChange('qcTestingCredentials', creds);
                      }}
                      className="flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                    >
                      <Plus className="w-3 h-3" /> Add Field
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] mb-2">These credentials will be pre-filled when creating a new QC test session.</p>

                  {(!localSettings.qcTestingCredentials || localSettings.qcTestingCredentials.length === 0) ? (
                    <div className="p-4 border border-dashed border-[var(--border)] rounded-lg text-center">
                      <p className="text-xs text-[var(--text-muted)]">No credentials configured.</p>
                      <button
                        onClick={() => {
                          handleChange('qcTestingCredentials', [
                            { label: 'Email', value: '' },
                            { label: 'Password', value: '' },
                          ]);
                        }}
                        className="text-xs text-[var(--accent)] hover:underline mt-1"
                      >
                        Add Email & Password template
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {localSettings.qcTestingCredentials.map((cred: QCCredential, i: number) => (
                        <div key={i} className="flex items-center gap-2">
                          <input
                            value={cred.label}
                            onChange={(e) => {
                              const updated = localSettings.qcTestingCredentials.map((c: QCCredential, idx: number) =>
                                idx === i ? { ...c, label: e.target.value } : c
                              );
                              handleChange('qcTestingCredentials', updated);
                            }}
                            placeholder="Label (e.g. Email)"
                            className="w-28 px-2 py-1.5 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                          />
                          <div className="flex-1 relative">
                            <input
                              type={visibleCredValues[i] ? 'text' : 'password'}
                              value={cred.value}
                              onChange={(e) => {
                                const updated = localSettings.qcTestingCredentials.map((c: QCCredential, idx: number) =>
                                  idx === i ? { ...c, value: e.target.value } : c
                                );
                                handleChange('qcTestingCredentials', updated);
                              }}
                              placeholder="Value"
                              className="w-full px-2 py-1.5 pr-8 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                            />
                            <button
                              onClick={() => setVisibleCredValues(prev => ({ ...prev, [i]: !prev[i] }))}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                            >
                              {visibleCredValues[i] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            </button>
                          </div>
                          <button
                            onClick={() => {
                              const updated = localSettings.qcTestingCredentials.filter((_: QCCredential, idx: number) => idx !== i);
                              handleChange('qcTestingCredentials', updated);
                            }}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10 transition-colors shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeSection === 'agent' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Agent Settings</h2>

              <div className="space-y-4">
                {/* Default Agent Provider — dynamic from registry */}
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Default Agent Provider</label>
                  <select
                    value={localSettings.defaultAgentProvider}
                    onChange={(e) => handleChange('defaultAgentProvider', e.target.value)}
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  >
                    {agentProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}{!p.available ? ' (not installed)' : ''}
                      </option>
                    ))}
                    {agentProviders.length === 0 && (
                      <>
                        <option value="claude">Claude Code</option>
                        <option value="copilot">GitHub Copilot</option>
                      </>
                    )}
                  </select>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">AI provider selected by default when creating new terminals</p>
                </div>

                {/* Per-agent model selector — known options + Custom for any future model ID */}
                {(() => {
                  const selectedProvider = agentProviders.find((p) => p.id === localSettings.defaultAgentProvider);
                  if (!selectedProvider || selectedProvider.models.length === 0) return null;
                  const agentModels = localSettings.agentModels || {};
                  const currentModel = agentModels[selectedProvider.id] || selectedProvider.defaultModel;
                  const CUSTOM = '__custom__';
                  const isCustom = !selectedProvider.models.some((m) => m.id === currentModel);
                  return (
                    <div>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">
                        Default Model ({selectedProvider.displayName})
                      </label>
                      <select
                        value={isCustom ? CUSTOM : currentModel}
                        onChange={(e) => {
                          const value = e.target.value === CUSTOM ? '' : e.target.value;
                          const updated = { ...localSettings.agentModels, [selectedProvider.id]: value };
                          handleChange('agentModels', updated);
                        }}
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                      >
                        {selectedProvider.models.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                        <option value={CUSTOM}>Custom…</option>
                      </select>
                      {isCustom && (
                        <input
                          type="text"
                          value={currentModel}
                          onChange={(e) => {
                            const updated = { ...localSettings.agentModels, [selectedProvider.id]: e.target.value };
                            handleChange('agentModels', updated);
                          }}
                          placeholder="e.g. claude-opus-4-8"
                          className="mt-2 w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
                        />
                      )}
                      <p className="text-[10px] text-[var(--text-muted)] mt-1">
                        Aliases (Opus / Sonnet / Haiku) always use the latest version. Use Custom… to type a specific model ID.
                      </p>
                    </div>
                  );
                })()}

                {/* Dynamic settings fields from the selected provider */}
                {(() => {
                  const selectedProvider = agentProviders.find((p) => p.id === localSettings.defaultAgentProvider);
                  if (!selectedProvider || selectedProvider.settingsFields.length === 0) return null;
                  const agentConfig = localSettings.agentConfig || {};
                  const providerConfig = agentConfig[selectedProvider.id] || {};
                  return selectedProvider.settingsFields.map((field) => (
                    <div key={field.key}>
                      <label className="block text-sm text-[var(--text-secondary)] mb-1.5">{field.label}</label>
                      <input
                        type={field.type === 'password' ? 'password' : 'text'}
                        value={providerConfig[field.key] || ''}
                        onChange={(e) => {
                          const updatedConfig = { ...providerConfig, [field.key]: e.target.value };
                          handleChange('agentConfig', { ...agentConfig, [selectedProvider.id]: updatedConfig });
                        }}
                        placeholder={field.placeholder}
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                      {field.description && (
                        <p className="text-[10px] text-[var(--text-muted)] mt-1">{field.description}</p>
                      )}
                    </div>
                  ));
                })()}

                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Working Directory</label>
                  <input
                    type="text"
                    value={localSettings.workingDirectory}
                    onChange={(e) => handleChange('workingDirectory', e.target.value)}
                    placeholder="Default working directory for terminals"
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>

                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Max Terminals</label>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    value={localSettings.maxTerminals}
                    onChange={(e) => handleChange('maxTerminals', parseInt(e.target.value))}
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">Maximum number of parallel terminals (1-12)</p>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'team' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Team Chat</h2>
              <p className="text-sm text-[var(--text-muted)]">
                Chat in real-time with teammates who have Agent Terminal open on the same GitHub project.
              </p>

              <div className="space-y-4">
                {/* Host Server */}
                <HostServerControl />

                {/* Relay Server URL */}
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Relay Server URL</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={localSettings.teamServerUrl}
                      onChange={(e) => handleChange('teamServerUrl', e.target.value)}
                      placeholder="ws://localhost:9877"
                      className="flex-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)]"
                    />
                    <TestConnectionButton url={localSettings.teamServerUrl} />
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    The URL teammates enter in Team Chat to join. If you are hosting, share your public IP URL with your team.
                  </p>
                </div>

                {/* Auto-start relay server */}
                <div className="flex items-center justify-between py-2">
                  <div>
                    <label className="block text-sm text-[var(--text-secondary)]">Auto-start Relay Server</label>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">Automatically start the relay server when opening the app</p>
                  </div>
                  <button
                    onClick={() => handleChange('teamAutoStartServer', !localSettings.teamAutoStartServer)}
                    className={cn(
                      'relative w-10 h-5 rounded-full transition-colors',
                      localSettings.teamAutoStartServer ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]',
                    )}
                  >
                    <span className={cn(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                      localSettings.teamAutoStartServer ? 'left-[22px]' : 'left-0.5',
                    )} />
                  </button>
                </div>

                {/* Auto-connect */}
                <div className="flex items-center justify-between py-2">
                  <div>
                    <label className="block text-sm text-[var(--text-secondary)]">Auto-connect</label>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">Automatically connect when opening a project</p>
                  </div>
                  <button
                    onClick={() => handleChange('teamAutoConnect', !localSettings.teamAutoConnect)}
                    className={cn(
                      'relative w-10 h-5 rounded-full transition-colors',
                      localSettings.teamAutoConnect ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)]',
                    )}
                  >
                    <span className={cn(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                      localSettings.teamAutoConnect ? 'left-[22px]' : 'left-0.5',
                    )} />
                  </button>
                </div>
              </div>

              <div className="bg-[var(--bg-tertiary)] rounded-lg p-4 text-xs text-[var(--text-muted)] space-y-2">
                <p className="font-medium text-[var(--text-secondary)]">How it works</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>Your GitHub identity is detected via <code className="text-[var(--accent)]">gh auth status</code></li>
                  <li>Your project is identified by its <code className="text-[var(--accent)]">git remote origin</code> URL</li>
                  <li>Teammates on the same repo are grouped into a shared chat room</li>
                  <li>One person clicks "Start Server" here (or enables Auto-start) — others just enter the URL and click "Join" in Team Chat</li>
                </ul>
              </div>
            </div>
          )}

          {activeSection === 'auto-code' && (
            <div className="space-y-6 max-w-xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">Auto Code Loop</h2>
                  <p className="text-sm text-[var(--text-muted)] mt-1">
                    Watches ClickUp tasks in the Failed status, reads QC feedback comments, dispatches a fix prompt in the task's worktree, pushes commits, and flips the task back for re-testing. Runs automatically in the background.
                  </p>
                </div>
                <div className={cn(
                  'shrink-0 mt-1 w-10 h-10 rounded-lg flex items-center justify-center',
                  localSettings.autoCodeEnabled ? 'bg-green-500/10' : 'bg-[var(--bg-tertiary)]',
                )}>
                  <Wrench className={cn('w-5 h-5', localSettings.autoCodeEnabled ? 'text-green-400' : 'text-[var(--text-muted)]')} />
                </div>
              </div>

              {/* Master toggle */}
              <div className="flex items-center justify-between p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
                <div>
                  <label className="text-sm font-medium text-[var(--text-primary)]">Enable Auto Code Loop</label>
                  <p className="text-[11px] text-[var(--text-muted)] mt-0.5">Master switch — nothing runs automatically when this is off.</p>
                </div>
                <button
                  onClick={() => handleChange('autoCodeEnabled', !localSettings.autoCodeEnabled)}
                  className={cn(
                    'relative w-10 h-5 rounded-full transition-colors shrink-0',
                    localSettings.autoCodeEnabled ? 'bg-green-500' : 'bg-[var(--border)]',
                  )}
                >
                  <div className={cn(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm',
                    localSettings.autoCodeEnabled ? 'translate-x-5' : 'translate-x-0.5',
                  )} />
                </button>
              </div>

              {/* Max iterations + poll interval */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Max Iterations</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={localSettings.autoCodeMaxIterations}
                    onChange={(e) => handleChange('autoCodeMaxIterations', Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <p className="text-[11px] text-[var(--text-muted)] mt-1">After this many fix attempts the task is escalated for manual review (you can re-queue it).</p>
                </div>
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Poll Interval</label>
                  <select
                    value={localSettings.autoCodePollIntervalMinutes}
                    onChange={(e) => handleChange('autoCodePollIntervalMinutes', parseInt(e.target.value, 10))}
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                  >
                    <option value={15}>Every 15 minutes</option>
                    <option value={30}>Every 30 minutes</option>
                    <option value={60}>Every 1 hour</option>
                    <option value={120}>Every 2 hours</option>
                    <option value={240}>Every 4 hours</option>
                  </select>
                </div>
              </div>

              {/* Start status — the IMPLEMENT trigger */}
              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Start Status <span className="text-[var(--text-muted)] font-normal">(implement trigger)</span></label>
                <input
                  type="text"
                  value={localSettings.autoCodeStartStatus}
                  onChange={(e) => handleChange('autoCodeStartStatus', e.target.value)}
                  placeholder="e.g. ready to code — leave blank to start as soon as a task is enabled"
                  className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                />
                <p className="text-[11px] text-[var(--text-muted)] mt-1">When an enabled task hits this ClickUp status, Auto Code implements it from the description. Comma-separate to match several statuses. Leave blank to begin the moment a task is enabled (no status gate).</p>
              </div>

              {/* In Progress status — flipped when coding starts */}
              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1.5">In Progress Status <span className="text-[var(--text-muted)] font-normal">(set when coding starts)</span></label>
                <input
                  type="text"
                  value={localSettings.autoCodeInProgressStatus}
                  onChange={(e) => handleChange('autoCodeInProgressStatus', e.target.value)}
                  placeholder="in progress"
                  className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                />
                <p className="text-[11px] text-[var(--text-muted)] mt-1">As soon as the agent starts working a task, ClickUp is flipped to this status so the board shows it's active (it then moves to the Re-Test status when the fix is pushed). First entry is written back. Leave blank to leave the status untouched while coding.</p>
              </div>

              {/* Status names */}
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Failed Status</label>
                  <input
                    type="text"
                    value={localSettings.autoCodeFailedStatus}
                    onChange={(e) => handleChange('autoCodeFailedStatus', e.target.value)}
                    placeholder="failed"
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <p className="text-[11px] text-[var(--text-muted)] mt-1">Triggers a QC fix. Comma-separate to match several statuses.</p>
                </div>
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Re-Test Status</label>
                  <input
                    type="text"
                    value={localSettings.autoCodeReviewStatus}
                    onChange={(e) => handleChange('autoCodeReviewStatus', e.target.value)}
                    placeholder="ready for review"
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <p className="text-[11px] text-[var(--text-muted)] mt-1">After a fix is pushed. First entry is written back.</p>
                </div>
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Done Status</label>
                  <input
                    type="text"
                    value={localSettings.autoCodeDoneStatus}
                    onChange={(e) => handleChange('autoCodeDoneStatus', e.target.value)}
                    placeholder="done"
                    className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                  <p className="text-[11px] text-[var(--text-muted)] mt-1">Triggers auto-merge. Comma-separate to match several statuses.</p>
                </div>
              </div>

              {/* Review Failed — the REVIEW-FIX trigger */}
              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Review Failed Status <span className="text-[var(--text-muted)] font-normal">(code-review fix trigger)</span></label>
                <input
                  type="text"
                  value={localSettings.autoCodeReviewFailedStatus}
                  onChange={(e) => handleChange('autoCodeReviewFailedStatus', e.target.value)}
                  placeholder="review failed"
                  className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                />
                <p className="text-[11px] text-[var(--text-muted)] mt-1">When a task hits this status (set by the Code Review loop on failure), Auto Code reads the review findings, fixes them on the PR branch, then flips the task back to the Code Review status so it re-reviews — repeating until it passes or hits Max Iterations. Comma-separate to match several statuses.</p>
              </div>

              {/* Quality & alerts toggles */}
              <div className="space-y-3">
                {([
                  {
                    key: 'autoCodeReviewGate' as const,
                    label: 'Second-agent review gate',
                    desc: 'Have a different agent review the fix diff before sending it to QC. Critical findings hold the task back for manual review.',
                  },
                  {
                    key: 'qcCaptureDiagnostics' as const,
                    label: 'Capture QC diagnostics',
                    desc: 'During QC runs, collect browser console errors and failed network requests and feed them into the next auto-code attempt.',
                  },
                  {
                    key: 'notificationsEnabled' as const,
                    label: 'Desktop notifications',
                    desc: 'Native OS alerts when a fix is pushed or escalated, QC fails, a PR auto-merges, or a review is rejected.',
                  },
                ]).map((t) => (
                  <div key={t.key} className="flex items-start justify-between gap-3">
                    <div>
                      <label className="text-sm text-[var(--text-secondary)]">{t.label}</label>
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{t.desc}</p>
                    </div>
                    <button
                      onClick={() => handleChange(t.key, !localSettings[t.key])}
                      className={cn(
                        'relative w-10 h-5 rounded-full transition-colors shrink-0 mt-0.5',
                        localSettings[t.key] ? 'bg-green-500' : 'bg-[var(--border)]',
                      )}
                    >
                      <div className={cn(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm',
                        localSettings[t.key] ? 'translate-x-5' : 'translate-x-0.5',
                      )} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Project path */}
              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1.5">
                  <FolderOpen className="w-3.5 h-3.5 inline-block mr-1 -mt-0.5" />
                  Project
                </label>
                <select
                  value={localSettings.autoCodeProjectPath || ''}
                  onChange={(e) => handleChange('autoCodeProjectPath', e.target.value)}
                  className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                >
                  <option value="">Select project…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.path}>{p.name}</option>
                  ))}
                </select>
                <p className="text-[11px] text-[var(--text-muted)] mt-1">Worktrees are created under <code className="text-[10px]">.task-worktrees/</code> inside this project. The <code className="text-[10px]">gh</code> CLI runs here.</p>
              </div>

              {/* Per-column status mapping */}
              <div>
                <label className="block text-sm font-medium text-[var(--text-primary)] mb-1">Kanban Column Mapping</label>
                <p className="text-[11px] text-[var(--text-muted)] mb-3">
                  Map ClickUp statuses (comma-separated, case-insensitive) to each Kanban column. When an imported task's ClickUp status changes, its card moves to the matching column. A status listed under multiple columns matches the topmost one. Unmatched statuses leave the card where it is, so manual drags are preserved.
                </p>
                <div className="space-y-3">
                  {([
                    { key: 'kanbanBacklogStatuses', label: 'To Do', color: '#94a3b8', placeholder: 'to do, open, backlog, planning, ready', note: "Also defines which ClickUp tasks appear in the board's Backlog column before import." },
                    { key: 'kanbanInProgressStatuses', label: 'In Progress', color: '#3b82f6', placeholder: 'in progress, in development, developing, working' },
                    { key: 'kanbanReviewStatuses', label: 'Review / QC', color: '#f59e0b', placeholder: 'review, in review, ready for review' },
                    { key: 'kanbanFailedStatuses', label: 'Failed', color: '#ef4444', placeholder: 'failed' },
                    { key: 'kanbanDoneStatuses', label: 'Done', color: '#22c55e', placeholder: 'done, complete, closed' },
                  ] as const).map((col) => (
                    <div key={col.key}>
                      <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] mb-1.5">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
                        {col.label}
                      </label>
                      <input
                        type="text"
                        value={localSettings[col.key]}
                        onChange={(e) => handleChange(col.key, e.target.value)}
                        placeholder={col.placeholder}
                        className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                      />
                      {'note' in col && col.note && (
                        <p className="text-[11px] text-[var(--text-muted)] mt-1">{col.note}</p>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-[var(--text-muted)] mt-3">
                  Note: the auto-code <span className="text-[var(--text-secondary)]">Failed</span>, <span className="text-[var(--text-secondary)]">Re-Test</span>, and <span className="text-[var(--text-secondary)]">Done</span> statuses above always map to their columns too, since the loop writes those back to ClickUp.
                </p>
              </div>

              {/* Snapshot refresh interval */}
              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1.5">ClickUp Snapshot Refresh</label>
                <select
                  value={localSettings.kanbanSnapshotIntervalMinutes}
                  onChange={(e) => handleChange('kanbanSnapshotIntervalMinutes', parseInt(e.target.value, 10))}
                  className="w-full px-3 py-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                >
                  <option value={0}>Disabled — manual refresh only</option>
                  <option value={1}>Every minute</option>
                  <option value={2}>Every 2 minutes</option>
                  <option value={5}>Every 5 minutes (default)</option>
                  <option value={10}>Every 10 minutes</option>
                  <option value={15}>Every 15 minutes</option>
                  <option value={30}>Every 30 minutes</option>
                </select>
                <p className="text-[11px] text-[var(--text-muted)] mt-1">How often the Kanban board pulls fresh ClickUp status for all imported tasks. Runs independently of the auto-code loop.</p>
              </div>

              {/* API request log — every outbound ClickUp call, with the failing
                  endpoint and ClickUp's own error text for anything that fails. */}
              <div className="flex items-center justify-between p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
                <div className="min-w-0 pr-3">
                  <label className="text-sm font-medium text-[var(--text-primary)]">API Request Log</label>
                  <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                    Every ClickUp request with its status, duration and remaining rate-limit budget. Failed requests include the exact endpoint and ClickUp's error message, so a bad query can be identified without reproducing it.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    const path = await window.electronAPI.getApiLogPath?.();
                    if (path) await window.electronAPI.openPath(path);
                  }}
                  className="shrink-0 px-3 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors"
                >
                  Open log
                </button>
              </div>

              {/* Auto-merge */}
              <div className="flex items-center justify-between p-4 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
                <div>
                  <label className="text-sm font-medium text-[var(--text-primary)]">Auto-Merge on QC Pass</label>
                  <p className="text-[11px] text-[var(--text-muted)] mt-0.5">Automatically squash-merge the PR via <code className="text-[10px]">gh pr merge --auto</code> once the task moves to Done. Off by default — keep a human in the loop for final merge.</p>
                </div>
                <button
                  onClick={() => handleChange('autoCodeAutoMerge', !localSettings.autoCodeAutoMerge)}
                  className={cn(
                    'relative w-10 h-5 rounded-full transition-colors shrink-0',
                    localSettings.autoCodeAutoMerge ? 'bg-green-500' : 'bg-[var(--border)]',
                  )}
                >
                  <div className={cn(
                    'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm',
                    localSettings.autoCodeAutoMerge ? 'translate-x-5' : 'translate-x-0.5',
                  )} />
                </button>
              </div>

              {/* Info box */}
              <div className="p-4 rounded-lg bg-blue-500/5 border border-blue-500/20">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                  <div className="text-[11px] text-[var(--text-secondary)] space-y-1">
                    <p><strong>How it works</strong> (per-task opt-in — enable Auto Code on a card):</p>
                    <ol className="list-decimal list-inside space-y-0.5">
                      <li><strong>Implement:</strong> when an enabled task reaches the Start Status{localSettings.autoCodeStartStatus ? <> (<code className="text-[10px]">{localSettings.autoCodeStartStatus}</code>)</> : ' (or immediately, if Start Status is blank)'}, the agent builds it from the task description in an isolated worktree.</li>
                      <li><strong>Fix:</strong> when a task is in the <code className="text-[10px]">{localSettings.autoCodeFailedStatus}</code> status, the agent addresses the QC failure comments (plus prior attempts, so retries don't repeat).</li>
                      <li><strong>Review Fix:</strong> when a task is in the <code className="text-[10px]">{localSettings.autoCodeReviewFailedStatus}</code> status, the agent reads the AI Code Review findings, fixes them on the PR branch, and flips the task back to <code className="text-[10px]">{(localSettings.codeReviewStatuses || '').split(',')[0].trim() || localSettings.autoCodeReviewStatus}</code> so Code Review re-runs — looping until it passes (the <code className="text-[10px]">{localSettings.codeReviewTagName}</code> tag) or hits the cap.</li>
                      {localSettings.autoCodeInProgressStatus ? <li>While the agent is working, the task is flipped to <code className="text-[10px]">{localSettings.autoCodeInProgressStatus}</code> so the board shows it's active.</li> : null}
                      <li>After pushing + opening a PR, the task flips to <code className="text-[10px]">{localSettings.autoCodeReviewStatus}</code> for review/QC.</li>
                      <li>QC marks it <code className="text-[10px]">{localSettings.autoCodeFailedStatus}</code> → it iterates, or <code className="text-[10px]">{localSettings.autoCodeDoneStatus}</code> → it auto-merges (if enabled).</li>
                      <li>Hitting the iteration cap escalates the task — find it on the Kanban Board and click re-queue once the blocker is cleared.</li>
                    </ol>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'appearance' && (
            <div className="space-y-6 max-w-xl">
              <h2 className="text-lg font-semibold text-[var(--text-primary)]">Appearance</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Theme</label>
                  <div className="flex gap-3">
                    {(['dark', 'light'] as const).map((theme) => (
                      <button
                        key={theme}
                        onClick={() => handleChange('theme', theme)}
                        className={cn(
                          'flex-1 p-3 rounded-lg border-2 transition-colors capitalize text-sm',
                          localSettings.theme === theme
                            ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                            : 'border-[var(--border)] hover:border-[var(--text-muted)]'
                        )}
                      >
                        {theme}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HostServerControl() {
  const { hosting, startServer, stopServer } = useTeamStore();
  const [starting, setStarting] = useState(false);

  const handleToggle = async () => {
    if (hosting) {
      await stopServer();
    } else {
      setStarting(true);
      await startServer();
      setStarting(false);
    }
  };

  return (
    <div className={cn(
      'flex items-center justify-between p-3 rounded-lg border',
      hosting ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-[var(--bg-tertiary)] border-[var(--border)]',
    )}>
      <div className="flex items-center gap-3">
        <div className={cn(
          'w-9 h-9 rounded-lg flex items-center justify-center',
          hosting ? 'bg-emerald-500/20' : 'bg-[var(--bg-primary)]',
        )}>
          <Server className={cn('w-4.5 h-4.5', hosting ? 'text-emerald-400' : 'text-[var(--text-muted)]')} />
        </div>
        <div>
          <p className="text-sm text-[var(--text-primary)] font-medium">
            {hosting ? 'Server Running' : 'Relay Server'}
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            {hosting ? 'Listening on port 9877 — teammates can connect' : 'Start a relay server on this machine for your team'}
          </p>
        </div>
      </div>
      <button
        onClick={handleToggle}
        disabled={starting}
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
          hosting
            ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
            : 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30',
          starting && 'opacity-60',
        )}
      >
        {starting ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting...</>
        ) : hosting ? (
          <><Square className="w-3 h-3" /> Stop</>
        ) : (
          <><Server className="w-3.5 h-3.5" /> Start Server</>
        )}
      </button>
    </div>
  );
}

function TestConnectionButton({ url }: { url: string }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleTest = async () => {
    if (!url) {
      setStatus('error');
      setMessage('Enter a URL first');
      return;
    }
    setStatus('testing');
    setMessage('');

    try {
      const result = await window.electronAPI.teamTestConnection(url);
      if (result.success) {
        setStatus('success');
        setMessage('Connected successfully');
      } else {
        setStatus('error');
        setMessage(result.error || 'Connection failed');
      }
    } catch {
      setStatus('error');
      setMessage('Connection test failed');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleTest}
        disabled={status === 'testing'}
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 rounded-md text-sm transition-colors whitespace-nowrap',
          status === 'success' ? 'bg-emerald-500/20 text-emerald-400'
            : status === 'error' ? 'bg-red-500/20 text-red-400'
            : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--border)]',
          status === 'testing' && 'opacity-60',
        )}
      >
        {status === 'testing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : status === 'success' ? <CheckCircle className="w-3.5 h-3.5" />
          : status === 'error' ? <XCircle className="w-3.5 h-3.5" />
          : <Wifi className="w-3.5 h-3.5" />}
        Test
      </button>
      {message && (
        <span className={cn('text-xs', status === 'success' ? 'text-emerald-400' : 'text-red-400')}>
          {message}
        </span>
      )}
    </div>
  );
}
