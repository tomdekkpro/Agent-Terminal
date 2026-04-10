import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, RefreshCw, FileText, FilePlus, FileMinus, FileEdit, File,
  GitCommitVertical, ChevronDown, ChevronRight, Loader2, FolderOpen,
} from 'lucide-react';
import { cn } from '../../../shared/utils';

interface DiffFile {
  path: string;
  status: string; // 'modified' | 'added' | 'deleted' | 'untracked' | 'staged'
  diff: string;
}

interface DiffData {
  uncommitted: DiffFile[];
  branch: DiffFile[];
  commits: string[];
  currentBranch: string;
  baseBranch: string;
}

interface ChangesPanelProps {
  cwd: string;
  baseBranch?: string;
  onClose: () => void;
  autoRefreshTrigger?: number;
}

const STATUS_CONFIG: Record<string, { icon: typeof File; color: string; label: string }> = {
  modified: { icon: FileEdit, color: 'text-amber-400', label: 'M' },
  added: { icon: FilePlus, color: 'text-emerald-400', label: 'A' },
  deleted: { icon: FileMinus, color: 'text-red-400', label: 'D' },
  untracked: { icon: FilePlus, color: 'text-blue-400', label: 'U' },
  staged: { icon: FileEdit, color: 'text-emerald-400', label: 'S' },
};

function getFileName(path: string): string {
  return path.split('/').pop() || path;
}

