import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { AgentProviderId, TerminalTask } from '../../shared/types';
import { useSettingsStore } from './settings-store';
import { useProjectStore } from './project-store';
import { resolveSessionCwd, buildSessionCandidates } from '../lib/resolve-session-cwd';

export type TerminalStatus = 'idle' | 'running' | 'claude-active' | 'exited';

export interface TimeTracking {
  startedAt: number | null;  // Unix timestamp ms when current session started
  elapsed: number;           // Total accumulated ms (historical + all sessions)
  todayMs: number;           // Today's accumulated ms (from API + sessions today)
  todayDate: string;         // ISO date string (YYYY-MM-DD) for todayMs
}

/** Return value from stopTimer — includes session boundaries for posting */
export interface StopTimerResult extends TimeTracking {
  /** Original startedAt before stop (when play was clicked) */
  sessionStartMs: number;
  /** Timestamp when stop was called */
  sessionEndMs: number;
}

export interface Terminal {
  id: string;
  groupId: string;
  title: string;
  status: TerminalStatus;
  cwd: string;
  createdAt: Date;
  isClaudeMode: boolean;
  isClaudeBusy?: boolean;
  agentSessionId?: string;
  claudeCwd?: string;
  projectId?: string;
  task?: TerminalTask;
  agentProvider: AgentProviderId;
  /** @deprecated Use agentProvider */
  copilotProvider?: AgentProviderId;
  skipPermissions?: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
  /** Target branch for merging/PR when completing task */
  baseBranch?: string;
  timeTracking?: TimeTracking;
  pendingTaskPrompt?: string;
  /** True when restored from saved state but PTY not yet created */
  needsRestore?: boolean;
  /** True when terminal is restored but agent session not yet resumed */
  needsResume?: boolean;
  /** True while agent session is being resumed (shows overlay) */
  isResuming?: boolean;
  /** URL for live preview panel (e.g. http://localhost:3000) */
  previewUrl?: string;
  /** Whether the preview panel is currently open */
  previewOpen?: boolean;
}

// Output callback registry
const xtermCallbacks = new Map<string, (data: string) => void>();

// Secondary output taps — capture output without replacing xterm callback
const outputTaps = new Map<string, (data: string) => void>();

/** Register a secondary listener that receives terminal output alongside xterm */
export function addOutputTap(terminalId: string, callback: (data: string) => void): void {
  outputTaps.set(terminalId, callback);
}

/** Remove a secondary output listener */
export function removeOutputTap(terminalId: string): void {
  outputTaps.delete(terminalId);
}

// Saved output buffers from previous session (consumed once on terminal mount)
const savedOutputBuffers = new Map<string, string>();

/** Get and consume saved output buffer for a restored terminal */
export function getAndClearSavedBuffer(id: string): string | undefined {
  const buffer = savedOutputBuffers.get(id);
  if (buffer) savedOutputBuffers.delete(id);
  return buffer;
}

export function registerOutputCallback(terminalId: string, callback: (data: string) => void): void {
  xtermCallbacks.set(terminalId, callback);
}

export function unregisterOutputCallback(terminalId: string): void {
  xtermCallbacks.delete(terminalId);
}

// Build saveable state snapshot — persist all terminals so the full layout
// (including plain shell tabs) is restored when the app reopens.
function buildSaveableState(state: TerminalState) {
  const saveable = state.terminals
    .map((t) => ({
      id: t.id,
      groupId: t.groupId,
      title: t.title,
      cwd: t.cwd,
      projectId: t.projectId,
      isClaudeMode: t.isClaudeMode,
      agentSessionId: t.agentSessionId,
      claudeCwd: t.claudeCwd,
      agentProvider: t.agentProvider,
      skipPermissions: t.skipPermissions,
      task: t.task,
      worktreePath: t.worktreePath,
      worktreeBranch: t.worktreeBranch,
      baseBranch: t.baseBranch,
      timeTracking: t.timeTracking,
      previewUrl: t.previewUrl,
    }));

  return {
    terminals: saveable,
    activeTerminalId: state.activeTerminalId,
    activeGroupId: state.activeGroupId,
  };
}

// Debounced save
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedSaveState(state: TerminalState): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.electronAPI?.saveTerminalState?.(buildSaveableState(state));
  }, 500);
}

