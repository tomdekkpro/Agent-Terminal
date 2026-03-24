import { useState, useRef, useEffect, useCallback } from 'react';
import {
  RefreshCw, ExternalLink, X, Globe, ArrowLeft, ArrowRight,
  RotateCcw, Smartphone, Monitor, Tablet,
} from 'lucide-react';
import { cn } from '../../../shared/utils';

interface PreviewPanelProps {
  url: string;
  onUrlChange: (url: string) => void;
  onClose: () => void;
  /** When true, triggers an automatic reload (e.g. agent finished working) */
  autoReloadTrigger?: number;
}

type DevicePreset = 'responsive' | 'mobile' | 'tablet' | 'desktop';

const DEVICE_PRESETS: Record<DevicePreset, { width: string; icon: typeof Monitor; label: string }> = {
  responsive: { width: '100%', icon: Monitor, label: 'Responsive' },
  mobile: { width: '375px', icon: Smartphone, label: '375px' },
  tablet: { width: '768px', icon: Tablet, label: '768px' },
  desktop: { width: '1280px', icon: Monitor, label: '1280px' },
};

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  // If it looks like a bare port or localhost shorthand
  if (/^\d+$/.test(trimmed)) return `http://localhost:${trimmed}`;
  if (/^:\d+/.test(trimmed)) return `http://localhost${trimmed}`;
  if (/^localhost/.test(trimmed)) return `http://${trimmed}`;
  if (/^127\.0\.0\.1/.test(trimmed)) return `http://${trimmed}`;
  // If no protocol, add http
  if (!/^https?:\/\//.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
}

