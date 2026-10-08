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
import { ChatView, ChatDock, ChatDockHandle } from './components/chat';
import { useChatStore } from './stores/chat-store';
import { QCView } from './components/qc';
import { CodeReviewView } from './components/code-review';
import { KanbanView } from './components/kanban';
import { DashboardView } from './components/dashboard';
import { useActivityStore, subscribeActivityEvents } from './stores/activity-store';
import { UpdateNotification } from './components/updates/UpdateNotification';
// import { TeamPanel } from './components/team/TeamPanel';
import { DevServerLogPanel } from './components/dev-server/DevServerLogPanel';

/** How often the channel list is re-read while a conversation is on screen
 *  (the Chat page or the dock) — the sidebar has to feel live. */
const CHAT_POLL_ACTIVE_MS = 45_000;
/** …and while none is: this only feeds unread badges, and it shares ClickUp's
 *  per-token budget with the Kanban, dashboard and code-review pollers. */
const CHAT_POLL_IDLE_MS = 90_000;

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

  // Chat. The channel list is polled here and nowhere else, so unread badges
  // are right on every page — the rail, the dock handle and the Chat sidebar
  // all read the same state whether or not a transcript is open.
  const chatConfigured = useSettingsStore(
    (s) =>
      s.settings.taskManagerProvider === 'clickup' &&
      !!s.settings.clickupApiKey &&
      !!s.settings.clickupWorkspaceId,
  );
  const chatOnScreen = useChatStore((s) => s.viewing.page || s.viewing.dock);
  const dockOpen = useChatStore((s) => s.dockOpen);
  const setDockOpen = useChatStore((s) => s.setDockOpen);
  // Muted conversations are excluded everywhere a badge is shown, which is the
  // whole point of muting one.
  const chatUnread = useChatStore((s) =>
    Object.entries(s.unread).reduce(
      (total, [id, entry]) => (s.muted[id] ? total : total + entry.count),
      0,
    ),
  );

  useEffect(() => {
    if (!chatConfigured) return;
    let cancelled = false;
    const tick = async () => {
      await useChatStore.getState().bootstrap();
      // A workspace without Chat (or a token that can't see it) answers once
      // and is never asked again — no point retrying on a timer.
      if (cancelled || useChatStore.getState().bootstrapError) return;
      await useChatStore.getState().loadChannels({ force: true, background: true });
    };
    void tick();
    const timer = setInterval(
      () => { void tick(); },
      chatOnScreen ? CHAT_POLL_ACTIVE_MS : CHAT_POLL_IDLE_MS,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [chatConfigured, chatOnScreen]);

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
      // Ctrl+Shift+M — toggle the message dock. Checked before the guard below,
      // which rejects every Shift combination.
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        useChatStore.getState().toggleDock();
        return;
      }
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
        {activeView === 'insights' && <ChatView />}
        {activeView === 'code-review' && <CodeReviewView />}
        {activeView === 'settings' && <SettingsView />}
      </main>

      {/* Chat rides along beside every page except the Chat page itself, where
          it would only duplicate what is already on screen. */}
      {chatConfigured && activeView !== 'insights' && (
        dockOpen ? (
          <ChatDock onOpenFullPage={() => setActiveView('insights')} />
        ) : (
          <ChatDockHandle onOpen={() => setDockOpen(true)} unread={chatUnread} />
        )
      )}

      <UpdateNotification />
      {/* <TeamPanel /> */}
    </div>
  );
}