/** Flush terminal state to disk synchronously (for use in beforeunload) */
export function flushTerminalStateSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const state = useTerminalStore.getState();
  if (!state.isRestored) return;
  // Save all terminals so plain shells are also restored on next launch.
  const saveable = state.terminals
    .map((t) => ({
      id: t.id,
      groupId: t.groupId,
      title: t.title,
      cwd: t.cwd,
      projectId: t.projectId,
      isClaudeMode: t.isClaudeMode,
      agentSessionId: t.agentSessionId,
      claudeCwd: t.claudeCwd,
      agentProvider: t.agentProvider,
      skipPermissions: t.skipPermissions,
      task: t.task,
      worktreePath: t.worktreePath,
      worktreeBranch: t.worktreeBranch,
      baseBranch: t.baseBranch,
      timeTracking: t.timeTracking,
      previewUrl: t.previewUrl,
    }));
  if (saveable.length === 0) return; // nothing to save — don't overwrite good state
  window.electronAPI?.saveTerminalStateSync?.({
    terminals: saveable,
    activeTerminalId: state.activeTerminalId,
    activeGroupId: state.activeGroupId,
  });
}

interface TerminalState {
  terminals: Terminal[];
  activeTerminalId: string | null;
  activeGroupId: string | null;
  maxTerminals: number;
  isRestored: boolean;

  addTerminal: (cwd?: string, projectId?: string) => Terminal | null;
  splitTerminal: (cwd?: string, projectId?: string) => Terminal | null;
  removeTerminal: (id: string) => void;
  removeGroup: (groupId: string) => void;
  updateTerminal: (id: string, updates: Partial<Terminal>) => void;
  setActiveTerminal: (id: string | null) => void;
  setActiveGroup: (groupId: string) => void;
  setTerminalStatus: (id: string, status: TerminalStatus) => void;
  setClaudeMode: (id: string, isClaudeMode: boolean) => void;
  setAgentProvider: (id: string, provider: AgentProviderId) => void;
  clearAllTerminals: () => void;
  getTerminal: (id: string) => Terminal | undefined;
  getActiveTerminal: () => Terminal | undefined;
  canAddTerminal: () => boolean;
  getTerminalsByProject: (projectId?: string) => Terminal[];
  getGroupIds: (projectId?: string) => string[];
  getTerminalsInGroup: (groupId: string) => Terminal[];
  reorderGroups: (projectId: string | undefined, fromGroupId: string, toGroupId: string) => void;
  reorderTerminalsInGroup: (fromTerminalId: string, toTerminalId: string) => void;
  startTimer: (id: string) => void;
  stopTimer: (id: string) => StopTimerResult | null;
  writeToTerminal: (terminalId: string, data: string) => void;
  restoreState: () => Promise<Terminal[]>;
  /** Create PTY for a single restored terminal (no agent resume) */
  activateTerminal: (id: string) => Promise<void>;
  /** Resume the agent session for a restored terminal */
  resumeTerminalAgent: (id: string) => Promise<void>;
  /** Discard a restored terminal without creating PTY */
  discardTerminal: (id: string) => void;
  /** Toggle the preview panel open/closed for a terminal */
  togglePreview: (id: string) => void;
  /** Set the preview URL for a terminal */
  setPreviewUrl: (id: string, url: string) => void;
}


