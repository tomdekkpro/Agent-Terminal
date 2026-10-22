import { useState, useEffect, useCallback } from 'react';
import { Download, RefreshCw, X, CheckCircle, Loader2 } from 'lucide-react';
import { cn } from '../../../shared/utils';

interface UpdateStatus {
  status: 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
  version?: string;
  percent?: number;
  error?: string;
  releaseNotes?: string;
  /** mac: no in-app install — Download opens the GitHub release page */
  manual?: boolean;
}

export function UpdateNotification() {
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const cleanup = window.electronAPI.onUpdateStatus((data: UpdateStatus) => {
      setUpdate(data);
      if (data.status === 'available' || data.status === 'ready') {
        setDismissed(false);
      }
    });
    return () => { cleanup(); };
  }, []);

  const handleDownload = useCallback(async () => {
    const result = await window.electronAPI.downloadUpdate();
    if (result?.manual) setDismissed(true);
  }, []);

  const handleInstall = useCallback(() => {
    window.electronAPI.installUpdate();
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  // Don't show for non-actionable states or if dismissed
  if (!update || dismissed) return null;
  if (update.status === 'checking' || update.status === 'up-to-date') return null;
  if (update.status === 'error') return null;

  return (
    <div className={cn(
      'fixed bottom-4 right-4 z-50 w-80 rounded-xl border shadow-2xl overflow-hidden',
      'bg-[var(--bg-card)] border-[var(--border)]',
      'animate-in slide-in-from-bottom-2'
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          {update.status === 'available' && <Download className="w-4 h-4 text-[var(--accent)]" />}
          {update.status === 'downloading' && <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />}
          {update.status === 'ready' && <CheckCircle className="w-4 h-4 text-emerald-400" />}
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {update.status === 'available' && 'Update Available'}
            {update.status === 'downloading' && 'Downloading Update'}
            {update.status === 'ready' && 'Ready to Install'}
          </span>
        </div>
        <button
          onClick={handleDismiss}
          className="w-5 h-5 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {update.status === 'available' && (
          <>
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              Version <span className="font-mono text-[var(--accent)]">{update.version}</span> is available.
            </p>
            <button
              onClick={handleDownload}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              {update.manual ? 'Open Download Page' : 'Download Update'}
            </button>
          </>
        )}

        {update.status === 'downloading' && (
          <>
            <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-2">
              <span>Downloading...</span>
              <span className="font-mono">{update.percent || 0}%</span>
            </div>
            <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
                style={{ width: `${update.percent || 0}%` }}
              />
            </div>
          </>
        )}

        {update.status === 'ready' && (
          <>
            <p className="text-xs text-[var(--text-secondary)] mb-3">
              Version <span className="font-mono text-emerald-400">{update.version}</span> is ready. Restart to apply.
            </p>
            <button
              onClick={handleInstall}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Restart & Update
            </button>
          </>
        )}
      </div>
    </div>
  );
}
