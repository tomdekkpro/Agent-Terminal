import { useState, useEffect } from 'react';
import { Sidebar } from './components/layout/Sidebar';
import { ProjectTabBar } from './components/layout/ProjectTabBar';
import { TerminalView } from './components/terminal/TerminalView';
import { TasksView } from './components/tasks';
import { SettingsView } from './components/settings/SettingsView';
import { useGlobalTerminalListeners } from './hooks/useGlobalTerminalListeners';
import { useProjectStore } from './stores/project-store';
import { useSettingsStore } from './stores/settings-store';
import { useTerminalStore } from './stores/terminal-store';
import { InsightsView } from './components/insights';
import { QCView } from './components/qc';
import { CodeReviewView } from './components/code-review';
import { UpdateNotification } from './components/updates/UpdateNotification';
import { TeamPanel } from './components/team/TeamPanel';
import { DevServerLogPanel } from './components/dev-server/DevServerLogPanel';

export type ViewType = 'terminals' | 'tasks' | 'qc' | 'insights' | 'code-review' | 'settings';

export default function App() {
  const [activeView, setActiveView] = useState<ViewType>('terminals');
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const restoreState = useTerminalStore((s) => s.restoreState);

  useGlobalTerminalListeners();

  // Keyboard shortcuts
  const openProjectIds = useProjectStore((s) => s.openProjectIds);
  const tabOrder = useProjectStore((s) => s.tabOrder);
  const setActiveProject = useProjectStore((s) => s.setActiveProject);

  // Prevent Electron from navigating when files are dropped outside a terminal
  useEffect(() => {
    const preventNav = (e: DragEvent) => { e.preventDefault(); };
    document.addEventListener('dragover', preventNav);
    document.addEventListener('drop', preventNav);
    return () => {
      document.removeEventListener('dragover', preventNav);
      document.removeEventListener('drop', preventNav);
    };
  }, []);

  useEffect(() => {
    const viewKeys: Record<string, ViewType> = {
      t: 'terminals',
      k: 'tasks',
      q: 'qc',
      i: 'insights',
      r: 'code-review',
      s: 'settings',
    };
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();

      // Ctrl+T/K/S — switch views
      const view = viewKeys[key];
      if (view) {
        e.preventDefault();
        setActiveView(view);
        return;
      }

      // Ctrl+N — new terminal
      if (key === 'n') {
        e.preventDefault();
        setActiveView('terminals');
        window.dispatchEvent(new CustomEvent('agent-terminal:new-terminal'));
        return;
      }

      // Ctrl+1..9 — switch project tabs
      const digit = parseInt(e.key, 10);
      if (digit >= 1 && digit <= 9) {
        e.preventDefault();
        const orderedIds = tabOrder.length > 0 ? tabOrder : openProjectIds;
        const targetId = orderedIds[digit - 1];
        if (targetId) {
          setActiveView('terminals');
          setActiveProject(targetId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openProjectIds, tabOrder, setActiveProject]);

  useEffect(() => {
    loadProjects();
    loadSettings();
    // Load saved terminals into store with needsRestore flag
    // (PTYs are NOT created yet — each terminal shows a restore banner)
    restoreState();
  }, [loadProjects, loadSettings, restoreState]);

  return (
    <div className="flex h-screen bg-[var(--bg-primary)]">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />
      <main className="flex-1 flex flex-col overflow-hidden">
        {activeView === 'terminals' && (
          <>
            <ProjectTabBar />
            <TerminalView projectId={activeProjectId ?? undefined} />
            <DevServerLogPanel />
          </>
        )}
        {activeView === 'tasks' && <TasksView onNavigateToTerminal={() => setActiveView('terminals')} />}
        {activeView === 'qc' && <QCView />}
        {activeView === 'insights' && <InsightsView />}
        {activeView === 'code-review' && <CodeReviewView />}
        {activeView === 'settings' && <SettingsView />}
      </main>
      <UpdateNotification />
      <TeamPanel />
    </div>
  );
}
