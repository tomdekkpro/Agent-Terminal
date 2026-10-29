import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, ImageOff, Maximize2, Minus, Plus, RefreshCw, RotateCcw, X } from 'lucide-react';
import { cn } from '../../../shared/utils';
import { retryUrl, viewableAttachmentUrl } from './attachment-url';

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
/** Multiplier per wheel notch — small enough that a trackpad feels smooth. */
const WHEEL_STEP = 1.15;
const BUTTON_STEP = 1.4;

const clampScale = (value: number) => Math.min(Math.max(value, MIN_SCALE), MAX_SCALE);

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

/**
 * Full-screen image viewer with zoom and pan.
 *
 * Zooming is anchored to the pointer rather than the image centre — the whole
 * point of zooming a screenshot is to read one particular corner of it, and
 * centre-anchored zoom pushes that corner off screen just as it becomes
 * legible.
 */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // Bumped by the retry button to force a fresh request rather than a cached
  // failure. Without an error state the viewer was a black rectangle with a
  // filename on it, which reads as "nothing happened".
  const [attempt, setAttempt] = useState(0);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    setAttempt(0);
  }, [src]);

  const retry = useCallback(() => {
    setFailed(false);
    setLoaded(false);
    setAttempt((n) => n + 1);
  }, []);

  /** Zoom while keeping the point under `origin` (viewport coords) fixed. */
  const zoomAt = useCallback((factor: number, origin?: { x: number; y: number }) => {
    const frame = frameRef.current;
    setScale((current) => {
      const next = clampScale(current * factor);
      if (next === current) return current;
      if (frame && origin) {
        const rect = frame.getBoundingClientRect();
        // Distance from the frame centre to the cursor, in screen pixels.
        const dx = origin.x - (rect.left + rect.width / 2);
        const dy = origin.y - (rect.top + rect.height / 2);
        const ratio = next / current;
        setOffset((o) => ({
          x: o.x - (dx - o.x) * (ratio - 1),
          y: o.y - (dy - o.y) * (ratio - 1),
        }));
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomAt(BUTTON_STEP);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomAt(1 / BUTTON_STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        reset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomAt, reset]);

  // Wheel is bound natively rather than via onWheel: React attaches its wheel
  // listener passively, so preventDefault there is ignored and the transcript
  // underneath scrolls while you zoom.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, { x: e.clientX, y: e.clientY });
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, offsetX: offset.x, offsetY: offset.y };

    const onMove = (ev: MouseEvent) => {
      setOffset({
        x: dragStart.current.offsetX + (ev.clientX - dragStart.current.x),
        y: dragStart.current.offsetY + (ev.clientY - dragStart.current.y),
      });
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const control = (label: string, Icon: any, onClick: () => void, disabled?: boolean) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={label}
      className="p-2 rounded-lg text-white/80 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <Icon className="w-4 h-4" />
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black/85 backdrop-blur-sm"
      // Clicking the backdrop dismisses; clicks on the image and the toolbar
      // stop propagating so dragging never closes the viewer.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex items-center gap-1 px-3 py-2 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
        <span className="flex-1 min-w-0 truncate text-[12px] text-white/70" title={alt || src}>
          {alt || src.split('/').pop()}
        </span>
        <span className="px-2 text-[11px] text-white/50 tabular-nums">{Math.round(scale * 100)}%</span>
        {control('Zoom out  (−)', Minus, () => zoomAt(1 / BUTTON_STEP), scale <= MIN_SCALE)}
        {control('Zoom in  (+)', Plus, () => zoomAt(BUTTON_STEP), scale >= MAX_SCALE)}
        {control('Actual size', Maximize2, () => {
          setScale(1);
          setOffset({ x: 0, y: 0 });
        })}
        {control('Reset  (0)', RotateCcw, reset)}
        {control('Open in browser', ExternalLink, () => window.electronAPI.openExternal(viewableAttachmentUrl(src)))}
        {control('Close  (Esc)', X, onClose)}
      </div>

      <div
        ref={frameRef}
        onMouseDown={(e) => {
          // Only the backdrop closes; dragging the image pans it.
          if (e.target === e.currentTarget) {
            onClose();
            return;
          }
          startDrag(e);
        }}
        onDoubleClick={() => (scale === 1 ? zoomAt(2.5) : reset())}
        className={cn(
          'flex-1 min-h-0 overflow-hidden flex items-center justify-center select-none',
          scale > 1 ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
        )}
      >
        {failed ? (
          // Stops the frame's drag handler from swallowing the buttons.
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="flex flex-col items-center gap-3 text-center px-6"
          >
            <ImageOff className="w-8 h-8 text-white/40" />
            <p className="text-[13px] text-white/70">{alt || 'This image'} could not be loaded.</p>
            <p className="max-w-md text-[11px] text-white/40 break-all">{src}</p>
            <div className="flex items-center gap-2">
              <button
                onClick={retry}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-[12px] text-white/80 hover:bg-white/20"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Try again
              </button>
              <button
                onClick={() => window.electronAPI.openExternal(viewableAttachmentUrl(src))}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-[12px] text-white/80 hover:bg-white/20"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in browser
              </button>
            </div>
          </div>
        ) : (
          <img
            src={retryUrl(src, attempt)}
            alt={alt || ''}
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              // No easing while dragging, or the image lags behind the cursor.
              transition: dragging ? 'none' : 'transform 120ms ease-out',
            }}
            className={cn(
              'max-h-full max-w-full object-contain shadow-2xl',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
          />
        )}
      </div>

      <p className="shrink-0 text-center text-[10px] text-white/35 pb-2">
        Scroll to zoom · drag to pan · double-click to toggle · Esc to close
      </p>
    </div>
  );
}
