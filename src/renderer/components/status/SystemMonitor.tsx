/**
 * System Monitor - Real-time CPU, RAM & GPU display
 *
 * Shows a compact badge with CPU%, RAM%, and GPU%.
 * Hover to expand detailed breakdown with per-core CPU, memory, and GPU info.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Cpu, MemoryStick, Clock, Monitor, Thermometer } from 'lucide-react';
import { useSystemMonitorStore } from '../../stores/system-monitor-store';
import { cn } from '../../../shared/utils';
import type { SystemMonitorData } from '../../../shared/types';

function getColorClass(percent: number): string {
  if (percent >= 90) return 'text-red-500';
  if (percent >= 75) return 'text-orange-500';
  if (percent >= 50) return 'text-yellow-500';
  return 'text-green-500';
}

function getBadgeClasses(percent: number): string {
  if (percent >= 90) return 'text-red-500 bg-red-500/10 border-red-500/20';
  if (percent >= 75) return 'text-orange-500 bg-orange-500/10 border-orange-500/20';
  if (percent >= 50) return 'text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
  return 'text-green-500 bg-green-500/10 border-green-500/20';
}

function getBarGradient(percent: number): string {
  if (percent >= 90) return 'bg-gradient-to-r from-red-600 to-red-500';
  if (percent >= 75) return 'bg-gradient-to-r from-orange-600 to-orange-500';
  if (percent >= 50) return 'bg-gradient-to-r from-yellow-600 to-yellow-500';
  return 'bg-gradient-to-r from-green-600 to-green-500';
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function formatTemp(celsius: number): string {
  return `${celsius}°C`;
}

function getTempColorClass(temp: number): string {
  if (temp >= 90) return 'text-red-500';
  if (temp >= 80) return 'text-orange-500';
  if (temp >= 70) return 'text-yellow-500';
  return 'text-green-500';
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function SystemMonitor() {
  const data = useSystemMonitorStore((s) => s.data);
  const isLoading = useSystemMonitorStore((s) => s.isLoading);
  const setData = useSystemMonitorStore((s) => s.setData);
  const setLoading = useSystemMonitorStore((s) => s.setLoading);

  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Fetch initial data + listen for updates
  useEffect(() => {
    let unsub: (() => void) | undefined;

    if (window.electronAPI.onSystemMonitorUpdated) {
      unsub = window.electronAPI.onSystemMonitorUpdated((snapshot: SystemMonitorData) => {
        setData(snapshot);
      });
    }

    if (window.electronAPI.requestSystemMonitor) {
      window.electronAPI
        .requestSystemMonitor()
        .then((result: { success: boolean; data?: SystemMonitorData }) => {
          setLoading(false);
          if (result.success && result.data) {
            setData(result.data);
          }
        })
        .catch(() => {
          setLoading(false);
        });
    } else {
      setLoading(false);
    }

    return () => {
      unsub?.();
    };
  }, [setData, setLoading]);

  // Click outside to close pinned popover
  useEffect(() => {
    if (!isPinned) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsPinned(false);
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isPinned]);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (isPinned) return;
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => setIsOpen(true), 150);
  }, [isPinned]);

  const handleMouseLeave = useCallback(() => {
    if (isPinned) return;
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => setIsOpen(false), 300);
  }, [isPinned]);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (isPinned) {
      setIsPinned(false);
      setIsOpen(false);
    } else {
      setIsPinned(true);
      setIsOpen(true);
    }
  }, [isPinned]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-muted)]">
        <Cpu className="h-3.5 w-3.5 animate-pulse" />
        <span className="text-[10px] font-semibold">...</span>
      </div>
    );
  }

  if (!data) return null;

  const hasGpu = data.gpu && data.gpu.length > 0;
  const gpuMaxUtil = hasGpu ? Math.max(...data.gpu!.map((g) => g.utilization)) : 0;
  const worstPercent = Math.max(data.cpu.percent, data.memory.percent, gpuMaxUtil);
  const badgeClasses = getBadgeClasses(worstPercent);

  return (
    <div className="relative" ref={popoverRef}>
      {/* Badge trigger */}
      <button
        className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded-md border transition-all hover:opacity-80',
          badgeClasses
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        title="System Resources"
      >
        <Cpu className="h-3.5 w-3.5 shrink-0" />
        <div className="flex items-center gap-1 text-[10px] font-semibold font-mono">
          <span className={getColorClass(data.cpu.percent)}>{data.cpu.percent}%</span>
          <span className="text-[var(--text-muted)] opacity-50">|</span>
          <MemoryStick className="h-3 w-3 shrink-0" />
          <span className={getColorClass(data.memory.percent)}>{data.memory.percent}%</span>
          {hasGpu && (
            <>
              <span className="text-[var(--text-muted)] opacity-50">|</span>
              <Monitor className="h-3 w-3 shrink-0" />
              <span className={getColorClass(gpuMaxUtil)}>{gpuMaxUtil}%</span>
            </>
          )}
        </div>
      </button>

      {/* Popover */}
      {isOpen && (
        <div
          className="absolute top-full right-0 mt-1 w-72 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-50"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="p-3 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between pb-2 border-b border-[var(--border)]">
              <div className="flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                <span className="font-semibold text-xs text-[var(--text-primary)]">
                  System Resources
                </span>
              </div>
              <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                <Clock className="h-3 w-3" />
                <span>Up {formatUptime(data.uptime)}</span>
              </div>
            </div>

            {/* CPU Section */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)] font-medium text-[11px] flex items-center gap-1">
                  <Cpu className="h-3 w-3" />
                  CPU ({data.cpu.count} cores)
                </span>
                <span className={cn('font-semibold text-xs tabular-nums', getColorClass(data.cpu.percent))}>
                  {data.cpu.percent}%
                </span>
              </div>
              <div className="h-2 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all duration-500 ease-out', getBarGradient(data.cpu.percent))}
                  style={{ width: `${Math.min(data.cpu.percent, 100)}%` }}
                />
              </div>

              {/* Per-core mini bars */}
              <div className="grid grid-cols-4 gap-x-2 gap-y-1 pt-1">
                {data.cpu.cores.map((core, i) => (
                  <div key={i} className="space-y-0.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-[var(--text-muted)]">C{i}</span>
                      <span className={cn('text-[9px] font-mono tabular-nums', getColorClass(core.percent))}>
                        {core.percent}%
                      </span>
                    </div>
                    <div className="h-1 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                      <div
                        className={cn('h-full rounded-full transition-all duration-500', getBarGradient(core.percent))}
                        style={{ width: `${Math.min(core.percent, 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Memory Section */}
            <div className="space-y-1.5 pt-2 border-t border-[var(--border)]">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-muted)] font-medium text-[11px] flex items-center gap-1">
                  <MemoryStick className="h-3 w-3" />
                  Memory
                </span>
                <span className={cn('font-semibold text-xs tabular-nums', getColorClass(data.memory.percent))}>
                  {data.memory.percent}%
                </span>
              </div>
              <div className="h-2 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                <div
                  className={cn('h-full rounded-full transition-all duration-500 ease-out', getBarGradient(data.memory.percent))}
                  style={{ width: `${Math.min(data.memory.percent, 100)}%` }}
                />
              </div>
              <div className="grid grid-cols-3 gap-2 text-center pt-1">
                <div>
                  <div className="text-[10px] text-[var(--text-muted)]">Used</div>
                  <div className="text-xs font-semibold text-[var(--text-primary)]">
                    {formatBytes(data.memory.used)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--text-muted)]">Free</div>
                  <div className="text-xs font-semibold text-[var(--text-primary)]">
                    {formatBytes(data.memory.free)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[var(--text-muted)]">Total</div>
                  <div className="text-xs font-semibold text-[var(--text-primary)]">
                    {formatBytes(data.memory.total)}
                  </div>
                </div>
              </div>
            </div>

            {/* GPU Section */}
            {hasGpu && data.gpu!.map((gpu, i) => (
              <div key={i} className="space-y-1.5 pt-2 border-t border-[var(--border)]">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)] font-medium text-[11px] flex items-center gap-1">
                    <Monitor className="h-3 w-3" />
                    GPU{data.gpu!.length > 1 ? ` ${i}` : ''}
                  </span>
                  <span className={cn('font-semibold text-xs tabular-nums', getColorClass(gpu.utilization))}>
                    {gpu.utilization}%
                  </span>
                </div>
                <div className="h-2 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all duration-500 ease-out', getBarGradient(gpu.utilization))}
                    style={{ width: `${Math.min(gpu.utilization, 100)}%` }}
                  />
                </div>

                {/* VRAM */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[var(--text-muted)]">VRAM</span>
                    <span className={cn('text-[10px] font-semibold tabular-nums', getColorClass(gpu.memoryPercent))}>
                      {formatMB(gpu.memoryUsed)} / {formatMB(gpu.memoryTotal)}
                    </span>
                  </div>
                  <div className="h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all duration-500', getBarGradient(gpu.memoryPercent))}
                      style={{ width: `${Math.min(gpu.memoryPercent, 100)}%` }}
                    />
                  </div>
                </div>

                {/* Temperature + Name */}
                <div className="flex items-center justify-between">
                  {gpu.temperature > 0 && (
                    <span className={cn('text-[10px] flex items-center gap-0.5', getTempColorClass(gpu.temperature))}>
                      <Thermometer className="h-3 w-3" />
                      {formatTemp(gpu.temperature)}
                    </span>
                  )}
                  <span className="text-[9px] text-[var(--text-muted)] truncate max-w-[180px]" title={gpu.name}>
                    {gpu.name}
                  </span>
                </div>
              </div>
            ))}

            {/* CPU Model */}
            {data.cpu.cores[0] && (
              <div className="pt-2 border-t border-[var(--border)]">
                <div className="text-[9px] text-[var(--text-muted)] truncate" title={data.cpu.cores[0].model}>
                  {data.cpu.cores[0].model}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