function getFileDir(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

/** Render a unified diff with +/- coloring */
function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="text-[10px] text-[var(--text-muted)] italic px-3 py-2">No diff available (new untracked file)</div>;

  const lines = diff.split('\n');
  return (
    <div className="font-mono text-[10px] leading-[18px]">
      {lines.map((line, i) => {
        let cls = 'text-[var(--text-secondary)]';
        let bg = '';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          cls = 'text-emerald-400';
          bg = 'bg-emerald-500/10';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          cls = 'text-red-400';
          bg = 'bg-red-500/10';
        } else if (line.startsWith('@@')) {
          cls = 'text-cyan-400';
          bg = 'bg-cyan-500/5';
        } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          cls = 'text-[var(--text-muted)]';
        }
        return (
          <div key={i} className={cn('px-3 whitespace-pre', bg)}>
            <span className={cls}>{line}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ChangesPanel({ cwd, baseBranch, onClose, autoRefreshTrigger }: ChangesPanelProps) {
  const [data, setData] = useState<DiffData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<DiffFile | null>(null);
  const [showBranch, setShowBranch] = useState(true);
  const [showUncommitted, setShowUncommitted] = useState(true);
  const [showCommits, setShowCommits] = useState(false);
  const prevTrigger = useRef(autoRefreshTrigger);

  const loadDiff = useCallback(async () => {
    if (!cwd) return;
    setLoading(true);
    try {
      const result = await window.electronAPI.getDiffFiles(cwd, baseBranch);
      if (result?.success) setData(result.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [cwd, baseBranch]);

  useEffect(() => { loadDiff(); }, [loadDiff]);

  // Auto-refresh when agent finishes (trigger increments)
  useEffect(() => {
    if (autoRefreshTrigger != null && autoRefreshTrigger !== prevTrigger.current) {
      prevTrigger.current = autoRefreshTrigger;
      loadDiff();
    }
  }, [autoRefreshTrigger, loadDiff]);

  const allFiles = [
    ...(data?.uncommitted || []),
    ...(data?.branch || []).filter((bf) =>
      !data?.uncommitted?.some((uf) => uf.path === bf.path),
    ),
  ];

  const uncommittedCount = data?.uncommitted?.length || 0;
  const branchCount = data?.branch?.length || 0;
  const commitCount = data?.commits?.length || 0;

  const renderFileItem = (file: DiffFile, source: string) => {
    const cfg = STATUS_CONFIG[file.status] || STATUS_CONFIG.modified;
    const Icon = cfg.icon;
    const isSelected = selectedFile?.path === file.path && selectedFile?.status === file.status;
    const dir = getFileDir(file.path);

    return (
      <div
        key={`${source}:${file.path}`}
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 cursor-pointer transition-colors text-xs',
          isSelected
            ? 'bg-[var(--accent)]/10 border-l-2 border-[var(--accent)]'
            : 'hover:bg-[var(--bg-tertiary)] border-l-2 border-transparent',
        )}
        onClick={() => setSelectedFile(isSelected ? null : file)}
      >
        <Icon className={cn('w-3.5 h-3.5 shrink-0', cfg.color)} />
        <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]">
          {getFileName(file.path)}
        </span>
        {dir && (
          <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[120px] shrink-0">{dir}</span>
        )}
        <span className={cn('text-[10px] font-mono shrink-0', cfg.color)}>{cfg.label}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)] border-l border-[var(--border)]">
      {/* Toolbar */}
      <div className="h-9 bg-[var(--bg-card)] border-b border-[var(--border)] flex items-center px-2 gap-1 shrink-0">
        <GitCommitVertical className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
        <span className="text-[11px] text-[var(--text-primary)] font-medium flex-1 truncate">Changes</span>
        {allFiles.length > 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">{allFiles.length} files</span>
        )}
        <button
          onClick={loadDiff}
          className="w-6 h-6 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          title="Refresh"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
        <button
          onClick={onClose}
          className="w-6 h-6 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
          title="Close"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Branch info */}
      {data && (
        <div className="px-2 py-1 border-b border-[var(--border)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-muted)] flex items-center gap-1">
          <span className="font-mono">{data.currentBranch}</span>
          {data.baseBranch && data.baseBranch !== data.currentBranch && (
            <>
              <span className="opacity-40">&larr;</span>
              <span className="font-mono opacity-60">{data.baseBranch}</span>
            </>
          )}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center py-8 text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">
          {/* File list */}
          <div className={cn('overflow-y-auto', selectedFile ? 'max-h-[45%]' : 'flex-1')}>
            {/* Uncommitted section */}
            {uncommittedCount > 0 && (
              <>
                <div
                  className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer hover:bg-[var(--bg-tertiary)]"
                  onClick={() => setShowUncommitted((v) => !v)}
                >
                  {showUncommitted ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <span>Uncommitted Changes</span>
                  <span className="ml-auto text-amber-400 font-mono">{uncommittedCount}</span>
                </div>
                {showUncommitted && data?.uncommitted.map((f) => renderFileItem(f, 'uncommitted'))}
              </>
            )}

            {/* Branch changes section */}
            {branchCount > 0 && (
              <>
                <div
                  className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer hover:bg-[var(--bg-tertiary)]"
                  onClick={() => setShowBranch((v) => !v)}
                >
                  {showBranch ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <span>Branch Changes</span>
                  <span className="ml-auto text-cyan-400 font-mono">{branchCount}</span>
                </div>
                {showBranch && data?.branch
                  .filter((bf) => !data.uncommitted.some((uf) => uf.path === bf.path))
                  .map((f) => renderFileItem(f, 'branch'))}
              </>
            )}

            {/* Commits section */}
            {commitCount > 0 && (
              <>
                <div
                  className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer hover:bg-[var(--bg-tertiary)]"
                  onClick={() => setShowCommits((v) => !v)}
                >
                  {showCommits ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  <span>Commits</span>
                  <span className="ml-auto text-violet-400 font-mono">{commitCount}</span>
                </div>
                {showCommits && data?.commits.map((c, i) => (
                  <div key={i} className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-[var(--text-secondary)]">
                    <GitCommitVertical className="w-3 h-3 text-violet-400 shrink-0" />
                    <span className="truncate">{c}</span>
                  </div>
                ))}
              </>
            )}

            {allFiles.length === 0 && !loading && (
              <div className="text-center py-8 text-xs text-[var(--text-muted)]">
                No changes detected
              </div>
            )}
          </div>

          {/* Diff detail */}
          {selectedFile && (
            <div className="border-t border-[var(--border)] flex flex-col flex-1 min-h-0">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-secondary)] shrink-0">
                <FileText className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                <span className="text-[11px] font-mono text-[var(--text-primary)] truncate flex-1">{selectedFile.path}</span>
                <span className={cn(
                  'text-[10px] font-mono px-1.5 rounded',
                  STATUS_CONFIG[selectedFile.status]?.color || 'text-[var(--text-muted)]',
                )}>
                  {selectedFile.status}
                </span>
              </div>
              <div className="flex-1 overflow-auto">
                <DiffView diff={selectedFile.diff} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