export function PreviewPanel({ url, onUrlChange, onClose, autoReloadTrigger }: PreviewPanelProps) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const [urlInput, setUrlInput] = useState(url || '');
  const [currentUrl, setCurrentUrl] = useState(() => normalizeUrl(url || ''));
  const [isLoading, setIsLoading] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [pageTitle, setPageTitle] = useState('');
  const [devicePreset, setDevicePreset] = useState<DevicePreset>('responsive');
  const [loadError, setLoadError] = useState<string | null>(null);

  // Navigate to a URL
  const navigate = useCallback((rawUrl: string) => {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) return;
    setCurrentUrl(normalized);
    setUrlInput(rawUrl);
    onUrlChange(rawUrl);
    setLoadError(null);
  }, [onUrlChange]);

  // Handle URL bar submission
  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(urlInput);
  };

  // Reload the webview
  const handleReload = useCallback(() => {
    if (webviewRef.current) {
      setLoadError(null);
      webviewRef.current.reload();
    }
  }, []);

  // Auto-reload when agent finishes
  useEffect(() => {
    if (autoReloadTrigger && autoReloadTrigger > 0 && webviewRef.current && currentUrl) {
      handleReload();
    }
  }, [autoReloadTrigger, handleReload, currentUrl]);

  // Attach webview event listeners
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onLoadStart = () => {
      setIsLoading(true);
      setLoadError(null);
    };
    const onLoadStop = () => {
      setIsLoading(false);
      if (wv.canGoBack) setCanGoBack(wv.canGoBack());
      if (wv.canGoForward) setCanGoForward(wv.canGoForward());
    };
    const onTitleUpdate = (e: any) => {
      setPageTitle(e.title || '');
    };
    const onNavigate = (e: any) => {
      setUrlInput(e.url);
      setCurrentUrl(e.url);
    };
    const onLoadFail = (e: any) => {
      setIsLoading(false);
      // errorCode -3 is aborted (user navigated away), ignore it
      if (e.errorCode !== -3) {
        setLoadError(e.errorDescription || 'Failed to load');
      }
    };

    wv.addEventListener('did-start-loading', onLoadStart);
    wv.addEventListener('did-stop-loading', onLoadStop);
    wv.addEventListener('page-title-updated', onTitleUpdate);
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('did-fail-load', onLoadFail);

    return () => {
      wv.removeEventListener('did-start-loading', onLoadStart);
      wv.removeEventListener('did-stop-loading', onLoadStop);
      wv.removeEventListener('page-title-updated', onTitleUpdate);
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
      wv.removeEventListener('did-fail-load', onLoadFail);
    };
  }, [currentUrl]);

  // Sync when external url prop changes
  useEffect(() => {
    if (url && url !== urlInput) {
      setUrlInput(url);
      setCurrentUrl(normalizeUrl(url));
    }
  }, [url]);

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)] border-l border-[var(--border)]">
      {/* Preview toolbar */}
      <div className="h-9 bg-[var(--bg-card)] border-b border-[var(--border)] flex items-center px-2 gap-1 shrink-0">
        {/* Navigation buttons */}
        <button
          onClick={() => webviewRef.current?.goBack()}
          disabled={!canGoBack}
          className={cn(
            'w-6 h-6 rounded flex items-center justify-center transition-colors',
            canGoBack ? 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' : 'text-[var(--text-muted)] opacity-40'
          )}
          title="Go back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canGoForward}
          className={cn(
            'w-6 h-6 rounded flex items-center justify-center transition-colors',
            canGoForward ? 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]' : 'text-[var(--text-muted)] opacity-40'
          )}
          title="Go forward"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleReload}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
          title="Reload"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} />
        </button>

        {/* URL bar */}
        <form onSubmit={handleUrlSubmit} className="flex-1 min-w-0 mx-1">
          <div className="relative flex items-center">
            <Globe className="absolute left-2 w-3 h-3 text-[var(--text-muted)]" />
            <input
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="localhost:3000"
              className="w-full pl-7 pr-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] font-mono"
            />
          </div>
        </form>

        {/* Device presets */}
        <div className="flex items-center gap-0.5">
          {(Object.entries(DEVICE_PRESETS) as [DevicePreset, typeof DEVICE_PRESETS[DevicePreset]][]).map(([key, preset]) => {
            const Icon = preset.icon;
            return (
              <button
                key={key}
                onClick={() => setDevicePreset(key)}
                className={cn(
                  'w-6 h-6 rounded flex items-center justify-center transition-colors',
                  devicePreset === key
                    ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                    : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                )}
                title={`${preset.label}${key === 'responsive' ? '' : ` (${preset.width})`}`}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            );
          })}
        </div>

        {/* Open in browser */}
        <button
          onClick={() => {
            if (currentUrl) window.electronAPI?.openExternal?.(currentUrl);
          }}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] transition-colors"
          title="Open in browser"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>

        {/* Close */}
        <button
          onClick={onClose}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--error)]/20 hover:text-[var(--error)] text-[var(--text-muted)] transition-colors"
          title="Close preview"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Page title bar */}
      {pageTitle && (
        <div className="h-6 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center px-3 shrink-0">
          <span className="text-[10px] text-[var(--text-muted)] truncate">{pageTitle}</span>
        </div>
      )}

      {/* Webview container */}
      <div className="flex-1 relative bg-white overflow-hidden flex items-start justify-center">
        {!currentUrl ? (
          <div className="flex flex-col items-center justify-center h-full w-full gap-3 bg-[var(--bg-primary)]">
            <Globe className="w-10 h-10 text-[var(--text-muted)] opacity-30" />
            <p className="text-sm text-[var(--text-muted)]">Enter a URL to preview</p>
            <p className="text-[11px] text-[var(--text-muted)] opacity-60">e.g. localhost:3000 or 3000</p>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center h-full w-full gap-3 bg-[var(--bg-primary)]">
            <RotateCcw className="w-10 h-10 text-red-400 opacity-50" />
            <p className="text-sm text-red-400">Failed to load preview</p>
            <p className="text-[11px] text-[var(--text-muted)] max-w-[300px] text-center">{loadError}</p>
            <p className="text-[11px] text-[var(--text-muted)] opacity-60">Make sure your dev server is running</p>
            <button
              onClick={handleReload}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        ) : (
          <webview
            ref={webviewRef as any}
            src={currentUrl}
            style={{
              width: devicePreset === 'responsive' ? '100%' : DEVICE_PRESETS[devicePreset].width,
              height: '100%',
              border: 'none',
              maxWidth: '100%',
            }}
            // @ts-ignore - Electron webview attributes
            allowpopups="true"
          />
        )}

        {/* Loading bar */}
        {isLoading && (
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--accent)] animate-pulse" />
        )}
      </div>
    </div>
  );
}
