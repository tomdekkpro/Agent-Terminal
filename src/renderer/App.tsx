import { useState, useEffect } from 'react';
import { Sidebar } from './components/layout/Sidebar';
import { ProjectTabBar } from './components/layout/ProjectTabBar';
import { TerminalView } from './components/terminal/TerminalView';
import { SettingsView } from './components/settings/SettingsView';
import { useGlobalTerminalListeners } from './hooks/useGlobalTerminalListeners';
import { useProjectStore } from './stores/project-store';
import { useSettingsStore } from './stores/settings-store';
import { useTerminalStore } from './stores/terminal-store';
import { useKanbanStore } from './stores/kanban-store';
import { InsightsView } from './components/insights';
import { QCView } from './components/qc';
import { CodeReviewView } from './components/code-review';
import { KanbanView } from './components/kanban';
import { DashboardView } from './components/dashboard';
import { useActivityStore, subscribeActivityEvents } from './stores/activity-store';
import { UpdateNotification } from './components/updates/UpdateNotification';
// import { TeamPanel } from './components/team/TeamPanel';
import { DevServerLogPanel } from './components/dev-server/DevServerLogPanel';

export type ViewType = 'dashboard' | 'terminals' | 'kanban' | 'qc' | 'insights' | 'code-review' | 'settings';

export default function App() {
  const [activeView, setActiveView] = useState<ViewType>('dashboard');
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const restoreState = useTerminalStore((s) => s.restoreState);

  useGlobalTerminalListeners();

  // Activity feed: load history once and keep the live subscription open at the
  // app root so the unread badge stays current even when the view is closed.
  useEffect(() => {
    void useActivityStore.getState().load();
    return subscribeActivityEvents();
  }, []);

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
      d: 'dashboard',
      t: 'terminals',
      k: 'kanban',
      q: 'qc',
      i: 'insights',
      r: 'code-review',
      s: 'settings',
    };
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();

      // Ctrl+B — toggle the notifications popover
      if (key === 'b') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('agent-terminal:toggle-notifications'));
        return;
      }

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
    let cancelled = false;
    let snapshotTimer: ReturnType<typeof setInterval> | null = null;

    (async () => {
      await Promise.all([
        loadProjects(),
        loadSettings(),
        // Load saved terminals into store with needsRestore flag
        // (PTYs are NOT created yet — each terminal shows a restore banner)
        restoreState(),
        useKanbanStore.getState().loadTasks(),
      ]);
      if (cancelled) return;

      // One-shot migration: any task-linked terminal without a KanbanTask gets
      // imported to the board so the Kanban and Terminals views stay in sync.
      try {
        const migrated = await useKanbanStore.getState().migrateOrphanTerminals();
        if (migrated > 0) {
          // eslint-disable-next-line no-console
          console.log(`[Kanban] Migrated ${migrated} orphan task-linked terminal(s) to the Kanban board`);
        }
      } catch { /* non-critical */ }

      // Boot-time ClickUp snapshot refresh so statuses are current when the
      // user first opens the Kanban view.
      try {
        await useKanbanStore.getState().refreshClickupSnapshots();
      } catch { /* non-critical */ }

      if (cancelled) return;

      // Start the periodic snapshot refresh. Runs independent of the auto-code
      // orchestrator so the board stays fresh even when auto-code is disabled.
      const scheduleRefresh = () => {
        const intervalMinutes = useSettingsStore.getState().settings.kanbanSnapshotIntervalMinutes ?? 5;
        if (snapshotTimer) {
          clearInterval(snapshotTimer);
          snapshotTimer = null;
        }
        if (!intervalMinutes || intervalMinutes <= 0) return;
        const ms = intervalMinutes * 60_000;
        snapshotTimer = setInterval(() => {
          const settings = useSettingsStore.getState().settings;
          if (settings.taskManagerProvider !== 'clickup') return;
          if (useKanbanStore.getState().tasks.length === 0) return; // nothing to refresh
          void useKanbanStore.getState().refreshClickupSnapshots();
        }, ms);
      };
      scheduleRefresh();

      // Re-schedule if the interval setting changes
      const unsub = useSettingsStore.subscribe((s, prev) => {
        if (s.settings.kanbanSnapshotIntervalMinutes !== prev.settings.kanbanSnapshotIntervalMinutes) {
          scheduleRefresh();
        }
      });

      if (cancelled) {
        unsub();
        if (snapshotTimer) clearInterval(snapshotTimer);
      }
    })();

    return () => {
      cancelled = true;
      if (snapshotTimer) clearInterval(snapshotTimer);
    };
  }, [loadProjects, loadSettings, restoreState]);

  return (
    <div className="flex h-screen bg-[var(--bg-primary)]">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />
      <main className="flex-1 flex flex-col overflow-hidden">
        {activeView === 'dashboard' && <DashboardView />}
        {activeView === 'terminals' && (
          <>
            <ProjectTabBar />
            <TerminalView projectId={activeProjectId ?? undefined} />
            <DevServerLogPanel />
          </>
        )}
        {activeView === 'kanban' && <KanbanView onNavigateToTerminal={() => setActiveView('terminals')} />}
        {activeView === 'qc' && <QCView />}
        {activeView === 'insights' && <InsightsView />}
        {activeView === 'code-review' && <CodeReviewView />}
        {activeView === 'settings' && <SettingsView />}
      </main>
      <UpdateNotification />
      {/* <TeamPanel /> */}
    </div>
  );
}