export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: [],
  activeTerminalId: null,
  activeGroupId: null,
  maxTerminals: 12,
  isRestored: false,

  // Create a terminal in a new group (new tab)
  addTerminal: (cwd?: string, projectId?: string) => {
    const state = get();
    const maxTerminals = useSettingsStore.getState().settings.maxTerminals || state.maxTerminals;
    const activeCount = state.terminals.filter(t => t.status !== 'exited').length;
    if (activeCount >= maxTerminals) return null;

    const groupId = uuid();
    const project = projectId ? useProjectStore.getState().projects.find(p => p.id === projectId) : undefined;
    const defaultProvider = project?.agentProvider || useSettingsStore.getState().settings.defaultAgentProvider || 'claude';
    const newTerminal: Terminal = {
      id: uuid(),
      groupId,
      title: `Terminal ${state.terminals.length + 1}`,
      status: 'idle',
      cwd: cwd || '',
      createdAt: new Date(),
      isClaudeMode: false,
      agentProvider: defaultProvider,
      projectId,
    };

    set((state) => ({
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: newTerminal.id,
      activeGroupId: groupId,
    }));

    return newTerminal;
  },

  // Create a terminal in the active group (split)
  splitTerminal: (cwd?: string, projectId?: string) => {
    const state = get();
    const maxTerminals = useSettingsStore.getState().settings.maxTerminals || state.maxTerminals;
    const activeCount = state.terminals.filter(t => t.status !== 'exited').length;
    if (activeCount >= maxTerminals) return null;
    if (!state.activeGroupId) return null;

    const project = projectId ? useProjectStore.getState().projects.find(p => p.id === projectId) : undefined;
    const defaultProvider = project?.agentProvider || useSettingsStore.getState().settings.defaultAgentProvider || 'claude';
    const newTerminal: Terminal = {
      id: uuid(),
      groupId: state.activeGroupId,
      title: `Terminal ${state.terminals.length + 1}`,
      status: 'idle',
      cwd: cwd || '',
      createdAt: new Date(),
      isClaudeMode: false,
      agentProvider: defaultProvider,
      projectId,
    };

    set((state) => ({
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: newTerminal.id,
    }));

    return newTerminal;
  },

  removeTerminal: (id: string) => {
    xtermCallbacks.delete(id);
    set((state) => {
      const removed = state.terminals.find((t) => t.id === id);
      const newTerminals = state.terminals.filter((t) => t.id !== id);

      let newActiveId = state.activeTerminalId;
      let newActiveGroupId = state.activeGroupId;

      if (removed && state.activeTerminalId === id) {
        // Try to stay in the same group
        const sameGroup = newTerminals.filter((t) => t.groupId === removed.groupId);
        if (sameGroup.length > 0) {
          newActiveId = sameGroup[sameGroup.length - 1].id;
        } else {
          // Group is empty, pick another
          const last = newTerminals[newTerminals.length - 1];
          newActiveId = last?.id || null;
          newActiveGroupId = last?.groupId || null;
        }
      }

      // If activeGroupId's group no longer exists, fix it
      if (newActiveGroupId && !newTerminals.some((t) => t.groupId === newActiveGroupId)) {
        const last = newTerminals[newTerminals.length - 1];
        newActiveGroupId = last?.groupId || null;
        newActiveId = last?.id || null;
      }

      return { terminals: newTerminals, activeTerminalId: newActiveId, activeGroupId: newActiveGroupId };
    });
  },

  removeGroup: (groupId: string) => {
    const state = get();
    const groupTerminals = state.terminals.filter((t) => t.groupId === groupId);
    groupTerminals.forEach((t) => xtermCallbacks.delete(t.id));

    set((state) => {
      const newTerminals = state.terminals.filter((t) => t.groupId !== groupId);
      let newActiveGroupId = state.activeGroupId;
      let newActiveId = state.activeTerminalId;

      if (state.activeGroupId === groupId) {
        const last = newTerminals[newTerminals.length - 1];
        newActiveGroupId = last?.groupId || null;
        newActiveId = last?.id || null;
      }

      return { terminals: newTerminals, activeTerminalId: newActiveId, activeGroupId: newActiveGroupId };
    });
  },

  updateTerminal: (id: string, updates: Partial<Terminal>) => {
    set((state) => ({
      terminals: state.terminals.map((t) => t.id === id ? { ...t, ...updates } : t),
    }));
  },

  setActiveTerminal: (id: string | null) => {
    if (!id) {
      set({ activeTerminalId: null });
      return;
    }
    const terminal = get().terminals.find((t) => t.id === id);
    if (terminal) {
      set({ activeTerminalId: id, activeGroupId: terminal.groupId });
    }
  },

  setActiveGroup: (groupId: string) => {
    const state = get();
    // If already in this group and have an active terminal there, keep it
    const activeTerminal = state.terminals.find((t) => t.id === state.activeTerminalId);
    if (activeTerminal?.groupId === groupId) {
      set({ activeGroupId: groupId });
      return;
    }
    // Otherwise pick the first terminal in the group
    const first = state.terminals.find((t) => t.groupId === groupId);
    set({
      activeGroupId: groupId,
      activeTerminalId: first?.id || null,
    });
  },

  setTerminalStatus: (id: string, status: TerminalStatus) => {
    set((state) => ({
      terminals: state.terminals.map((t) => t.id === id ? { ...t, status } : t),
    }));
  },

  setClaudeMode: (id: string, isClaudeMode: boolean) => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? {
          ...t,
          isClaudeMode,
          status: isClaudeMode ? 'claude-active' : (t.status === 'exited' ? 'exited' : 'running'),
        } : t
      ),
    }));
  },

  setAgentProvider: (id: string, provider: AgentProviderId) => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, agentProvider: provider } : t
      ),
    }));
  },

  clearAllTerminals: () => {
    xtermCallbacks.clear();
    set({ terminals: [], activeTerminalId: null, activeGroupId: null });
  },

  getTerminal: (id: string) => get().terminals.find((t) => t.id === id),
  getActiveTerminal: () => {
    const state = get();
    return state.terminals.find((t) => t.id === state.activeTerminalId);
  },
  canAddTerminal: () => {
    const state = get();
    const maxTerminals = useSettingsStore.getState().settings.maxTerminals || state.maxTerminals;
    return state.terminals.filter(t => t.status !== 'exited').length < maxTerminals;
  },
  getTerminalsByProject: (projectId?: string) => {
    const state = get();
    if (!projectId) return state.terminals.filter(t => !t.projectId);
    return state.terminals.filter(t => t.projectId === projectId);
  },
  getGroupIds: (projectId?: string) => {
    const state = get();
    const filtered = projectId
      ? state.terminals.filter((t) => t.projectId === projectId)
      : state.terminals.filter((t) => !t.projectId);
    // Unique groupIds in order of first appearance
    const seen = new Set<string>();
    const result: string[] = [];
    for (const t of filtered) {
      if (!seen.has(t.groupId)) {
        seen.add(t.groupId);
        result.push(t.groupId);
      }
    }
    return result;
  },
  getTerminalsInGroup: (groupId: string) => {
    return get().terminals.filter((t) => t.groupId === groupId);
  },

  reorderGroups: (projectId: string | undefined, fromGroupId: string, toGroupId: string) => {
    if (fromGroupId === toGroupId) return;
    set((state) => {
      // Separate terminals: those in this project vs. others
      const inProject = state.terminals.filter((t) =>
        projectId ? t.projectId === projectId : !t.projectId
      );
      const others = state.terminals.filter((t) =>
        projectId ? t.projectId !== projectId : !!t.projectId
      );

      // Get current group order
      const seen = new Set<string>();
      const groupOrder: string[] = [];
      for (const t of inProject) {
        if (!seen.has(t.groupId)) {
          seen.add(t.groupId);
          groupOrder.push(t.groupId);
        }
      }

      // Move fromGroupId to toGroupId's position
      const fromIdx = groupOrder.indexOf(fromGroupId);
      const toIdx = groupOrder.indexOf(toGroupId);
      if (fromIdx === -1 || toIdx === -1) return state;

      groupOrder.splice(fromIdx, 1);
      groupOrder.splice(toIdx, 0, fromGroupId);

      // Rebuild terminals array in new group order
      const reordered: Terminal[] = [];
      for (const gid of groupOrder) {
        reordered.push(...inProject.filter((t) => t.groupId === gid));
      }

      return { terminals: [...others, ...reordered] };
    });
  },

  reorderTerminalsInGroup: (fromTerminalId: string, toTerminalId: string) => {
    if (fromTerminalId === toTerminalId) return;
    set((state) => {
      const fromIdx = state.terminals.findIndex((t) => t.id === fromTerminalId);
      const toIdx = state.terminals.findIndex((t) => t.id === toTerminalId);
      if (fromIdx === -1 || toIdx === -1) return state;
      // Must be in the same group
      if (state.terminals[fromIdx].groupId !== state.terminals[toIdx].groupId) return state;

      const updated = [...state.terminals];
      const [moved] = updated.splice(fromIdx, 1);
      updated.splice(toIdx, 0, moved);
      return { terminals: updated };
    });
  },

  startTimer: (id: string) => {
    const today = new Date().toISOString().slice(0, 10);
    set((state) => ({
      terminals: state.terminals.map((t) => {
        if (t.id !== id) return t;
        const prev = t.timeTracking;
        // Reset todayMs if the date changed since last tracking
        const todayMs = prev?.todayDate === today ? (prev.todayMs || 0) : 0;
        return {
          ...t,
          timeTracking: {
            startedAt: Date.now(),
            elapsed: prev?.elapsed || 0,
            todayMs,
            todayDate: today,
          },
        };
      }),
    }));
  },

  stopTimer: (id: string): StopTimerResult | null => {
    const terminal = get().terminals.find((t) => t.id === id);
    if (!terminal?.timeTracking?.startedAt) return null;

    const now = Date.now();
    const sessionStartMs = terminal.timeTracking.startedAt;
    const sessionMs = now - sessionStartMs;
    const totalElapsed = terminal.timeTracking.elapsed + sessionMs;

    // Compute today's portion of this session
    const today = new Date().toISOString().slice(0, 10);
    const todayMidnight = new Date(now).setHours(0, 0, 0, 0);
    const sessionTodayMs = Math.max(0, now - Math.max(sessionStartMs, todayMidnight));
    const prevTodayMs = terminal.timeTracking.todayDate === today ? (terminal.timeTracking.todayMs || 0) : 0;

    const updated: TimeTracking = {
      startedAt: null,
      elapsed: totalElapsed,
      todayMs: prevTodayMs + sessionTodayMs,
      todayDate: today,
    };

    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, timeTracking: updated } : t
      ),
    }));

    return {
      ...updated,
      sessionStartMs,
      sessionEndMs: now,
    };
  },

  writeToTerminal: (terminalId: string, data: string) => {
    const callback = xtermCallbacks.get(terminalId);
    if (callback) {
      try { callback(data); } catch { }
    }
    const tap = outputTaps.get(terminalId);
    if (tap) {
      try { tap(data); } catch { }
    }
  },

  restoreState: async () => {
    try {
      const result = await window.electronAPI.loadTerminalState();
      if (!result.success || !result.data) {
        set({ isRestored: true });
        return [];
      }

      const saved = result.data;
      if (!saved.terminals || saved.terminals.length === 0) {
        set({ isRestored: true });
        return [];
      }

      // Load saved output buffers from previous session
      try {
        const buffersResult = await window.electronAPI.loadTerminalBuffers();
        if (buffersResult.success && buffersResult.data) {
          for (const [id, buffer] of Object.entries(buffersResult.data)) {
            savedOutputBuffers.set(id, buffer as string);
          }
        }
      } catch { /* non-critical — terminals restore without history */ }

      // Restore all saved terminals. Agent terminals with a session get
      // needsRestore so the RestoreBanner handles activation. Plain shell
      // terminals get needsRestore=false so their PTY is created automatically.
      const restored: Terminal[] = saved.terminals
        .map((t: any) => {
          // Support both new agentSessionId and legacy claudeSessionId from old saves
          const sessionId = t.agentSessionId || t.claudeSessionId;
          const isAgent = !!(sessionId || t.isClaudeMode);
          return {
            id: t.id,
            groupId: t.groupId,
            title: t.title,
            status: 'idle' as TerminalStatus,
            cwd: t.cwd || '',
            createdAt: new Date(),
            isClaudeMode: false,
            // Migrate legacy copilotProvider → agentProvider
            agentProvider: t.agentProvider || t.copilotProvider || 'claude',
            agentSessionId: sessionId,
            claudeCwd: t.claudeCwd,
            skipPermissions: t.skipPermissions || false,
            projectId: t.projectId,
            // Support both legacy clickUpTask and new task field
            task: t.task || (t.clickUpTask ? { ...t.clickUpTask, provider: 'clickup' as const } : undefined),
            worktreePath: t.worktreePath,
            worktreeBranch: t.worktreeBranch,
            baseBranch: t.baseBranch,
            timeTracking: t.timeTracking,
            previewUrl: t.previewUrl,
            needsRestore: isAgent,
          };
        });

      set({
        terminals: restored,
        activeTerminalId: saved.activeTerminalId,
        activeGroupId: saved.activeGroupId,
        isRestored: true,
      });

      // Auto-create PTYs for plain shell terminals so they open like new terminals
      for (const t of restored) {
        if (!t.needsRestore) {
          window.electronAPI.createTerminal({
            id: t.id,
            cwd: t.cwd || '',
            cols: 80,
            rows: 24,
          }).catch(() => { /* non-critical */ });
        }
      }

      // Refresh task status colors from API so tabs reflect current status
      for (const t of restored) {
        if (!t.task) continue;
        window.electronAPI.getTaskManagerTask(t.task.id).then((res: any) => {
          if (!res.success || !res.data) return;
          const task = res.data;
          const newStatus = task.status.name;
          const newColor = task.status.color;
          const current = get().terminals.find((x) => x.id === t.id);
          if (current?.task && (newStatus !== current.task.status || newColor !== current.task.statusColor)) {
            set((state) => ({
              terminals: state.terminals.map((x) =>
                x.id === t.id ? { ...x, task: { ...x.task!, status: newStatus, statusColor: newColor } } : x
              ),
            }));
          }
        }).catch(() => {});
      }

      return restored;
    } catch {
      set({ isRestored: true });
      return [];
    }
  },

  activateTerminal: async (id: string) => {
    const terminal = get().terminals.find((t) => t.id === id);
    if (!terminal || !terminal.needsRestore) return;

    try {
      await window.electronAPI.createTerminal({
        id: terminal.id,
        cwd: terminal.cwd || '',
        cols: 80,
        rows: 24,
      });

      const hasSession = !!terminal.agentSessionId;
      const isAgentTerminal = hasSession || terminal.agentProvider !== 'claude';

      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? {
            ...t,
            needsRestore: false,
            needsResume: false,
            isClaudeMode: isAgentTerminal,
            isResuming: isAgentTerminal,
            status: isAgentTerminal ? 'claude-active' as TerminalStatus : 'idle' as TerminalStatus,
          } : t
        ),
      }));

      // Auto-resume agent session if it was an agent terminal
      if (isAgentTerminal) {
        const agentId = terminal.agentProvider || 'claude';
        const project = terminal.projectId
          ? useProjectStore.getState().projects.find((p) => p.id === terminal.projectId)
          : undefined;

        // Native worktree path — Claude finds the session itself when given
        // --worktree <name>. Skip the cwd probe in that case.
        const taskWorktreeName = terminal.task && agentId === 'claude'
          ? (terminal.task.customId || terminal.task.id).replace(/[^a-zA-Z0-9_-]/g, '-')
          : undefined;

        // Legacy probe — for sessions still living under .task-worktrees/<id>
        // or some other historical cwd. If the session file is locatable
        // from a candidate cwd, resume there with `cd && claude --resume`.
        const legacyResolved = taskWorktreeName
          ? null
          : await resolveSessionCwd(
              terminal.agentSessionId,
              buildSessionCandidates({
                agentCwd: terminal.claudeCwd,
                currentCwd: terminal.cwd,
                worktreePath: terminal.worktreePath,
                projectPath: project?.path,
              }),
            );

        if (legacyResolved && legacyResolved.cwd !== terminal.cwd) {
          set((state) => ({
            terminals: state.terminals.map((t) =>
              t.id === id ? { ...t, cwd: legacyResolved.cwd, claudeCwd: legacyResolved.cwd } : t
            ),
          }));
        }

        // Compose resume options:
        // - Native: project root cwd + worktreeName (Claude resolves session)
        // - Legacy resolved: cd into the resolved path, no --worktree
        // - Legacy unresolved: skip --resume so user lands in idle shell
        const resumeOptions = taskWorktreeName
          ? {
              sessionId: terminal.agentSessionId,
              cwd: project?.path || terminal.cwd,
              skipPermissions: terminal.skipPermissions,
              worktreeName: taskWorktreeName,
            }
          : legacyResolved || !terminal.agentSessionId
            ? {
                sessionId: terminal.agentSessionId,
                cwd: legacyResolved?.cwd || terminal.claudeCwd || terminal.cwd,
                skipPermissions: terminal.skipPermissions,
              }
            : null;
        try {
          if (!resumeOptions) {
            // No session findable — drop back to idle so the user can start fresh
            set((state) => ({
              terminals: state.terminals.map((t) =>
                t.id === id ? { ...t, isClaudeMode: false, isResuming: false, status: 'idle' as TerminalStatus } : t
              ),
            }));
            return;
          }
          await window.electronAPI.resumeAgent(terminal.id, agentId, resumeOptions);
          // Clear resuming overlay after delay (agent needs time to start + execute /resume)
          const delay = terminal.agentSessionId ? 5000 : 3000;
          setTimeout(() => {
            set((state) => ({
              terminals: state.terminals.map((t) =>
                t.id === id ? { ...t, isResuming: false } : t
              ),
            }));
          }, delay);
        } catch {
          // Resume failed — fall back to idle terminal with Start button
          set((state) => ({
            terminals: state.terminals.map((t) =>
              t.id === id ? { ...t, isClaudeMode: false, isResuming: false, status: 'idle' as TerminalStatus } : t
            ),
          }));
        }
      }
    } catch {
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, needsRestore: false, status: 'exited' as TerminalStatus } : t
        ),
      }));
    }
  },

  resumeTerminalAgent: async (id: string) => {
    const terminal = get().terminals.find((t) => t.id === id);
    if (!terminal || !terminal.needsResume) return;

    try {
      const agentId = terminal.agentProvider || 'claude';
      const project = terminal.projectId
        ? useProjectStore.getState().projects.find((p) => p.id === terminal.projectId)
        : undefined;

      const taskWorktreeName = terminal.task && agentId === 'claude'
        ? (terminal.task.customId || terminal.task.id).replace(/[^a-zA-Z0-9_-]/g, '-')
        : undefined;

      // Native --worktree path: Claude finds the session itself.
      // Legacy: probe candidate cwds; if no match, drop back to idle.
      const legacyResolved = taskWorktreeName
        ? null
        : await resolveSessionCwd(
            terminal.agentSessionId,
            buildSessionCandidates({
              agentCwd: terminal.claudeCwd,
              currentCwd: terminal.cwd,
              worktreePath: terminal.worktreePath,
              projectPath: project?.path,
            }),
          );

      if (!taskWorktreeName && terminal.agentSessionId && !legacyResolved) {
        set((state) => ({
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, needsResume: false, isClaudeMode: false, status: 'idle' as TerminalStatus } : t
          ),
        }));
        return;
      }

      const resumeCwd = taskWorktreeName
        ? project?.path || terminal.cwd
        : legacyResolved?.cwd || terminal.claudeCwd || terminal.cwd;

      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? {
            ...t,
            needsResume: false,
            status: 'claude-active' as TerminalStatus,
            ...(legacyResolved && legacyResolved.cwd !== t.cwd
              ? { cwd: legacyResolved.cwd, claudeCwd: legacyResolved.cwd }
              : {}),
          } : t
        ),
      }));

      await window.electronAPI.resumeAgent(terminal.id, agentId, {
        sessionId: terminal.agentSessionId,
        cwd: resumeCwd,
        skipPermissions: terminal.skipPermissions,
        worktreeName: taskWorktreeName,
      });
    } catch {
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, needsResume: false, status: 'exited' as TerminalStatus } : t
        ),
      }));
    }
  },

  discardTerminal: (id: string) => {
    xtermCallbacks.delete(id);
    set((state) => {
      const newTerminals = state.terminals.filter((t) => t.id !== id);
      let newActiveId = state.activeTerminalId;
      let newActiveGroupId = state.activeGroupId;

      if (state.activeTerminalId === id) {
        const last = newTerminals[newTerminals.length - 1];
        newActiveId = last?.id || null;
        newActiveGroupId = last?.groupId || null;
      }

      return { terminals: newTerminals, activeTerminalId: newActiveId, activeGroupId: newActiveGroupId };
    });
  },

  togglePreview: (id: string) => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, previewOpen: !t.previewOpen } : t
      ),
    }));
  },

  setPreviewUrl: (id: string, url: string) => {
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id ? { ...t, previewUrl: url } : t
      ),
    }));
  },
}));

