import { useState, useEffect, useCallback, useRef } from 'react';
import {
  GitPullRequestDraft, RefreshCw, Play, CheckCircle2, XCircle,
  AlertTriangle, Loader2, ExternalLink, ChevronDown, ChevronRight,
  FolderOpen, Lightbulb, Bug, ShieldAlert, Info, Clock, Timer, Square, List,
} from 'lucide-react';
import { useCodeReviewStore } from '../../stores/code-review-store';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import type { CodeReviewItem, CodeReviewPR, CodeReviewFinding, CodeReviewSeverity, TaskManagerList } from '../../../shared/types';
import { cn } from '../../../shared/utils';

const SEVERITY_CONFIG: Record<CodeReviewSeverity, { icon: typeof Bug; color: string; bg: string; label: string }> = {
  critical: { icon: ShieldAlert, color: 'text-red-400', bg: 'bg-red-500/10', label: 'Critical' },
  major: { icon: AlertTriangle, color: 'text-orange-400', bg: 'bg-orange-500/10', label: 'Major' },
  minor: { icon: Info, color: 'text-yellow-400', bg: 'bg-yellow-500/10', label: 'Minor' },
  suggestion: { icon: Lightbulb, color: 'text-blue-400', bg: 'bg-blue-500/10', label: 'Suggestion' },
};

const STATUS_CONFIG: Record<string, { icon: typeof Loader2; color: string; label: string }> = {
  pending: { icon: GitPullRequestDraft, color: 'text-[var(--text-muted)]', label: 'Pending' },
  reviewing: { icon: Loader2, color: 'text-blue-400', label: 'Reviewing...' },
  passed: { icon: CheckCircle2, color: 'text-green-400', label: 'Passed' },
  failed: { icon: XCircle, color: 'text-red-400', label: 'Failed' },
  error: { icon: AlertTriangle, color: 'text-orange-400', label: 'Error' },
  skipped: { icon: GitPullRequestDraft, color: 'text-[var(--text-muted)]', label: 'Skipped' },
};

const INTERVAL_OPTIONS = [
  { value: 15, label: 'Every 15 min' },
  { value: 30, label: 'Every 30 min' },
  { value: 60, label: 'Every 1 hour' },
  { value: 120, label: 'Every 2 hours' },
  { value: 240, label: 'Every 4 hours' },
  { value: 480, label: 'Every 8 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Every 24 hours' },
];

