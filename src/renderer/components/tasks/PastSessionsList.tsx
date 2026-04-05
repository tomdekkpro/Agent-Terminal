import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search, Bot, Play, GitBranch, MessageSquare,
  FolderOpen, RefreshCw, History,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminal-store';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import { cn } from '../../../shared/utils';
import type { ClaudeSessionEntry } from '../../../shared/types';

interface PastSessionsListProps {
  onNavigateToTerminal?: () => void;
}

function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function groupByDate(sessions: ClaudeSessionEntry[]): { label: string; sessions: ClaudeSessionEntry[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const week = new Date(today.getTime() - 7 * 86400000);
  const month = new Date(today.getTime() - 30 * 86400000);

  const groups: { label: string; sessions: ClaudeSessionEntry[] }[] = [
    { label: 'Today', sessions: [] },
    { label: 'Yesterday', sessions: [] },
    { label: 'Last 7 days', sessions: [] },
    { label: 'Last 30 days', sessions: [] },
    { label: 'Older', sessions: [] },
  ];

  for (const s of sessions) {
    const d = new Date(s.modified);
    if (d >= today) groups[0].sessions.push(s);
    else if (d >= yesterday) groups[1].sessions.push(s);
    else if (d >= week) groups[2].sessions.push(s);
    else if (d >= month) groups[3].sessions.push(s);
    else groups[4].sessions.push(s);
  }

  return groups.filter((g) => g.sessions.length > 0);
}

export function PastSessionsList({ onNavigateToTerminal }: PastSessionsListProps) {
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);
  const activeProject = useProjectStore((s) => {
    const id = s.activeProjectId;
    return id ? s.projects.find((p) => p.id === id) : undefined;
  });
  const settings = useSettingsStore((s) => s.settings);

  const [sessions, setSessions] = useState<ClaudeSessionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [resumingId, setResumingId] = useState<string | null>(null);

  const projectPath = activeProject?.path || settings.workingDirectory || '';

  const loadSessions = useCallback(async () => {
    if (!projectPath) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.claudeSessionsList(projectPath);
      if (result.success) {
        setSessions(result.data || []);
      } else {
        setError(result.error || 'Failed to load sessions');
      }
    } catch {
      setError('Failed to load sessions');
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter(
      (s) =>
        (s.summary || '').toLowerCase().includes(q) ||
        (s.firstPrompt || '').toLowerCase().includes(q) ||
        (s.gitBranch || '').toLowerCase().includes(q)
    );
  }, [sessions, searchQuery]);

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);

  const handleResume = useCallback(async (session: ClaudeSessionEntry) => {
    const cwd = projectPath || session.projectPath;
    setResumingId(session.sessionId);
    try {
      const terminal = addTerminal(cwd, activeProject?.id);
      if (!terminal) return;

      await window.electronAPI.createTerminal({
        id: terminal.id,
        cwd,
        cols: 80,
        rows: 24,
      });

      updateTerminal(terminal.id, {
        title: session.summary || session.firstPrompt?.slice(0, 40) || 'Resumed Session',
        isClaudeMode: true,
        agentSessionId: session.sessionId,
        claudeCwd: cwd,
        status: 'claude-active',
      });

      await window.electronAPI.resumeAgent(terminal.id, 'claude', {
        sessionId: session.sessionId,
        cwd,
      });

      onNavigateToTerminal?.();
    } catch {
      // Failed — terminal store will handle cleanup
    } finally {
      setResumingId(null);
    }
  }, [projectPath, activeProject, addTerminal, updateTerminal, onNavigateToTerminal]);

  return (
    <div className="flex flex-col h-full">
      {/* Search + refresh */}
      <div className="px-3 py-2 border-b border-[var(--border)]">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search past sessions..."
              className="w-full pl-8 pr-3 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
          <button
            onClick={loadSessions}
            disabled={isLoading}
            className="w-7 h-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} />
          </button>
        </div>
        {projectPath && (
          <div className="flex items-center gap-1 mt-1.5 text-[9px] text-[var(--text-muted)]">
            <FolderOpen className="w-2.5 h-2.5" />
            <span className="truncate">{projectPath}</span>
          </div>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-[var(--text-muted)]">
            <RefreshCw className="w-5 h-5 animate-spin opacity-40 mb-2" />
            <p className="text-xs">Loading sessions...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-32 text-[var(--text-muted)]">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-[var(--text-muted)]">
            <History className="w-6 h-6 opacity-30 mb-2" />
            <p className="text-xs">
              {sessions.length === 0 ? 'No past sessions found' : 'No matches'}
            </p>
            {sessions.length === 0 && (
              <p className="text-[10px] opacity-60 mt-1">Start a Claude session to see it here</p>
            )}
          </div>
        ) : (
          <div className="p-1.5">
            {grouped.map((group) => (
              <div key={group.label} className="mb-3">
                <div className="px-2 py-1 text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wider">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.sessions.map((session) => (
                    <div
                      key={session.sessionId}
                      className="px-2.5 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] border border-transparent hover:border-[var(--border)] transition-colors group/item"
                    >
                      <div className="flex items-start gap-2">
                        <Bot className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          {/* Summary / title */}
                          <div className="text-xs text-[var(--text-primary)] font-medium truncate">
                            {session.summary || session.firstPrompt?.slice(0, 60) || 'Untitled session'}
                          </div>

                          {/* First prompt preview */}
                          {session.summary && session.firstPrompt && (
                            <div className="text-[10px] text-[var(--text-muted)] truncate mt-0.5">
                              {session.firstPrompt.slice(0, 80)}
                            </div>
                          )}

                          {/* Meta row */}
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className="text-[9px] text-[var(--text-muted)] flex items-center gap-0.5">
                              <MessageSquare className="w-2.5 h-2.5" />
                              {session.messageCount}
                            </span>
                            {session.gitBranch && (
                              <span className="text-[9px] text-[var(--text-muted)] flex items-center gap-0.5 truncate max-w-[140px]">
                                <GitBranch className="w-2.5 h-2.5 shrink-0" />
                                {session.gitBranch}
                              </span>
                            )}
                            <span className="text-[9px] text-[var(--text-muted)]">
                              {formatSessionDate(session.modified)}
                            </span>
                          </div>
                        </div>

                        {/* Resume button */}
                        <button
                          onClick={() => handleResume(session)}
                          disabled={resumingId === session.sessionId}
                          className="shrink-0 opacity-0 group-hover/item:opacity-100 flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-400 text-[10px] font-medium hover:bg-emerald-500/25 transition-all disabled:opacity-60"
                        >
                          {resumingId === session.sessionId ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : (
                            <Play className="w-3 h-3" />
                          )}
                          Resume
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div className="px-2 py-3 text-center text-[10px] text-[var(--text-muted)] opacity-50">
              {filtered.length} session{filtered.length !== 1 ? 's' : ''}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
