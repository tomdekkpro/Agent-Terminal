import { useCallback, useState, useRef, useEffect } from 'react';
import { FolderOpen, Plus, X, ChevronDown, GripVertical, Settings, Play, Square, ScrollText } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { useDevServerStore } from '../../stores/dev-server-store';
import { cn } from '../../../shared/utils';
import type { AgentProviderMeta, DevServerEvent } from '../../../shared/types';
import { ProjectSettingsModal } from '../project/ProjectSettingsModal';

export function ProjectTabBar() {
  const projects = useProjectStore((s) => s.projects);
  const openProjectIds = useProjectStore((s) => s.openProjectIds);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const tabOrder = useProjectStore((s) => s.tabOrder);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);
  const closeProjectTab = useProjectStore((s) => s.closeProjectTab);
  const openProjectTab = useProjectStore((s) => s.openProjectTab);
  const addProject = useProjectStore((s) => s.addProject);
  const removeProject = useProjectStore((s) => s.removeProject);
  const reorderTabs = useProjectStore((s) => s.reorderTabs);

  const [showDropdown, setShowDropdown] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const [agentProviders, setAgentProviders] = useState<AgentProviderMeta[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Dev server status tracking (from store)
  const serverStatus = useDevServerStore((s) => s.status);
  const handleDevServerEvent = useDevServerStore((s) => s.handleEvent);
  const toggleLog = useDevServerStore((s) => s.toggleLog);
  const activeLog = useDevServerStore((s) => s.activeLog);

  // Load agent providers when settings modal opens
  useEffect(() => {
    if (!settingsProjectId) return;
    window.electronAPI.getAgentProviders?.()
      .then((result: any) => {
        const providers = Array.isArray(result) ? result : result?.data;
        if (Array.isArray(providers)) setAgentProviders(providers);
      })
      .catch(() => {});
  }, [settingsProjectId]);

  // Fetch dev server status for active project
  useEffect(() => {
    if (!activeProjectId) return;
    window.electronAPI.getDevServerStatus?.(activeProjectId)
      .then((result: any) => {
        if (result?.success && result.data) {
          // Seed the store with initial status
          handleDevServerEvent({ projectId: activeProjectId, type: 'frontend', status: result.data.frontend });
          handleDevServerEvent({ projectId: activeProjectId, type: 'backend', status: result.data.backend });
        }
      })
      .catch(() => {});
  }, [activeProjectId, handleDevServerEvent]);

  // Listen for dev server events — pipe into store
  useEffect(() => {
    const unsub = window.electronAPI.onDevServerEvent?.((event: DevServerEvent) => {
      handleDevServerEvent(event);
    });
    return () => { unsub?.(); };
  }, [handleDevServerEvent]);

  const handleToggleServer = useCallback(async (projectId: string, type: 'frontend' | 'backend') => {
    const current = serverStatus[projectId]?.[type] || 'stopped';
    if (current === 'running' || current === 'starting') {
      await window.electronAPI.stopDevServer?.(projectId, type);
    } else {
      const result = await window.electronAPI.startDevServer?.(projectId, type);
      if (result && !result.success) {
        // Brief flash of error via store
        handleDevServerEvent({ projectId, type, status: 'error', error: result.error });
        setTimeout(() => {
          handleDevServerEvent({ projectId, type, status: 'stopped' });
        }, 2000);
      }
    }
  }, [serverStatus, handleDevServerEvent]);

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  // Get ordered open projects
  const openProjects = tabOrder
    .filter((id) => openProjectIds.includes(id))
    .map((id) => projects.find((p) => p.id === id))
    .filter(Boolean) as typeof projects;

  // Add any open projects not in tabOrder (fallback)
  openProjectIds.forEach((id) => {
    if (!tabOrder.includes(id)) {
      const p = projects.find((proj) => proj.id === id);
      if (p) openProjects.push(p);
    }
  });

  // Closed projects (known but not open as tabs)
  const closedProjects = projects.filter((p) => !openProjectIds.includes(p.id));

  const handleAddProject = useCallback(async () => {
    setShowDropdown(false);
    await addProject();
  }, [addProject]);

  const handleCloseTab = useCallback(
    (e: React.MouseEvent, projectId: string) => {
      e.stopPropagation();
      // Shut down all active terminals for this project to free memory
      const terminals = useTerminalStore.getState().getTerminalsByProject(projectId);
      for (const t of terminals) {
        if (t.status !== 'exited') {
          window.electronAPI.destroyTerminal(t.id).catch(() => {});
        }
        useTerminalStore.getState().removeTerminal(t.id);
      }
      closeProjectTab(projectId);
    },
    [closeProjectTab]
  );

  const handleReopenProject = useCallback(
    (projectId: string) => {
      setShowDropdown(false);
      openProjectTab(projectId);
    },
    [openProjectTab]
  );

  const handleRemoveProject = useCallback(
    (e: React.MouseEvent, projectId: string) => {
      e.stopPropagation();
      // Shut down all active terminals for this project to free memory
      const terminals = useTerminalStore.getState().getTerminalsByProject(projectId);
      for (const t of terminals) {
        if (t.status !== 'exited') {
          window.electronAPI.destroyTerminal(t.id).catch(() => {});
        }
        useTerminalStore.getState().removeTerminal(t.id);
      }
      removeProject(projectId);
    },
    [removeProject]
  );

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    // Make the drag image slightly transparent
    if (e.currentTarget instanceof HTMLElement) {
      e.dataTransfer.setDragImage(e.currentTarget, 0, 0);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      reorderTabs(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
  }, [dragIndex, reorderTabs]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDropIndex(null);
  }, []);

  return (
    <div className="h-9 bg-[var(--bg-primary)] border-b border-[var(--border)] flex items-center px-1 gap-0.5 shrink-0">
      <div className="flex items-center gap-0.5 overflow-x-auto flex-1 min-w-0">
      {openProjects.map((project, index) => (
        <div
          key={project.id}
          draggable
          onDragStart={(e) => handleDragStart(e, index)}
          onDragOver={(e) => handleDragOver(e, index)}
          onDrop={(e) => handleDrop(e, index)}
          onDragEnd={handleDragEnd}
          onClick={() => setActiveProject(project.id)}
          title={index < 9 ? `${project.name}  (Ctrl+${index + 1})` : project.name}
          className={cn(
            'group flex items-center gap-1 px-2 h-7 rounded-md text-xs transition-all min-w-0 shrink-0 cursor-pointer',
            'hover:bg-[var(--bg-tertiary)]',
            activeProjectId === project.id
              ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)]'
              : 'text-[var(--text-muted)]',
            dragIndex === index && 'opacity-40',
            dropIndex === index && dragIndex !== null && dragIndex !== index && 'border-l-2 border-l-[var(--accent)]'
          )}
        >
          <GripVertical className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-40 cursor-grab active:cursor-grabbing" />
          <FolderOpen className="w-3 h-3 shrink-0" />
          <span className="truncate max-w-[140px]">{project.name}</span>
          {index < 9 && (
            <span className="text-[9px] text-[var(--text-muted)] opacity-0 group-hover:opacity-60 shrink-0 ml-0.5">{index + 1}</span>
          )}
          <button
            className="w-4 h-4 shrink-0 rounded opacity-0 group-hover:opacity-100 flex items-center justify-center hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
            onClick={(e) => { e.stopPropagation(); setSettingsProjectId(project.id); }}
            title="Project settings"
          >
            <Settings className="w-3 h-3" />
          </button>
          <button
            className="w-4 h-4 shrink-0 rounded opacity-0 group-hover:opacity-100 flex items-center justify-center hover:bg-[var(--error)]/20 hover:text-[var(--error)] text-[var(--text-muted)] transition-all"
            onClick={(e) => handleCloseTab(e, project.id)}
            title="Close project tab"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}

      </div>

      {/* Dev Server buttons for active project */}
      {(() => {
        const activeProject = projects.find((p) => p.id === activeProjectId);
        if (!activeProject?.devServer) return null;
        const status = serverStatus[activeProject.id] || { frontend: 'stopped', backend: 'stopped' };
        const hasFe = !!activeProject.devServer.frontendCmd;
        const hasBe = !!activeProject.devServer.backendCmd;
        if (!hasFe && !hasBe) return null;

        return (
          <div className="flex items-center gap-1 shrink-0 border-l border-[var(--border)] pl-2 ml-1">
            {hasFe && (
              <div className="flex items-center gap-0">
                <button
                  onClick={() => handleToggleServer(activeProject.id, 'frontend')}
                  title={`Frontend: ${status.frontend}${status.frontend === 'stopped' ? ' — Click to start' : ' — Click to stop'}`}
                  className={cn(
                    'flex items-center gap-1 h-6 px-2 rounded-l text-[10px] font-medium transition-all',
                    status.frontend === 'running'
                      ? 'bg-[#22c55e]/15 text-[#22c55e] hover:bg-[#ef4444]/15 hover:text-[#ef4444]'
                      : status.frontend === 'starting'
                      ? 'bg-[#f59e0b]/15 text-[#f59e0b] animate-pulse'
                      : status.frontend === 'error'
                      ? 'bg-[#ef4444]/15 text-[#ef4444]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[#22c55e] hover:bg-[#22c55e]/10',
                  )}
                >
                  {status.frontend === 'running' || status.frontend === 'starting' ? (
                    <Square className="w-2.5 h-2.5" />
                  ) : (
                    <Play className="w-2.5 h-2.5" />
                  )}
                  <span>FE</span>
                </button>
                <button
                  onClick={() => toggleLog(activeProject.id, 'frontend')}
                  title="Toggle frontend logs"
                  className={cn(
                    'flex items-center h-6 px-1 rounded-r text-[10px] transition-all border-l border-black/10',
                    activeLog?.projectId === activeProject.id && activeLog?.type === 'frontend'
                      ? 'bg-[#22c55e]/25 text-[#22c55e]'
                      : status.frontend === 'running'
                      ? 'bg-[#22c55e]/15 text-[#22c55e]/60 hover:text-[#22c55e]'
                      : status.frontend === 'starting'
                      ? 'bg-[#f59e0b]/15 text-[#f59e0b]/60'
                      : status.frontend === 'error'
                      ? 'bg-[#ef4444]/15 text-[#ef4444]/60'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <ScrollText className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
            {hasBe && (
              <div className="flex items-center gap-0">
                <button
                  onClick={() => handleToggleServer(activeProject.id, 'backend')}
                  title={`Backend: ${status.backend}${status.backend === 'stopped' ? ' — Click to start' : ' — Click to stop'}`}
                  className={cn(
                    'flex items-center gap-1 h-6 px-2 rounded-l text-[10px] font-medium transition-all',
                    status.backend === 'running'
                      ? 'bg-[#6366f1]/15 text-[#6366f1] hover:bg-[#ef4444]/15 hover:text-[#ef4444]'
                      : status.backend === 'starting'
                      ? 'bg-[#f59e0b]/15 text-[#f59e0b] animate-pulse'
                      : status.backend === 'error'
                      ? 'bg-[#ef4444]/15 text-[#ef4444]'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[#6366f1] hover:bg-[#6366f1]/10',
                  )}
                >
                  {status.backend === 'running' || status.backend === 'starting' ? (
                    <Square className="w-2.5 h-2.5" />
                  ) : (
                    <Play className="w-2.5 h-2.5" />
                  )}
                  <span>BE</span>
                </button>
                <button
                  onClick={() => toggleLog(activeProject.id, 'backend')}
                  title="Toggle backend logs"
                  className={cn(
                    'flex items-center h-6 px-1 rounded-r text-[10px] transition-all border-l border-black/10',
                    activeLog?.projectId === activeProject.id && activeLog?.type === 'backend'
                      ? 'bg-[#6366f1]/25 text-[#6366f1]'
                      : status.backend === 'running'
                      ? 'bg-[#6366f1]/15 text-[#6366f1]/60 hover:text-[#6366f1]'
                      : status.backend === 'starting'
                      ? 'bg-[#f59e0b]/15 text-[#f59e0b]/60'
                      : status.backend === 'error'
                      ? 'bg-[#ef4444]/15 text-[#ef4444]/60'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <ScrollText className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* Add / Reopen dropdown */}
      <div className="relative shrink-0" ref={dropdownRef}>
        <button
          onClick={() => closedProjects.length > 0 ? setShowDropdown(!showDropdown) : handleAddProject()}
          className={cn(
            'h-7 rounded-md flex items-center justify-center transition-all shrink-0 gap-0.5 px-1.5',
            'hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
          )}
          title="Add Project Folder"
        >
          <Plus className="w-3.5 h-3.5" />
          {closedProjects.length > 0 && <ChevronDown className="w-3 h-3" />}
        </button>

        {showDropdown && (
          <div className="absolute top-full right-0 mt-1 z-50 w-64 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl overflow-hidden">
            {closedProjects.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border)]">
                  Recent Projects
                </div>
                {closedProjects.map((p) => (
                  <div
                    key={p.id}
                    className="group flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-tertiary)] cursor-pointer"
                    onClick={() => handleReopenProject(p.id)}
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-[var(--text-primary)] truncate">{p.name}</div>
                      <div className="text-[10px] text-[var(--text-muted)] truncate">{p.path}</div>
                    </div>
                    <button
                      className="w-4 h-4 shrink-0 rounded opacity-0 group-hover:opacity-100 flex items-center justify-center hover:bg-[var(--error)]/20 hover:text-[var(--error)] text-[var(--text-muted)] transition-all"
                      onClick={(e) => handleRemoveProject(e, p.id)}
                      title="Remove project"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <div className="border-t border-[var(--border)]" />
              </>
            )}
            <button
              onClick={handleAddProject}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[var(--bg-tertiary)] text-xs text-[var(--text-secondary)]"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Open New Folder...</span>
            </button>
          </div>
        )}
      </div>

      {/* Project settings modal */}
      {settingsProjectId && (() => {
        const p = projects.find((proj) => proj.id === settingsProjectId);
        return p ? (
          <ProjectSettingsModal
            project={p}
            agentProviders={agentProviders}
            onClose={() => setSettingsProjectId(null)}
          />
        ) : null;
      })()}
    </div>
  );
}