// Auto-save on state changes (skip transient fields like isClaudeBusy)
let prevSnapshot = '';
useTerminalStore.subscribe((state) => {
  if (!state.isRestored) return;
  // Build a lightweight snapshot to avoid saving on every busy toggle
  const snap = JSON.stringify({
    ids: state.terminals.map((t) => t.id).join(','),
    groups: state.terminals.map((t) => t.groupId).join(','),
    titles: state.terminals.map((t) => t.title).join(','),
    cwds: state.terminals.map((t) => t.cwd).join(','),
    projects: state.terminals.map((t) => t.projectId || '').join(','),
    active: state.activeTerminalId,
    activeGroup: state.activeGroupId,
    claude: state.terminals.map((t) => `${t.isClaudeMode ? 1 : 0}:${t.agentSessionId || ''}:${t.agentProvider}`).join(','),
    worktrees: state.terminals.map((t) => t.worktreeBranch || '').join(','),
    tasks: state.terminals.map((t) => t.task ? `${t.task.id}:${t.task.statusColor}:${t.task.status}` : '').join(','),
    timers: state.terminals.map((t) => `${t.timeTracking?.startedAt || 0}:${t.timeTracking?.elapsed || 0}:${t.timeTracking?.todayMs || 0}:${t.timeTracking?.todayDate || ''}`).join(','),
    previews: state.terminals.map((t) => t.previewUrl || '').join(','),
  });
  if (snap !== prevSnapshot) {
    prevSnapshot = snap;
    debouncedSaveState(state);
  }
});
