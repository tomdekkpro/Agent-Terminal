import { useState, useEffect, useCallback, useRef } from 'react';
import {
  X, FolderOpen, File, ChevronRight, ChevronDown, Search, RefreshCw,
  FileText, FileImage, FileCode, FileSpreadsheet, FolderClosed, Loader2,
  Download, Check, AlertTriangle,
} from 'lucide-react';
import { cn } from '../../../shared/utils';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
  extension?: string;
  children?: FileEntry[];
}

const FILE_ICONS: Record<string, typeof File> = {
  '.md': FileText,
  '.txt': FileText,
  '.doc': FileText,
  '.docx': FileText,
  '.pdf': FileText,
  '.png': FileImage,
  '.jpg': FileImage,
  '.jpeg': FileImage,
  '.gif': FileImage,
  '.svg': FileImage,
  '.ts': FileCode,
  '.tsx': FileCode,
  '.js': FileCode,
  '.jsx': FileCode,
  '.json': FileCode,
  '.html': FileCode,
  '.css': FileCode,
  '.py': FileCode,
  '.cs': FileCode,
  '.yml': FileCode,
  '.yaml': FileCode,
  '.csv': FileSpreadsheet,
  '.xlsx': FileSpreadsheet,
  '.xls': FileSpreadsheet,
};

function getFileIcon(entry: FileEntry) {
  if (entry.isDirectory) return FolderOpen;
  return FILE_ICONS[entry.extension || ''] || File;
}

function formatSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── File Tree Item ──────────────────────────────────────────────

function FileTreeItem({
  entry,
  depth,
  searchQuery,
}: {
  entry: FileEntry;
  depth: number;
  searchQuery: string;
}) {
  const [expanded, setExpanded] = useState(depth === 0 && entry.isDirectory);
  const [children, setChildren] = useState<FileEntry[] | undefined>(entry.children);
  const [loading, setLoading] = useState(false);
  const Icon = getFileIcon(entry);

  // Auto-expand when searching
  useEffect(() => {
    if (searchQuery && entry.isDirectory) setExpanded(true);
  }, [searchQuery, entry.isDirectory]);

  const handleToggle = useCallback(async () => {
    if (!entry.isDirectory) return;
    if (!expanded && !children) {
      setLoading(true);
      try {
        const result = await window.electronAPI.listDir(entry.path, 1);
        if (result.success) setChildren(result.data);
      } catch { /* ignore */ }
      setLoading(false);
    }
    setExpanded(!expanded);
  }, [expanded, children, entry.path, entry.isDirectory]);

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', entry.path);
    e.dataTransfer.setData('application/x-file-path', entry.path);
    e.dataTransfer.effectAllowed = 'copy';
  }, [entry.path]);

  const handleDoubleClick = useCallback(() => {
    if (!entry.isDirectory) {
      window.electronAPI.openPath(entry.path);
    }
  }, [entry.path, entry.isDirectory]);

  return (
    <>
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 text-xs cursor-pointer transition-colors group/file',
          'hover:bg-[var(--bg-tertiary)] rounded-sm',
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleToggle}
        onDoubleClick={handleDoubleClick}
        draggable
        onDragStart={handleDragStart}
        title={`${entry.path}\nDrag to terminal to insert path`}
      >
        {entry.isDirectory ? (
          <span className="w-3 h-3 shrink-0 flex items-center justify-center text-[var(--text-muted)]">
            {loading ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        ) : (
          <span className="w-3 h-3 shrink-0" />
        )}
        <Icon className={cn(
          'w-3.5 h-3.5 shrink-0',
          entry.isDirectory ? 'text-amber-400' : 'text-[var(--text-muted)]',
        )} />
        <span className="flex-1 truncate text-[var(--text-primary)]">{entry.name}</span>
        {!entry.isDirectory && entry.size != null && (
          <span className="text-[10px] text-[var(--text-muted)] opacity-0 group-hover/file:opacity-100 shrink-0">
            {formatSize(entry.size)}
          </span>
        )}
      </div>
      {expanded && children && children.map((child) => (
        <FileTreeItem
          key={child.path}
          entry={child}
          depth={depth + 1}
          searchQuery={searchQuery}
        />
      ))}
    </>
  );
}

// ─── Files Panel ─────────────────────────────────────────────────

