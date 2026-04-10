import { useState, useEffect, useCallback } from 'react';
import { X, Save, FolderOpen, Bot, Zap, Plus, Trash2, ChevronDown, Server, Search } from 'lucide-react';
import type { Project, ProjectSkill, AgentProviderMeta, AgentProviderId, DevServerConfig, DetectResult } from '../../../shared/types';
import { useProjectStore } from '../../stores/project-store';
import { cn } from '../../../shared/utils';
import { v4 as uuid } from 'uuid';

const SKILL_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#f97316', '#ec4899'];

const SKILL_ICONS = [
  'Zap', 'Code', 'Bug', 'TestTube', 'Rocket', 'Shield', 'FileText', 'RefreshCw',
  'Search', 'GitBranch', 'Database', 'Terminal', 'Sparkles', 'Wrench', 'Eye', 'Layers',
];

interface ProjectSettingsModalProps {
  project: Project;
  agentProviders: AgentProviderMeta[];
  onClose: () => void;
}

type Tab = 'general' | 'agent' | 'skills' | 'devserver';

export function ProjectSettingsModal({ project, agentProviders, onClose }: ProjectSettingsModalProps) {
  const updateProject = useProjectStore((s) => s.updateProject);
  const [activeTab, setActiveTab] = useState<Tab>('general');

  // Local state for editing
  const [name, setName] = useState(project.name);
  const [agentProvider, setAgentProvider] = useState<AgentProviderId | ''>(project.agentProvider || '');
  const [agentModel, setAgentModel] = useState(project.agentModel || '');
  const [agentConfig, setAgentConfig] = useState<Record<string, string>>(project.agentConfig || {});
  const [skills, setSkills] = useState<ProjectSkill[]>(project.skills || []);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState<Partial<ProjectSkill>>({});
  const [devServer, setDevServer] = useState<DevServerConfig>(project.devServer || {
    frontendCmd: '', frontendCwd: '', backendCmd: '', backendCwd: '', backendProfile: undefined,
  });
  const [docsPath, setDocsPath] = useState(project.docsPath || '');
  const [hasChanges, setHasChanges] = useState(false);
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [detecting, setDetecting] = useState(false);

  // Auto-detect dev servers when tab opens and fields are empty
  useEffect(() => {
    if (activeTab !== 'devserver') return;
    if (devServer.frontendCmd || devServer.backendCmd) return; // already configured
    if (detected || detecting) return;
    setDetecting(true);
    window.electronAPI.detectDevServers?.(project.path)
      .then((result: any) => {
        if (result?.success && result.data) {
          const d: DetectResult = result.data;
          setDetected(d);
          // Auto-fill with best candidates
          const bestFe = d.frontend[0];
          const bestBe = d.backend[0];
          if (bestFe || bestBe) {
            setDevServer((prev) => ({
              frontendCmd: bestFe?.cmd || prev.frontendCmd,
              frontendCwd: bestFe?.cwd || prev.frontendCwd,
              backendCmd: bestBe?.cmd || prev.backendCmd,
              backendCwd: bestBe?.cwd || prev.backendCwd,
              backendProfile: bestBe?.profiles?.[0]?.name || prev.backendProfile,
            }));
          }
        }
      })
      .catch(() => {})
      .finally(() => setDetecting(false));
  }, [activeTab]);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    try {
      const result = await window.electronAPI.detectDevServers?.(project.path);
      if (result?.success && result.data) {
        setDetected(result.data);
      }
    } catch { /* ignore */ }
    setDetecting(false);
  }, [project.path]);

  // Track changes
  useEffect(() => {
    const changed =
      name !== project.name ||
      (agentProvider || undefined) !== (project.agentProvider || undefined) ||
      (agentModel || undefined) !== (project.agentModel || undefined) ||
      JSON.stringify(agentConfig) !== JSON.stringify(project.agentConfig || {}) ||
      JSON.stringify(skills) !== JSON.stringify(project.skills || []) ||
      JSON.stringify(devServer) !== JSON.stringify(project.devServer || { frontendCmd: '', frontendCwd: '', backendCmd: '', backendCwd: '' }) ||
      (docsPath || undefined) !== (project.docsPath || undefined);
    setHasChanges(changed);
  }, [name, agentProvider, agentModel, agentConfig, skills, devServer, docsPath, project]);

  const handleSave = useCallback(async () => {
    // Only persist devServer if at least one command is set
    const hasDevServer = devServer.frontendCmd || devServer.backendCmd;
    await updateProject(project.id, {
      name: name || project.name,
      agentProvider: agentProvider || undefined,
      agentModel: agentModel || undefined,
      agentConfig: Object.keys(agentConfig).length > 0 ? agentConfig : undefined,
      skills: skills.length > 0 ? skills : undefined,
      devServer: hasDevServer ? devServer : undefined,
      docsPath: docsPath || undefined,
    });
    onClose();
  }, [updateProject, project.id, name, agentProvider, agentModel, agentConfig, skills, devServer, docsPath, onClose]);

  // Get models for selected provider
  const selectedProvider = agentProviders.find((p) => p.id === agentProvider);
  const availableModels = selectedProvider?.models || [];

  // Get settings fields for selected provider
  const settingsFields = selectedProvider?.settingsFields || [];

  // Skill editing
  const startNewSkill = () => {
    const id = uuid();
    setEditingSkillId(id);
    setSkillDraft({
      id,
      name: '',
      description: '',
      prompt: '',
      icon: 'Zap',
      color: SKILL_COLORS[skills.length % SKILL_COLORS.length],
    });
  };

  const startEditSkill = (skill: ProjectSkill) => {
    setEditingSkillId(skill.id);
    setSkillDraft({ ...skill });
  };

  const saveSkill = () => {
    if (!skillDraft.name || !skillDraft.prompt) return;
    const skill = skillDraft as ProjectSkill;
    setSkills((prev) => {
      const idx = prev.findIndex((s) => s.id === skill.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = skill;
        return updated;
      }
      return [...prev, skill];
    });
    setEditingSkillId(null);
    setSkillDraft({});
  };

  const deleteSkill = (id: string) => {
    setSkills((prev) => prev.filter((s) => s.id !== id));
    if (editingSkillId === id) {
      setEditingSkillId(null);
      setSkillDraft({});
    }
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <FolderOpen className="w-3.5 h-3.5" /> },
    { id: 'agent', label: 'Agent', icon: <Bot className="w-3.5 h-3.5" /> },
    { id: 'skills', label: 'Skills', icon: <Zap className="w-3.5 h-3.5" /> },
    { id: 'devserver', label: 'Dev Servers', icon: <Server className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Project Settings</h2>
            <span className="text-xs text-[var(--text-muted)]">{project.name}</span>
          </div>
          <button onClick={onClose} className="w-6 h-6 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-3 border-b border-[var(--border)]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs rounded-t-md transition-colors -mb-px border-b-2',
                activeTab === tab.id
                  ? 'text-[var(--accent)] border-[var(--accent)] bg-[var(--bg-secondary)]'
                  : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text-primary)]',
              )}
            >
              {tab.icon}
              {tab.label}
              {tab.id === 'skills' && skills.length > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded-full bg-[var(--accent)]/20 text-[var(--accent)]">
                  {skills.length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'general' && (
            <div className="space-y-4">
              <div>
                <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Project Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div>
                <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Path</label>
                <div className="mt-1 text-sm text-[var(--text-secondary)] bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2 select-all">
                  {project.path}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Documents Path</label>
                <div className="flex gap-2 mt-1">
                  <input
                    value={docsPath}
                    onChange={(e) => setDocsPath(e.target.value)}
                    placeholder="D:\DpProject\dekkpro-docs"
                    className="flex-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={async () => {
                      const result = await window.electronAPI.selectProjectFolder();
                      if (result?.success && result.data?.path) setDocsPath(result.data.path);
                    }}
                    className="px-3 py-2 rounded-md bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                    title="Browse for folder"
                  >
                    <FolderOpen className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mt-1">Reference docs and business files available in the Files panel</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Created</label>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    {new Date(project.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Updated</label>
                  <div className="mt-1 text-xs text-[var(--text-muted)]">
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'agent' && (
            <div className="space-y-4">
              <p className="text-xs text-[var(--text-muted)]">
                Override the default agent settings for this project. Leave empty to use app-wide defaults.
              </p>

              <div>
                <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Agent Provider</label>
                <div className="relative mt-1">
                  <select
                    value={agentProvider}
                    onChange={(e) => {
                      setAgentProvider(e.target.value as AgentProviderId | '');
                      setAgentModel('');
                      setAgentConfig({});
                    }}
                    className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] appearance-none"
                  >
                    <option value="">Use Default</option>
                    {agentProviders.filter((p) => p.available).map((p) => (
                      <option key={p.id} value={p.id}>{p.displayName}</option>
                    ))}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                </div>
              </div>

              {agentProvider && availableModels.length > 0 && (
                <div>
                  <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Model</label>
                  <div className="relative mt-1">
                    <select
                      value={agentModel}
                      onChange={(e) => setAgentModel(e.target.value)}
                      className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] appearance-none"
                    >
                      <option value="">Use Default</option>
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                  </div>
                </div>
              )}

              {agentProvider && settingsFields.length > 0 && (
                <div className="space-y-3 pt-2 border-t border-[var(--border)]">
                  <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Provider Settings</span>
                  {settingsFields.map((field) => (
                    <div key={field.key}>
                      <label className="text-xs text-[var(--text-secondary)]">{field.label}</label>
                      {field.type === 'select' ? (
                        <div className="relative mt-1">
                          <select
                            value={agentConfig[field.key] || ''}
                            onChange={(e) => setAgentConfig({ ...agentConfig, [field.key]: e.target.value })}
                            className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] appearance-none"
                          >
                            <option value="">Default</option>
                            {field.options?.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                          <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                        </div>
                      ) : (
                        <input
                          type={field.type === 'password' ? 'password' : 'text'}
                          value={agentConfig[field.key] || ''}
                          onChange={(e) => setAgentConfig({ ...agentConfig, [field.key]: e.target.value })}
                          placeholder={field.placeholder || `Use app default`}
                          className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)]"
                        />
                      )}
                      {field.description && (
                        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{field.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-[var(--text-muted)]">
                  Reusable prompt templates for quick agent invocation.
                </p>
                <button
                  onClick={startNewSkill}
                  className="flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] px-2 py-1 rounded hover:bg-[var(--accent)]/10"
                >
                  <Plus className="w-3 h-3" /> Add Skill
                </button>
              </div>

              {/* Skill editor */}
              {editingSkillId && (
                <div className="border border-[var(--accent)]/30 rounded-lg p-4 bg-[var(--bg-secondary)] space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Name</label>
                      <input
                        value={skillDraft.name || ''}
                        onChange={(e) => setSkillDraft({ ...skillDraft, name: e.target.value })}
                        placeholder="e.g. Code Review"
                        className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Description</label>
                      <input
                        value={skillDraft.description || ''}
                        onChange={(e) => setSkillDraft({ ...skillDraft, description: e.target.value })}
                        placeholder="Brief description"
                        className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Prompt</label>
                    <textarea
                      value={skillDraft.prompt || ''}
                      onChange={(e) => setSkillDraft({ ...skillDraft, prompt: e.target.value })}
                      placeholder="The instruction that will be sent to the agent..."
                      rows={4}
                      className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-none font-mono"
                    />
                  </div>

                  <div className="flex items-center gap-4">
                    <div>
                      <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Agent Override</label>
                      <div className="relative mt-1">
                        <select
                          value={skillDraft.agentProvider || ''}
                          onChange={(e) => setSkillDraft({ ...skillDraft, agentProvider: e.target.value as AgentProviderId || undefined })}
                          className="text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-2.5 py-1.5 outline-none focus:border-[var(--accent)] appearance-none pr-7"
                        >
                          <option value="">Use Project Default</option>
                          {agentProviders.filter((p) => p.available).map((p) => (
                            <option key={p.id} value={p.id}>{p.displayName}</option>
                          ))}
                        </select>
                        <ChevronDown className="w-3 h-3 absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                      </div>
                    </div>

                    <div>
                      <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Color</label>
                      <div className="flex gap-1.5 mt-1">
                        {SKILL_COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => setSkillDraft({ ...skillDraft, color: c })}
                            className={cn(
                              'w-5 h-5 rounded-full border-2 transition-transform',
                              skillDraft.color === c ? 'border-white scale-110' : 'border-transparent',
                            )}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Icon</label>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {SKILL_ICONS.map((iconName) => (
                        <button
                          key={iconName}
                          onClick={() => setSkillDraft({ ...skillDraft, icon: iconName })}
                          className={cn(
                            'w-7 h-7 rounded flex items-center justify-center text-xs transition-colors',
                            skillDraft.icon === iconName
                              ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]',
                          )}
                          title={iconName}
                        >
                          <SkillIcon name={iconName} className="w-3.5 h-3.5" />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      onClick={() => { setEditingSkillId(null); setSkillDraft({}); }}
                      className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-3 py-1.5 rounded hover:bg-[var(--bg-tertiary)]"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveSkill}
                      disabled={!skillDraft.name || !skillDraft.prompt}
                      className="flex items-center gap-1 text-xs text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] px-3 py-1.5 rounded disabled:opacity-50"
                    >
                      <Save className="w-3 h-3" /> Save Skill
                    </button>
                  </div>
                </div>
              )}

              {/* Skills list */}
              {skills.length === 0 && !editingSkillId && (
                <div className="text-center py-8 text-xs text-[var(--text-muted)]">
                  No skills yet. Add a skill to create reusable agent prompts.
                </div>
              )}

              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className={cn(
                    'flex items-start gap-3 px-3 py-2.5 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors cursor-pointer group',
                    editingSkillId === skill.id && 'ring-1 ring-[var(--accent)]',
                  )}
                  onClick={() => editingSkillId !== skill.id && startEditSkill(skill)}
                >
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                    style={{ backgroundColor: `${skill.color || '#6366f1'}20`, color: skill.color || '#6366f1' }}
                  >
                    <SkillIcon name={skill.icon || 'Zap'} className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)]">{skill.name}</span>
                      {skill.agentProvider && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                          {agentProviders.find((p) => p.id === skill.agentProvider)?.displayName || skill.agentProvider}
                        </span>
                      )}
                    </div>
                    {skill.description && (
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{skill.description}</p>
                    )}
                    <p className="text-[11px] text-[var(--text-muted)] truncate mt-0.5 font-mono">{skill.prompt}</p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteSkill(skill.id); }}
                    className="w-6 h-6 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error)]/10 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                    title="Delete"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'devserver' && (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <p className="text-xs text-[var(--text-muted)]">
                  Configure commands to start your frontend and backend dev servers.
                </p>
                <button
                  onClick={handleDetect}
                  disabled={detecting}
                  className="flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)] px-2 py-1 rounded hover:bg-[var(--accent)]/10 disabled:opacity-50"
                >
                  <Search className={cn('w-3 h-3', detecting && 'animate-spin')} />
                  {detecting ? 'Scanning...' : 'Auto Detect'}
                </button>
              </div>

              {/* Frontend */}
              <div className="space-y-3 p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#22c55e]" />
                  <span className="text-xs font-medium text-[var(--text-primary)]">Frontend</span>
                  {detected && detected.frontend.length > 0 && (
                    <span className="text-[10px] text-[var(--text-muted)]">({detected.frontend.length} detected)</span>
                  )}
                </div>
                {detected && detected.frontend.length > 1 && (
                  <div>
                    <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Detected Projects</label>
                    <div className="relative mt-1">
                      <select
                        value={devServer.frontendCwd}
                        onChange={(e) => {
                          const sel = detected.frontend.find((f) => f.cwd === e.target.value);
                          if (sel) setDevServer({ ...devServer, frontendCmd: sel.cmd, frontendCwd: sel.cwd });
                        }}
                        className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] appearance-none"
                      >
                        {detected.frontend.map((f) => (
                          <option key={f.cwd} value={f.cwd}>{f.label} — {f.cmd}</option>
                        ))}
                      </select>
                      <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                    </div>
                  </div>
                )}
                <div>
                  <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Command</label>
                  <input
                    value={devServer.frontendCmd}
                    onChange={(e) => setDevServer({ ...devServer, frontendCmd: e.target.value })}
                    placeholder="e.g. ng serve, npm start, npm run dev"
                    className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Working Directory</label>
                  <input
                    value={devServer.frontendCwd}
                    onChange={(e) => setDevServer({ ...devServer, frontendCwd: e.target.value })}
                    placeholder="Relative path (leave empty for project root)"
                    className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] font-mono"
                  />
                </div>
              </div>

              {/* Backend */}
              <div className="space-y-3 p-4 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#6366f1]" />
                  <span className="text-xs font-medium text-[var(--text-primary)]">Backend</span>
                  {detected && detected.backend.length > 0 && (
                    <span className="text-[10px] text-[var(--text-muted)]">({detected.backend.length} detected)</span>
                  )}
                </div>
                {detected && detected.backend.length > 1 && (
                  <div>
                    <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Detected Projects</label>
                    <div className="relative mt-1">
                      <select
                        value={devServer.backendCwd}
                        onChange={(e) => {
                          const sel = detected.backend.find((b) => b.cwd === e.target.value);
                          if (sel) setDevServer({ ...devServer, backendCmd: sel.cmd, backendCwd: sel.cwd, backendProfile: sel.profiles?.[0]?.name });
                        }}
                        className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] appearance-none"
                      >
                        {detected.backend.map((b) => (
                          <option key={b.cwd} value={b.cwd}>{b.label} — {b.cwd}</option>
                        ))}
                      </select>
                      <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                    </div>
                  </div>
                )}
                {/* Launch Profile — show when detected project has profiles */}
                {(() => {
                  const selectedBackend = detected?.backend.find((b) => b.cwd === devServer.backendCwd);
                  const profiles = selectedBackend?.profiles;
                  if (!profiles || profiles.length === 0) return null;
                  return (
                    <div>
                      <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Launch Profile</label>
                      <div className="relative mt-1">
                        <select
                          value={devServer.backendProfile || ''}
                          onChange={(e) => setDevServer({ ...devServer, backendProfile: e.target.value || undefined })}
                          className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] appearance-none"
                        >
                          <option value="">Default (no profile)</option>
                          {profiles.map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name}{p.environment !== 'Development' ? ` — ${p.environment}` : ''}{p.applicationUrl ? ` (${p.applicationUrl.split(';')[0]})` : ''}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                      </div>
                    </div>
                  );
                })()}
                <div>
                  <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Command</label>
                  <input
                    value={devServer.backendCmd}
                    onChange={(e) => setDevServer({ ...devServer, backendCmd: e.target.value })}
                    placeholder="e.g. dotnet run, dotnet watch run"
                    className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Working Directory</label>
                  <input
                    value={devServer.backendCwd}
                    onChange={(e) => setDevServer({ ...devServer, backendCwd: e.target.value })}
                    placeholder="Relative path (leave empty for project root)"
                    className="w-full mt-1 text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] font-mono"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-4 py-2 rounded-md hover:bg-[var(--bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges}
            className="flex items-center gap-1.5 text-xs text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] px-4 py-2 rounded-md disabled:opacity-40 transition-colors"
          >
            <Save className="w-3.5 h-3.5" /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// Dynamic icon component for skills
import * as LucideIcons from 'lucide-react';

function SkillIcon({ name, className }: { name: string; className?: string }) {
  const Icon = (LucideIcons as any)[name] || LucideIcons.Zap;
  return <Icon className={className} />;
}

export { SkillIcon, SKILL_ICONS, SKILL_COLORS };
