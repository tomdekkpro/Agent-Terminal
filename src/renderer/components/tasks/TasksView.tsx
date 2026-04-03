import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search, Terminal, Bot, Trash2, Clock, Play,
  LayoutList, FolderOpen, Plus, Filter, History,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminal-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useProjectStore } from '../../stores/project-store';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { PastSessionsList } from './PastSessionsList';
import { cn } from '../../../shared/utils';
import type { TerminalStatus } from '../../stores/terminal-store';
import type { AgentProviderMeta, AgentProviderId } from '../../../shared/types';

type SessionTab = 'active' | 'past';

type StatusFilter = 'all' | TerminalStatus;

interface TasksViewProps {
  onNavigateToTerminal?: () => void;
}

const STATUS_CONFIG: Record<TerminalStatus, { label: string; color: string; dot: string }> = {
  'idle': { label: 'Idle', color: 'text-gray-400', dot: 'bg-gray-400' },
  'running': { label: 'Running', color: 'text-blue-400', dot: 'bg-blue-400' },
  'claude-active': { label: 'Agent', color: 'text-emerald-400', dot: 'bg-emerald-400' },
  'exited': { label: 'Exited', color: 'text-red-400', dot: 'bg-red-400' },
};

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function TasksView({ onNavigateToTerminal }: TasksViewProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const projects = useProjectStore((s) => s.projects);
  const activeProject = useProjectStore((s) => {
    const id = s.activeProjectId;
    return id ? s.projects.find((p) => p.id === id) : undefined;
  });
  const settings = useSettingsStore((s) => s.settings);

  const [sessionTab, setSessionTab] = useState<SessionTab>('active');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);

  // Agent providers
  const [agentProviders, setAgentProviders] = useState<AgentProviderMeta[]>([]);
  useEffect(() => {
    window.electronAPI.getAgentProviders?.()
      .then((result: any) => {
        if (result.success && result.data) setAgentProviders(result.data);
      })
      .catch(() => {});
  }, []);

  const projectMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name);
    return map;
  }, [projects]);

  // Filter and sort terminals
  const filteredTerminals = useMemo(() => {
    let list = [...terminals];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.cwd.toLowerCase().includes(q) ||
          (t.task?.name || '').toLowerCase().includes(q) ||
          (t.projectId && projectMap.get(t.projectId)?.toLowerCase().includes(q))
      );
    }

    if (statusFilter !== 'all') {
      list = list.filter((t) => t.status === statusFilter);
    }

    list.sort((a, b) => {
      const order: Record<TerminalStatus, number> = {
        'claude-active': 0, 'running': 1, 'idle': 2, 'exited': 3,
      };
      const d = order[a.status] - order[b.status];
      if (d !== 0) return d;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    return list;
  }, [terminals, searchQuery, statusFilter, projectMap]);

  const counts = useMemo(() => {
    const c = { all: terminals.length, idle: 0, running: 0, 'claude-active': 0, exited: 0 };
    for (const t of terminals) c[t.status]++;
    return c;
  }, [terminals]);

  // Auto-select first terminal if current selection is invalid
  const selectedTerminal = useMemo(
    () => terminals.find((t) => t.id === selectedTerminalId),
    [terminals, selectedTerminalId],
  );

  // Agent callbacks for TerminalPanel
  const handleInvokeAgent = useCallback(async (id: string, skipPermissions?: boolean) => {
    const terminal = useTerminalStore.getState().getTerminal(id);
    if (!terminal) return;
    const agentId = terminal.agentProvider;
    const s = useSettingsStore.getState().settings;
    const project = terminal.projectId ? projects.find((p) => p.id === terminal.projectId) : activeProject;
    const model = project?.agentModel || s.agentModels?.[agentId] || undefined;
    const result = await window.electronAPI.invokeAgent(id, agentId, {
      cwd: project?.path,
      skipPermissions,
      model,
    });
    if (result.success) {
      useTerminalStore.getState().setClaudeMode(id, true);
      if (skipPermissions) {
        useTerminalStore.getState().updateTerminal(id, { skipPermissions: true });
      }
      // Send task context as first prompt if terminal is linked to a task
      if (terminal.task) {
        const taskId = terminal.task.id;
        window.electronAPI.getTaskManagerTask(taskId).then((taskResult: any) => {
          if (!taskResult.success || !taskResult.data) return;
          const task = taskResult.data;
          const taskLabel = task.customId || task.id;
          const parts = [
            `I'm working on task ${taskLabel}: ${task.name}`,
            `Status: ${task.status.name}`,
          ];
          if (task.priority) parts.push(`Priority: ${task.priority.name}`);
          if (task.description) {
            const desc = task.description.length > 1000
              ? task.description.slice(0, 1000) + '...'
              : task.description;
            parts.push(`Description:\n${desc}`);
          }
          if (task.url) parts.push(`URL: ${task.url}`);
          const prompt = parts.join('\n');
          setTimeout(() => {
            window.electronAPI.sendTerminalInput(id, prompt + '\n');
          }, 3000);
        }).catch(() => { /* non-critical */ });
      }
    }
  }, [projects, activeProject]);

  const handleProviderChange = useCallback((id: string, provider: AgentProviderId) => {
    useTerminalStore.getState().setAgentProvider(id, provider);
  }, []);

  const handleCloseTerminal = useCallback(async (id: string) => {
    await window.electronAPI.destroyTerminal(id);
    removeTerminal(id);
    if (selectedTerminalId === id) setSelectedTerminalId(null);
  }, [removeTerminal, selectedTerminalId]);

  const handleNewTerminal = useCallback(async () => {
    const cwd = activeProject?.path || settings.workingDirectory || '';
    const terminal = addTerminal(cwd, activeProject?.id);
    if (terminal) {
      await window.electronAPI.createTerminal({
        id: terminal.id,
        cwd: terminal.cwd,
        cols: 80,
        rows: 24,
      });
      setSelectedTerminalId(terminal.id);
    }
  }, [addTerminal, activeProject, settings.workingDirectory]);

  const activeFilterCount = statusFilter !== 'all' ? 1 : 0;

  return (
    <div className="flex h-full">
      {/* Left sidebar — session list */}
      <div className="w-72 shrink-0 flex flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]">
        {/* Header */}
        <div className="h-12 flex items-center px-3 justify-between border-b border-[var(--border)] drag-region">
          <div className="flex items-center gap-2 no-drag">
            <LayoutList className="w-4 h-4 text-[var(--accent)]" />
            <h1 className="text-sm font-semibold text-[var(--text-primary)]">Sessions</h1>
            <span className="text-[10px] text-[var(--text-muted)]">{terminals.length}</span>
          </div>
          <button
            onClick={handleNewTerminal}
            className="no-drag w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="New terminal"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {/* Tab toggle */}
        <div className="flex border-b border-[var(--border)]">
          <button
            onClick={() => setSessionTab('active')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2',
              sessionTab === 'active'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            )}
          >
            <Terminal className="w-3.5 h-3.5" />
            Active
          </button>
          <button
            onClick={() => setSessionTab('past')}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2',
              sessionTab === 'past'
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            )}
          >
            <History className="w-3.5 h-3.5" />
            Past
          </button>
        </div>

        {sessionTab === 'past' ? (
          <PastSessionsList onNavigateToTerminal={onNavigateToTerminal} />
        ) : (
          <>
        {/* Search */}
        <div className="px-3 py-2 space-y-2 border-b border-[var(--border)]">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search sessions..."
                className="w-full pl-8 pr-3 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={cn(
                'w-7 h-7 rounded-md flex items-center justify-center transition-colors',
                showFilters || activeFilterCount > 0
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]'
              )}
            >
              <Filter className="w-3.5 h-3.5" />
            </button>
          </div>

          {showFilters && (
            <div className="flex flex-wrap gap-1">
              {(['all', 'claude-active', 'running', 'idle', 'exited'] as StatusFilter[]).map((status) => {
                const count = status === 'all' ? counts.all : counts[status];
                const cfg = status === 'all' ? null : STATUS_CONFIG[status];
                return (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(status)}
                    className={cn(
                      'text-[10px] px-2 py-0.5 rounded-full border transition-colors flex items-center gap-1',
                      statusFilter === status
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]'
                    )}
                  >
                    {cfg && <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dot)} />}
                    {status === 'all' ? 'All' : cfg!.label}
                    <span className="opacity-60">{count}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {filteredTerminals.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-[var(--text-muted)]">
              <Terminal className="w-6 h-6 opacity-30 mb-2" />
              <p className="text-xs">{terminals.length === 0 ? 'No sessions' : 'No matches'}</p>
            </div>
          ) : (
            <div className="p-1.5 space-y-0.5">
              {filteredTerminals.map((terminal) => {
                const cfg = STATUS_CONFIG[terminal.status];
                const projectName = terminal.projectId ? projectMap.get(terminal.projectId) : undefined;
                const isSelected = selectedTerminalId === terminal.id;
                const elapsed = terminal.timeTracking
                  ? (terminal.timeTracking.elapsed || 0) +
                    (terminal.timeTracking.startedAt ? Date.now() - terminal.timeTracking.startedAt : 0)
                  : 0;

                return (
                  <button
                    key={terminal.id}
                    onClick={() => setSelectedTerminalId(terminal.id)}
                    className={cn(
                      'w-full text-left px-2.5 py-2 rounded-lg transition-colors group/item',
                      isSelected
                        ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/30'
                        : 'hover:bg-[var(--bg-tertiary)] border border-transparent',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {/* Icon */}
                      <div className="shrink-0 relative">
                        {terminal.isClaudeMode ? (
                          <Bot className={cn('w-4 h-4', cfg.color, terminal.isClaudeBusy && 'animate-pulse')} />
                        ) : (
                          <Terminal className={cn('w-4 h-4', cfg.color)} />
                        )}
                      </div>

                      {/* Title + meta */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-[var(--text-primary)] truncate font-medium">
                            {terminal.title}
                          </span>
                          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', cfg.dot)} />
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {terminal.isClaudeMode && (
                            <span className="text-[9px] text-emerald-400">{terminal.agentProvider}</span>
                          )}
                          {projectName && (
                            <span className="text-[9px] text-[var(--text-muted)] flex items-center gap-0.5 truncate">
                              <FolderOpen className="w-2 h-2" />{projectName}
                            </span>
                          )}
                          {elapsed > 0 && (
                            <span className="text-[9px] text-[var(--text-muted)] flex items-center gap-0.5">
                              <Clock className="w-2 h-2" />{formatElapsed(elapsed)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Time + actions */}
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[9px] text-[var(--text-muted)] group-hover/item:hidden">
                          {formatDate(terminal.createdAt)}
                        </span>
                        <div className="hidden group-hover/item:flex items-center gap-0.5">
                          <span
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveTerminal(terminal.id);
                              onNavigateToTerminal?.();
                            }}
                            className="w-5 h-5 rounded flex items-center justify-center text-[var(--accent)] hover:bg-[var(--accent)]/10 cursor-pointer"
                            title="Go to Terminals view"
                          >
                            <Play className="w-2.5 h-2.5" />
                          </span>
                          {terminal.status === 'exited' && (
                            <span
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCloseTerminal(terminal.id);
                              }}
                              className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                              title="Remove"
                            >
                              <Trash2 className="w-2.5 h-2.5" />
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
          </>
        )}
      </div>

      {/* Right side — terminal panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedTerminal ? (
          <TerminalPanel
            key={selectedTerminal.id}
            terminal={selectedTerminal}
            isActive={true}
            agentProviders={agentProviders}
            skills={activeProject?.skills}
            onInvokeAgent={(skip) => handleInvokeAgent(selectedTerminal.id, skip)}
            onProviderChange={(p) => handleProviderChange(selectedTerminal.id, p)}
            onClose={() => handleCloseTerminal(selectedTerminal.id)}
            onFocus={() => setSelectedTerminalId(selectedTerminal.id)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-3">
            <LayoutList className="w-12 h-12 opacity-20" />
            <p className="text-sm">Select a session to view</p>
            <p className="text-xs opacity-60">or create a new terminal</p>
            <button
              onClick={handleNewTerminal}
              className="mt-2 flex items-center gap-2 text-sm px-4 py-2 rounded-lg bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
            >
              <Plus className="w-4 h-4" /> New Terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