/** Render text that may contain inline `code` or ```code blocks``` */
function RichText({ text, className }: { text: string; className?: string }) {
  // Split on fenced code blocks (```...```) and inline code (`...`)
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const code = part.slice(3, -3).replace(/^\w*\n/, ''); // strip language hint
          return (
            <pre key={i} className="mt-1.5 mb-1 p-2 rounded bg-[var(--bg-tertiary)] overflow-x-auto">
              <code className="text-xs text-[var(--text-primary)] font-mono whitespace-pre">{code}</code>
            </pre>
          );
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code key={i} className="text-xs bg-[var(--bg-tertiary)] px-1 py-0.5 rounded font-mono">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

function FindingCard({ finding }: { finding: CodeReviewFinding }) {
  const config = SEVERITY_CONFIG[finding.severity];
  const Icon = config.icon;

  return (
    <div className={cn('rounded-lg p-3 border border-[var(--border)]', config.bg)}>
      <div className="flex items-start gap-2">
        <Icon className={cn('w-4 h-4 mt-0.5 shrink-0', config.color)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={cn('text-xs font-medium', config.color)}>{config.label}</span>
            <code className="text-xs text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">
              {finding.file}{finding.line ? `:${finding.line}` : ''}
            </code>
          </div>
          <RichText text={finding.description} className="text-sm text-[var(--text-primary)] leading-relaxed" />
          {finding.suggestion && (
            <div className="mt-2 p-2 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border)]">
              <div className="flex items-center gap-1.5 mb-1">
                <Lightbulb className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <span className="text-xs font-medium text-blue-400">Suggested Fix</span>
              </div>
              <RichText text={finding.suggestion} className="text-xs text-[var(--text-secondary)] leading-relaxed" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return (
    <span className={cn(
      'text-xs px-2 py-1 rounded-full font-medium',
      status === 'passed' && 'bg-green-500/10 text-green-400',
      status === 'failed' && 'bg-red-500/10 text-red-400',
      status === 'reviewing' && 'bg-blue-500/10 text-blue-400',
      status === 'error' && 'bg-orange-500/10 text-orange-400',
      status === 'pending' && 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
      status === 'skipped' && 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
    )}>
      {config.label}
    </span>
  );
}

function PRRow({
  pr,
  taskId,
  onReview,
  onStop,
}: {
  pr: CodeReviewPR;
  taskId: string;
  onReview: (taskId: string, prNumber: number) => void;
  onStop: (taskId: string, prNumber: number) => void;
}) {
  const [expanded, setExpanded] = useState(pr.status === 'failed');
  const status = STATUS_CONFIG[pr.status] || STATUS_CONFIG.pending;
  const StatusIcon = status.icon;
  const isReviewing = pr.status === 'reviewing';

  const criticals = pr.findings.filter((f) => f.severity === 'critical').length;
  const majors = pr.findings.filter((f) => f.severity === 'major').length;
  const minors = pr.findings.filter((f) => f.severity === 'minor').length;
  const suggestions = pr.findings.filter((f) => f.severity === 'suggestion').length;

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--bg-primary)] overflow-hidden">
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <StatusIcon className={cn('w-3.5 h-3.5 shrink-0', status.color, isReviewing && 'animate-spin')} />
            <span className="text-xs font-medium text-[var(--text-primary)]">PR #{pr.prNumber}</span>
            {pr.prTitle && <span className="text-xs text-[var(--text-muted)] truncate">{pr.prTitle}</span>}
            {pr.prBranch && <code className="text-[10px] text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">{pr.prBranch}</code>}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={pr.status} />

            {pr.status === 'pending' && (
              <button
                onClick={() => onReview(taskId, pr.prNumber)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
              >
                <Play className="w-3 h-3" />
                Review
              </button>
            )}

            {pr.status === 'reviewing' && (
              <button
                onClick={() => onStop(taskId, pr.prNumber)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
              >
                <Square className="w-3 h-3" />
                Stop
              </button>
            )}

            {pr.prUrl && (
              <button
                onClick={() => window.electronAPI.openExternal(pr.prUrl!)}
                title="Open PR on GitHub"
                className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {pr.findings.length > 0 && (
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {pr.findings.length} issue{pr.findings.length !== 1 ? 's' : ''}
            </button>
            <div className="flex items-center gap-2 text-[11px]">
              {criticals > 0 && <span className="text-red-400">{criticals} critical</span>}
              {majors > 0 && <span className="text-orange-400">{majors} major</span>}
              {minors > 0 && <span className="text-yellow-400">{minors} minor</span>}
              {suggestions > 0 && <span className="text-blue-400">{suggestions} suggestion{suggestions !== 1 ? 's' : ''}</span>}
            </div>
          </div>
        )}

        {pr.error && (
          <div className="mt-2 flex items-center gap-2 text-xs text-red-400 bg-red-500/10 rounded-md px-2.5 py-1.5">
            <XCircle className="w-3 h-3 shrink-0" />
            {pr.error}
          </div>
        )}
      </div>

      {expanded && pr.findings.length > 0 && (
        <div className="border-t border-[var(--border)] p-3 space-y-2 bg-[var(--bg-secondary)]">
          {pr.findings.map((finding, idx) => (
            <FindingCard key={idx} finding={finding} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewItemCard({
  item,
  onReview,
  onStop,
}: {
  item: CodeReviewItem;
  projectPath: string;
  onReview: (taskId: string, prNumber: number) => void;
  onStop: (taskId: string, prNumber: number) => void;
}) {
  const status = STATUS_CONFIG[item.status] || STATUS_CONFIG.pending;
  const StatusIcon = status.icon;
  const isReviewing = item.status === 'reviewing';
  const hasPRs = item.prs && item.prs.length > 0;

  return (
    <div className="border border-[var(--border)] rounded-xl bg-[var(--bg-secondary)] overflow-hidden">
      <div className="p-4">
        {/* Task header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <StatusIcon className={cn('w-4 h-4 shrink-0', status.color, isReviewing && 'animate-spin')} />
              <h3 className="text-sm font-medium text-[var(--text-primary)] truncate">{item.taskName}</h3>
            </div>
            <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
              {item.customId && <span className="font-mono">{item.customId}</span>}
              {hasPRs && (
                <span className="flex items-center gap-1">
                  <GitPullRequestDraft className="w-3 h-3" />
                  {item.prs.length} PR{item.prs.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={item.status} />
            <button
              onClick={() => window.electronAPI.openExternal(item.taskUrl)}
              title="Open task in ClickUp"
              className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* No PRs warning */}
        {!hasPRs && item.status === 'pending' && (
          <div className="mt-3 flex items-center gap-2 text-xs text-orange-400 bg-orange-500/10 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            No open PR found. Add a GitHub PR URL to the task description.
          </div>
        )}

        {/* PR list */}
        {hasPRs && (
          <div className="mt-3 space-y-2">
            {item.prs.map((pr) => (
              <PRRow
                key={pr.prNumber}
                pr={pr}
                taskId={item.taskId}
                onReview={onReview}
                onStop={onStop}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Scheduler Panel ──────────────────────────────────────────
function SchedulerPanel({ projectPath }: { projectPath: string }) {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const projects = useProjectStore((s) => s.projects);

  const [schedulerStatus, setSchedulerStatus] = useState<{
    active: boolean;
    running: boolean;
    lastRun: string | null;
    nextRun: string | null;
    intervalMinutes: number;
  } | null>(null);

  const [expanded, setExpanded] = useState(false);

  // Poll scheduler status
  useEffect(() => {
    const fetchStatus = () => {
      window.electronAPI.codeReviewSchedulerStatus?.().then((res: any) => {
        if (res.success) setSchedulerStatus(res.data);
      });
    };
    fetchStatus();
    const timer = setInterval(fetchStatus, 10_000);
    return () => clearInterval(timer);
  }, []);

  const handleToggleScheduler = async () => {
    if (schedulerStatus?.active) {
      await window.electronAPI.codeReviewSchedulerStop?.();
      await updateSettings({ codeReviewEnabled: false });
    } else {
      // Save settings first, then start
      await updateSettings({
        codeReviewEnabled: true,
        codeReviewProjectPath: settings.codeReviewProjectPath || projectPath,
      });
      await window.electronAPI.codeReviewSchedulerStart?.();
    }
    // Refresh status
    const res = await window.electronAPI.codeReviewSchedulerStatus?.();
    if (res?.success) setSchedulerStatus(res.data);
  };

  const handleSettingChange = async (key: string, value: any) => {
    await updateSettings({ [key]: value });
    // Restart scheduler if active to pick up new settings
    if (schedulerStatus?.active) {
      await window.electronAPI.codeReviewSchedulerStop?.();
      await window.electronAPI.codeReviewSchedulerStart?.();
      const res = await window.electronAPI.codeReviewSchedulerStatus?.();
      if (res?.success) setSchedulerStatus(res.data);
    }
  };

  const isActive = schedulerStatus?.active || false;
  const isRunning = schedulerStatus?.running || false;

  const formatTime = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatRelative = (iso: string | null) => {
    if (!iso) return '';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms < 0) return 'now';
    const min = Math.round(ms / 60_000);
    if (min < 1) return '<1 min';
    if (min < 60) return `${min} min`;
    const hrs = Math.floor(min / 60);
    const remainMin = min % 60;
    return remainMin > 0 ? `${hrs}h ${remainMin}m` : `${hrs}h`;
  };

  return (
    <div className="border border-[var(--border)] rounded-xl bg-[var(--bg-secondary)] overflow-hidden">
      {/* Compact header — always visible */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } }}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-[var(--bg-tertiary)]/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center',
            isActive ? 'bg-green-500/10' : 'bg-[var(--bg-tertiary)]',
          )}>
            <Timer className={cn('w-4 h-4', isActive ? 'text-green-400' : 'text-[var(--text-muted)]')} />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">Auto Review</span>
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wider',
                isActive
                  ? isRunning ? 'bg-blue-500/10 text-blue-400' : 'bg-green-500/10 text-green-400'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
              )}>
                {isActive ? (isRunning ? 'Running' : 'Active') : 'Off'}
              </span>
            </div>
            {isActive && (
              <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)] mt-0.5">
                {schedulerStatus?.lastRun && <span>Last: {formatTime(schedulerStatus.lastRun)}</span>}
                {schedulerStatus?.nextRun && <span>Next: {formatRelative(schedulerStatus.nextRun)}</span>}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Quick toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); handleToggleScheduler(); }}
            className={cn(
              'relative w-10 h-5 rounded-full transition-colors duration-200',
              isActive ? 'bg-green-500' : 'bg-[var(--bg-tertiary)]',
            )}
          >
            <div className={cn(
              'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 shadow-sm',
              isActive ? 'translate-x-5' : 'translate-x-0.5',
            )} />
          </button>
          {expanded ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" /> : <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />}
        </div>
      </div>

      {/* Expanded settings */}
      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-4 space-y-4 bg-[var(--bg-primary)]">
          {/* Interval */}
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Review Interval</label>
            <select
              value={settings.codeReviewIntervalMinutes || 60}
              onChange={(e) => handleSettingChange('codeReviewIntervalMinutes', parseInt(e.target.value, 10))}
              className="w-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Project path */}
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Project (for gh CLI)</label>
            <select
              value={settings.codeReviewProjectPath || ''}
              onChange={(e) => handleSettingChange('codeReviewProjectPath', e.target.value)}
              className="w-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="">Select project...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.path}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Task statuses */}
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Task Statuses (comma-separated)</label>
            <input
              type="text"
              value={settings.codeReviewStatuses || 'ready for review, in review, review'}
              onChange={(e) => handleSettingChange('codeReviewStatuses', e.target.value)}
              placeholder="ready for review, in review, review"
              className="w-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] placeholder:text-[var(--text-muted)]"
            />
          </div>

          {/* Tag name */}
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1.5">Pass Tag Name</label>
            <input
              type="text"
              value={settings.codeReviewTagName || 'reviewpass'}
              onChange={(e) => handleSettingChange('codeReviewTagName', e.target.value)}
              placeholder="reviewpass"
              className="w-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] placeholder:text-[var(--text-muted)]"
            />
            <p className="text-[11px] text-[var(--text-muted)] mt-1">Tag added to tasks that pass review. Must exist in ClickUp space.</p>
          </div>

          {/* Status info */}
          {isActive && (
            <div className="flex items-center gap-4 text-xs text-[var(--text-muted)] pt-2 border-t border-[var(--border)]">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span>Interval: {INTERVAL_OPTIONS.find((o) => o.value === (schedulerStatus?.intervalMinutes || 60))?.label || `${schedulerStatus?.intervalMinutes}m`}</span>
              </div>
              {schedulerStatus?.lastRun && (
                <span>Last run: {formatTime(schedulerStatus.lastRun)}</span>
              )}
              {schedulerStatus?.nextRun && (
                <span>Next in: {formatRelative(schedulerStatus.nextRun)}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main View ────────────────────────────────────────────────
export function CodeReviewView() {
  const store = useCodeReviewStore();
  const { items, loading, error, reviewingAll, loadTasks, runReview, runAllReviews, stopReview, stopAllReviews } = store;

  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const taskManagerProvider = useSettingsStore((s) => s.settings.taskManagerProvider);

  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null);
  const [customStatuses, setCustomStatuses] = useState('ready for review, in review, review');

  // List dropdown state
  const [lists, setLists] = useState<TaskManagerList[]>([]);
  const [selectedListId, setSelectedListId] = useState<string>('');
  const [showListDropdown, setShowListDropdown] = useState(false);
  const listDropdownRef = useRef<HTMLDivElement>(null);

  // Group lists by space for the dropdown
  const listsBySpace = lists.reduce<Record<string, TaskManagerList[]>>((acc, list) => {
    const space = list.space || 'Lists';
    if (!acc[space]) acc[space] = [];
    acc[space].push(list);
    return acc;
  }, {});

  const selectedList = lists.find((l) => l.id === selectedListId);

  // Close list dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (listDropdownRef.current && !listDropdownRef.current.contains(e.target as Node)) {
        setShowListDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Fetch lists on mount
  useEffect(() => {
    if (taskManagerProvider === 'none') return;
    window.electronAPI.getTaskManagerLists().then((result: any) => {
      if (result.success && result.data) {
        setLists(result.data);
        if (result.data.length > 0) {
          const settings = useSettingsStore.getState().settings;
          const defaultId = settings.clickupListId || result.data[0].id;
          const exists = result.data.some((l: TaskManagerList) => l.id === defaultId);
          setSelectedListId(exists ? defaultId : result.data[0].id);
        }
      }
    });
  }, [taskManagerProvider]);

  useEffect(() => {
    if (!selectedProjectPath && activeProjectId) {
      const proj = projects.find((p) => p.id === activeProjectId);
      if (proj) setSelectedProjectPath(proj.path);
    }
  }, [activeProjectId, projects, selectedProjectPath]);

  useEffect(() => {
    const unsub = window.electronAPI.onCodeReviewEvent?.((event: any) => {
      // Use getState() to avoid stale closure — ensures store updates trigger re-renders
      useCodeReviewStore.getState().handleEvent(event);
    });
    return () => { unsub?.(); };
  }, []);

  // Auto-load tasks when the view is opened and a project + list are selected
  useEffect(() => {
    if (selectedProjectPath && selectedListId && taskManagerProvider !== 'none' && items.length === 0 && !loading) {
      const statuses = customStatuses.split(',').map((s) => s.trim()).filter(Boolean);
      loadTasks(statuses, selectedProjectPath, selectedListId);
    }
  }, [selectedProjectPath, selectedListId, taskManagerProvider]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoadTasks = useCallback(() => {
    const statuses = customStatuses.split(',').map((s) => s.trim()).filter(Boolean);
    loadTasks(statuses, selectedProjectPath || undefined, selectedListId || undefined);
  }, [customStatuses, selectedProjectPath, selectedListId, loadTasks]);

  const handleReview = useCallback((taskId: string, prNumber: number) => {
    if (!selectedProjectPath) return;
    runReview(selectedProjectPath, taskId, prNumber);
  }, [selectedProjectPath, runReview]);

  const handleReviewAll = useCallback(() => {
    if (!selectedProjectPath) return;
    runAllReviews(selectedProjectPath);
  }, [selectedProjectPath, runAllReviews]);

  const handleStop = useCallback((taskId: string, prNumber?: number) => {
    stopReview(taskId, prNumber);
  }, [stopReview]);

  const handleStopAll = useCallback(() => {
    stopAllReviews();
  }, [stopAllReviews]);

  const projectPath = selectedProjectPath || '';
  const allPRs = items.flatMap((i) => i.prs || []);
  const reviewableCount = allPRs.filter((p) => p.status === 'pending').length;
  const reviewingCount = allPRs.filter((p) => p.status === 'reviewing').length;
  const passedCount = allPRs.filter((p) => p.status === 'passed').length;
  const failedCount = allPRs.filter((p) => p.status === 'failed').length;

  // Not configured
  if (taskManagerProvider === 'none') {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md">
          <GitPullRequestDraft className="w-12 h-12 text-[var(--text-muted)] mx-auto mb-4" />
          <h2 className="text-lg font-medium text-[var(--text-primary)] mb-2">Code Review</h2>
          <p className="text-sm text-[var(--text-muted)] mb-4">
            Connect ClickUp in Settings to load tasks ready for review.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-[var(--border)] bg-[var(--bg-secondary)] px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <GitPullRequestDraft className="w-5 h-5 text-purple-400" />
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Code Review</h1>
            {items.length > 0 && (
              <span className="text-xs text-[var(--text-muted)] bg-[var(--bg-tertiary)] px-2 py-0.5 rounded-full">
                {items.length} task{items.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {(reviewingAll || reviewingCount > 0) && (
              <button
                onClick={handleStopAll}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
              >
                <Square className="w-4 h-4" />
                Stop All{reviewingCount > 0 ? ` (${reviewingCount})` : ''}
              </button>
            )}
            {reviewableCount > 0 && (
              <button
                onClick={handleReviewAll}
                disabled={reviewingAll || !projectPath}
                className={cn(
                  'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                  reviewingAll
                    ? 'bg-blue-500/20 text-blue-400 cursor-not-allowed'
                    : 'bg-purple-500 text-white hover:bg-purple-600',
                )}
              >
                {reviewingAll ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Reviewing...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Review All ({reviewableCount})
                  </>
                )}
              </button>
            )}
            <button
              onClick={handleLoadTasks}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors"
            >
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
              {loading ? 'Loading...' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Manual controls row */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Project selector */}
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-[var(--text-muted)]" />
            <select
              value={selectedProjectPath || ''}
              onChange={(e) => setSelectedProjectPath(e.target.value || null)}
              className="text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="">Select project...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.path}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* List selector dropdown */}
          {lists.length > 0 && (
            <div className="relative" ref={listDropdownRef}>
              <button
                onClick={() => setShowListDropdown(!showListDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors min-w-[160px]"
              >
                <List className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
                <span className="truncate max-w-[200px]">
                  {selectedList ? selectedList.name : 'Select list...'}
                </span>
                <ChevronDown className={cn('w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform ml-auto', showListDropdown && 'rotate-180')} />
              </button>

              {showListDropdown && (
                <div className="absolute z-50 top-full left-0 mt-1 min-w-[240px] max-h-64 overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl">
                  {Object.entries(listsBySpace).map(([space, spaceLists]) => (
                    <div key={space}>
                      {Object.keys(listsBySpace).length > 1 && (
                        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-secondary)] sticky top-0">
                          {space}
                        </div>
                      )}
                      {spaceLists.map((list) => (
                        <button
                          key={list.id}
                          onClick={() => {
                            setSelectedListId(list.id);
                            setShowListDropdown(false);
                          }}
                          className={cn(
                            'w-full text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--bg-tertiary)]',
                            list.id === selectedListId && 'bg-[var(--accent)]/10 text-[var(--accent)]',
                          )}
                        >
                          <span>{list.name}</span>
                          {list.folder && (
                            <span className="text-[10px] text-[var(--text-muted)] ml-2">{list.folder}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Status filter */}
          <div className="flex-1 min-w-[180px]">
            <input
              type="text"
              value={customStatuses}
              onChange={(e) => setCustomStatuses(e.target.value)}
              placeholder="Task statuses (comma-separated)"
              className="w-full text-sm bg-[var(--bg-tertiary)] text-[var(--text-primary)] border border-[var(--border)] rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] placeholder:text-[var(--text-muted)]"
            />
          </div>

          <button
            onClick={handleLoadTasks}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg text-sm bg-[var(--accent)] text-white hover:opacity-90 transition-opacity shrink-0"
          >
            Load Tasks
          </button>
        </div>

        {/* Stats bar */}
        {items.length > 0 && (
          <div className="flex items-center gap-4 mt-3 text-xs text-[var(--text-muted)]">
            <span>{items.length} total</span>
            <span>{reviewableCount} reviewable</span>
            {reviewingCount > 0 && <span className="text-blue-400">{reviewingCount} reviewing</span>}
            {passedCount > 0 && <span className="text-green-400">{passedCount} passed</span>}
            {failedCount > 0 && <span className="text-red-400">{failedCount} failed</span>}
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 text-sm text-red-400 bg-red-500/10 rounded-lg px-4 py-3 border border-red-500/20">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {/* Scheduler panel — always at top */}
        <SchedulerPanel projectPath={projectPath} />

        {/* Task list */}
        {items.length === 0 && !loading && !error && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <GitPullRequestDraft className="w-10 h-10 text-[var(--text-muted)] mb-3" />
            <p className="text-sm text-[var(--text-muted)] mb-1">No tasks loaded</p>
            <p className="text-xs text-[var(--text-muted)]">
              Click "Load Tasks" to fetch tasks manually, or enable Auto Review above to run on a schedule.
            </p>
          </div>
        )}

        {loading && items.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 text-[var(--accent)] animate-spin" />
          </div>
        )}

        <div className="space-y-3">
          {items.map((item) => (
            <ReviewItemCard
              key={item.taskId}
              item={item}
              projectPath={projectPath}
              onReview={handleReview}
              onStop={handleStop}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
