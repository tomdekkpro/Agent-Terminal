import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, PanelLeftClose, PanelLeftOpen, FolderOpen, ChevronDown, AlertCircle, X, Plus } from 'lucide-react';
import { useQCStore } from '../../stores/qc-store';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import { QCTestPanel } from '../insights/QCTestPanel';
import { ModelSelector } from '../insights/ModelSelector';
import { QCSidebar } from './QCSidebar';
import { UsageIndicator } from '../usage/UsageIndicator';
import { SystemMonitor } from '../status/SystemMonitor';
import { ServiceStatusIndicator } from '../status/ServiceStatusIndicator';
import type { AgentProviderId, AgentProviderMeta, InsightsModel } from '../../../shared/types';
import { cn } from '../../../shared/utils';

export function QCView() {
  const store = useQCStore();
  const {
    sessions, activeSession, sidebarOpen, error, selectedProjectPath,
    selectedProvider, searchQuery,
    loadSessions, selectSession, createQCSession, deleteSession,
    renameSession, toggleSidebar, clearError,
    setSelectedProjectPath, setSelectedProvider, setSearchQuery,
    togglePin, updateQCTask,
  } = store;

  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const settingsProvider = useSettingsStore((s) => s.settings.defaultAgentProvider) || 'claude';
  const settingsAgentModels = useSettingsStore((s) => s.settings.agentModels) || {};

  const [selectedModel, setSelectedModel] = useState('');
  const [agentProviders, setAgentProviders] = useState<AgentProviderMeta[]>([]);

  // Load providers on mount
  useEffect(() => {
    window.electronAPI.getAgentProviders?.()
      .then((result: any) => {
        if (result.success && result.data) setAgentProviders(result.data);
      })
      .catch(() => {});
  }, []);

  const currentProviderMeta = agentProviders.find((p) => p.id === selectedProvider);
  const currentModels = currentProviderMeta?.models || [];

  useEffect(() => {
    if (!currentProviderMeta) return;
    const savedModel = settingsAgentModels[currentProviderMeta.id];
    if (savedModel && currentModels.some((m) => m.id === savedModel)) {
      setSelectedModel(savedModel);
    } else {
      setSelectedModel(currentProviderMeta.defaultModel);
    }
  }, [selectedProvider, currentProviderMeta, currentModels, settingsAgentModels]);

  useEffect(() => {
    if (selectedProjectPath === null && activeProjectId) {
      const proj = projects.find((p) => p.id === activeProjectId);
      if (proj) setSelectedProjectPath(proj.path);
    }
  }, [activeProjectId, projects, selectedProjectPath, setSelectedProjectPath]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Sync provider from active session
  useEffect(() => {
    if (activeSession?.provider) {
      setSelectedProvider(activeSession.provider);
    } else if (!activeSession) {
      setSelectedProvider(settingsProvider as AgentProviderId);
    }
  }, [activeSession, settingsProvider, setSelectedProvider]);

  const getModelParams = useCallback(() => {
    const currentProvider = useQCStore.getState().selectedProvider;
    const isClaudeProvider = currentProvider === 'claude';
    const insightsModel: InsightsModel = isClaudeProvider ? (selectedModel as InsightsModel) || 'sonnet' : 'sonnet';
    const agentModel = !isClaudeProvider ? selectedModel : undefined;
    return { insightsModel, agentModel };
  }, [selectedModel]);

  const handleNewQCSession = useCallback(async () => {
    const { insightsModel, agentModel } = getModelParams();
    await createQCSession(insightsModel, selectedProjectPath ?? undefined, useQCStore.getState().selectedProvider, agentModel);
  }, [createQCSession, selectedProjectPath, getModelParams]);

  const handleProviderChange = (provider: AgentProviderId) => {
    setSelectedProvider(provider);
  };

  return (
    <div className="flex h-full relative">
      {/* QC Sidebar */}
      {sidebarOpen && (
        <QCSidebar
          sessions={sessions}
          activeSessionId={activeSession?.id ?? null}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelect={selectSession}
          onNew={handleNewQCSession}
          onDelete={deleteSession}
          onRename={renameSession}
          onTogglePin={togglePin}
        />
      )}

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
          <button onClick={toggleSidebar} className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors" title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
            {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>

          <ShieldCheck className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-medium text-[var(--text-primary)]">{activeSession?.title || 'QC Testing'}</span>

          {/* Project picker */}
          <div className="relative">
            <select value={selectedProjectPath ?? ''} onChange={(e) => setSelectedProjectPath(e.target.value || null)} className="appearance-none text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border)] rounded-md pl-6 pr-5 py-1 outline-none focus:border-[var(--accent)] cursor-pointer max-w-[180px] truncate">
              <option value="">No project</option>
              {projects.map((p) => (<option key={p.id} value={p.path}>{p.name}</option>))}
            </select>
            <FolderOpen className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <ChevronDown className="w-3 h-3 absolute right-1 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* New QC Test button */}
            <button
              onClick={handleNewQCSession}
              className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-2.5 py-1 rounded-md transition-colors"
            >
              <Plus className="w-3 h-3" /> New Test
            </button>

            <select value={selectedProvider} onChange={(e) => handleProviderChange(e.target.value as AgentProviderId)} className="text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border)] rounded-md px-2 py-1 outline-none focus:border-[var(--accent)] cursor-pointer">
              {agentProviders.length > 0 ? agentProviders.map((p) => (<option key={p.id} value={p.id}>{p.displayName}{!p.available ? ' (N/A)' : ''}</option>)) : (<><option value="claude">Claude Code</option><option value="copilot">GitHub Copilot</option></>)}
            </select>
            <ModelSelector models={currentModels} value={selectedModel} onChange={setSelectedModel} disabled={false} />
            <SystemMonitor />
            <ServiceStatusIndicator />
            <UsageIndicator />
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-2 bg-[var(--error)]/10 border-b border-[var(--error)]/20">
            <AlertCircle className="w-4 h-4 text-[var(--error)] shrink-0" />
            <span className="text-xs text-[var(--error)] flex-1">{error}</span>
            <button onClick={clearError} className="text-[var(--error)] hover:text-[var(--error)]/80"><X className="w-3 h-3" /></button>
          </div>
        )}

        {/* QC Test Panel or empty state */}
        {activeSession ? (
          <QCTestPanel
            sessionId={activeSession.id}
            qcTask={activeSession.qcTask}
            model={selectedModel || 'sonnet'}
            onTaskUpdate={updateQCTask}
            onNewTask={handleNewQCSession}
            onRenameSession={(title) => renameSession(activeSession.id, title)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-4 px-4">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 flex items-center justify-center">
              <ShieldCheck className="w-8 h-8 text-amber-400" />
            </div>
            <h2 className="text-lg font-medium text-[var(--text-primary)]">QC Testing</h2>
            <p className="text-sm text-[var(--text-muted)] text-center max-w-md">
              Create automated QC tests for your web application. Generate test cases from a URL and run them with AI-powered browser automation.
            </p>
            <button
              onClick={handleNewQCSession}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-lg transition-colors',
                'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30',
              )}
            >
              <Plus className="w-4 h-4" />
              New QC Test
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