interface FilesPanelProps {
  docsPath: string;
  onClose: () => void;
  /** Toolbar title. Defaults to "Files". */
  label?: string;
  /** Auto-pull from git on mount and show the Pull button. On for docs repos,
   *  off for browsing a plain project source tree. Defaults to true. */
  enablePull?: boolean;
}

export function FilesPanel({ docsPath, onClose, label = 'Files', enablePull = true }: FilesPanelProps) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [pullStatus, setPullStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const loadRoot = useCallback(async () => {
    if (!docsPath) return;
    setLoading(true);
    try {
      const result = await window.electronAPI.listDir(docsPath, 1);
      if (result.success) setEntries(result.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [docsPath]);

  const handlePull = useCallback(async () => {
    if (!docsPath || pullStatus === 'loading') return;
    setPullStatus('loading');
    try {
      const result = await window.electronAPI.gitPull(docsPath);
      setPullStatus(result?.success ? 'success' : 'error');
      // Reload file tree after pull
      if (result?.success) await loadRoot();
    } catch {
      setPullStatus('error');
    }
    setTimeout(() => setPullStatus('idle'), 3000);
  }, [docsPath, pullStatus, loadRoot]);

  // Auto-pull on mount to keep docs up to date. Skipped when pull is disabled
  // (browsing a plain project source tree) — just load the file tree.
  const didAutoSync = useRef(false);
  useEffect(() => {
    if (didAutoSync.current) return;
    didAutoSync.current = true;
    if (!enablePull) {
      void loadRoot();
      return;
    }
    // Pull first, then load file tree
    (async () => {
      setPullStatus('loading');
      try {
        const result = await window.electronAPI.gitPull(docsPath);
        setPullStatus(result?.success ? 'success' : 'idle');
        setTimeout(() => setPullStatus('idle'), 3000);
      } catch {
        setPullStatus('idle');
      }
      await loadRoot();
    })();
  }, [docsPath, loadRoot, enablePull]);

  // Filter entries by search
  const filterEntries = useCallback((items: FileEntry[], q: string): FileEntry[] => {
    if (!q) return items;
    const lower = q.toLowerCase();
    return items.filter((e) => {
      if (e.name.toLowerCase().includes(lower)) return true;
      if (e.isDirectory && e.children) return filterEntries(e.children, q).length > 0;
      return false;
    });
  }, []);

  const filtered = search ? filterEntries(entries, search) : entries;

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)] border-l border-[var(--border)]">
      {/* Toolbar */}
      <div className="h-9 bg-[var(--bg-card)] border-b border-[var(--border)] flex items-center px-2 gap-1 shrink-0">
        <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <span className="text-[11px] text-[var(--text-primary)] font-medium truncate flex-1">{label}</span>
        {enablePull && (
          <button
            onClick={handlePull}
            disabled={pullStatus === 'loading'}
            className={cn(
              'h-6 px-1.5 rounded flex items-center gap-1 text-[10px] transition-all',
              'hover:bg-[var(--bg-tertiary)]',
              pullStatus === 'loading' && 'opacity-60 cursor-wait',
              pullStatus === 'success' && 'text-green-400',
              pullStatus === 'error' && 'text-red-400',
              pullStatus === 'idle' && 'text-[var(--text-muted)]',
            )}
            title="Pull latest docs from remote"
          >
            {pullStatus === 'success' ? <Check className="w-3 h-3" /> :
             pullStatus === 'error' ? <AlertTriangle className="w-3 h-3" /> :
             <Download className={cn('w-3 h-3', pullStatus === 'loading' && 'animate-bounce')} />}
            <span>Pull</span>
          </button>
        )}
        <button
          onClick={loadRoot}
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

      {/* Search */}
      <div className="px-2 py-1.5 border-b border-[var(--border)]">
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files..."
            className="w-full text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded pl-7 pr-2 py-1 outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      {/* Path indicator */}
      <div className="px-2 py-1 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <span className="text-[10px] text-[var(--text-muted)] truncate block" title={docsPath}>
          {docsPath}
        </span>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-[var(--text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-xs text-[var(--text-muted)]">
            {search ? 'No matching files' : 'No files found'}
          </div>
        ) : (
          filtered.map((entry) => (
            <FileTreeItem
              key={entry.path}
              entry={entry}
              depth={0}
              searchQuery={search}
            />
          ))
        )}
      </div>

      {/* Footer hint */}
      <div className="px-2 py-1.5 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
        <span className="text-[10px] text-[var(--text-muted)]">
          Drag files into terminal to insert path
        </span>
      </div>
    </div>
  );
}
