import { useEffect, useState, useCallback } from 'react';
import { Gauge, Clock, TrendingUp, RefreshCw, Activity, Coins, Cpu } from 'lucide-react';
import { useUsageStore } from '../../stores/usage-store';
import type { UsageSnapshot, KanbanDailyCostBreakdown, ModelUsageSummary } from '../../../shared/types';
import { cn } from '../../../shared/utils';

// Same thresholds the header UsageIndicator uses, so colors stay consistent.
const CRIT = 95, WARN = 91, ELEV = 71;

function tone(usedPercent: number): { text: string; bar: string } {
  if (usedPercent >= CRIT) return { text: 'text-red-400', bar: 'from-red-600 to-red-500' };
  if (usedPercent >= WARN) return { text: 'text-orange-400', bar: 'from-orange-600 to-orange-500' };
  if (usedPercent >= ELEV) return { text: 'text-yellow-400', bar: 'from-yellow-600 to-yellow-500' };
  return { text: 'text-green-400', bar: 'from-green-600 to-green-500' };
}

function Meter({
  label, icon: Icon, usedPercent, resetText,
}: {
  label: string; icon: typeof Gauge; usedPercent: number; resetText?: string;
}) {
  const used = Math.max(0, Math.min(100, Math.round(usedPercent)));
  const left = 100 - used;
  const t = tone(used);
  return (
    <div className="flex-1 min-w-[180px]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] font-medium">
          <Icon className="w-3.5 h-3.5" /> {label}
        </span>
        <span className={cn('font-mono-ui text-xs font-semibold', t.text)}>{left}% left</span>
      </div>
      <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div
          className={cn('h-full rounded-full bg-gradient-to-r transition-all duration-500', t.bar)}
          style={{ width: `${used}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] text-[var(--text-muted)]">{used}% used</span>
        {resetText && <span className="text-[10px] text-[var(--text-muted)]">{resetText}</span>}
      </div>
    </div>
  );
}

// Fixed per-family series colors (validated against the app surface for
// lightness, chroma, CVD separation, and 3:1 contrast). Color follows the
// model family — never its rank in the list.
const MODEL_COLORS: { match: RegExp; color: string }[] = [
  { match: /fable|mythos/, color: '#9085e9' }, // violet
  { match: /opus/, color: '#3987e5' },         // blue
  { match: /sonnet/, color: '#199e70' },       // aqua
  { match: /haiku/, color: '#c98500' },        // yellow
];

function modelColor(model: string): string {
  for (const m of MODEL_COLORS) if (m.match.test(model)) return m.color;
  return 'var(--border-strong)';
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** One model's row: label + token summary, cost figures, and a share-of-week bar. */
function ModelRow({ m, weekTotal }: { m: ModelUsageSummary; weekTotal: number }) {
  const color = modelColor(m.model);
  const share = weekTotal > 0 ? m.costWeek / weekTotal : 0;
  const totalIn = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens;
  return (
    <div
      title={`${m.label} — ${m.messages} messages · input ${fmtTokens(m.inputTokens)} + cache ${fmtTokens(m.cacheReadTokens)} read / ${fmtTokens(m.cacheWriteTokens)} write · output ${fmtTokens(m.outputTokens)}`}
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
          <span className="text-xs font-medium text-[var(--text-primary)] truncate">{m.label}</span>
          <span className="text-[10px] text-[var(--text-muted)] truncate">
            {fmtTokens(totalIn)} in · {fmtTokens(m.outputTokens)} out
          </span>
        </span>
        <span className="flex items-baseline gap-2.5 shrink-0">
          {m.costToday > 0 && (
            <span className="text-[10px] text-[var(--text-muted)]">
              today <span className="font-mono-ui text-[var(--text-secondary)]">${m.costToday.toFixed(2)}</span>
            </span>
          )}
          <span className="font-mono-ui text-xs font-semibold text-[var(--text-primary)]">${m.costWeek.toFixed(2)}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.max(share * 100, m.costWeek > 0 ? 1 : 0)}%`, background: color }}
        />
      </div>
    </div>
  );
}

/** 7-day cost sparkline (today is the rightmost bar). */
function Sparkline({ series }: { series: { date: string; cost: number }[] }) {
  const max = Math.max(...series.map((s) => s.cost), 0.01);
  return (
    <div className="flex items-end gap-1 h-8">
      {series.map((s, i) => {
        const isToday = i === series.length - 1;
        const h = Math.max(2, Math.round((s.cost / max) * 32));
        return (
          <div
            key={s.date}
            title={`${s.date}: $${s.cost.toFixed(2)}`}
            className={cn('w-2 rounded-sm', isToday ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]')}
            style={{ height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

function statusLine(limiting: number): { text: string; cls: string } {
  if (limiting >= CRIT) return { text: 'Nearly at your limit — consider pausing heavy runs until it resets.', cls: 'text-red-400' };
  if (limiting >= WARN) return { text: 'Getting close to the limit — heavy tasks may throttle soon.', cls: 'text-orange-400' };
  if (limiting >= ELEV) return { text: 'Moderate usage — keep an eye on the 5-hour window.', cls: 'text-yellow-400' };
  return { text: 'Plenty of headroom left — good to keep working.', cls: 'text-green-400' };
}

export function UsageSummaryCard() {
  const usage = useUsageStore((s) => s.usage);
  const setUsage = useUsageStore((s) => s.setUsage);
  const setAvailable = useUsageStore((s) => s.setAvailable);
  const [daily, setDaily] = useState<KanbanDailyCostBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [u, d] = await Promise.all([
        window.electronAPI.requestUsageUpdate?.(),
        window.electronAPI.kanbanDailyCost?.(),
      ]);
      if (u?.success && u.data) { setUsage(u.data as UsageSnapshot); setUnavailable(false); }
      else if (!usage) { setAvailable(false); setUnavailable(true); }
      if (d?.success && d.data) setDaily(d.data as KanbanDailyCostBreakdown);
    } catch {
      if (!usage) setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, [setUsage, setAvailable, usage]);

  useEffect(() => {
    const unsub = window.electronAPI.onUsageUpdated?.((snap: UsageSnapshot) => {
      setUsage(snap);
      setUnavailable(false);
    });
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => { unsub?.(); clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = usage?.sessionPercent ?? 0;
  const weekly = usage?.weeklyPercent ?? 0;
  const limiting = Math.max(session, weekly);
  const status = statusLine(limiting);
  const today = daily?.today ?? 0;

  return (
    <div className="rounded-2xl border border-[var(--border)] glass-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-7 h-7 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
            <Gauge className="w-4 h-4" />
          </span>
          <div>
            <h2 className="font-display text-sm font-semibold text-[var(--text-primary)]">Claude Code Usage</h2>
            <p className="text-[11px] text-[var(--text-muted)]">Rolling limits &amp; today's spend</p>
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          title="Refresh usage"
          className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {unavailable && !usage ? (
        <div className="px-4 py-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Activity className="w-4 h-4 shrink-0" />
          Usage data unavailable — ensure the <code className="font-mono-ui">claude</code> CLI is installed and signed in.
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {/* Meters */}
          <div className="flex gap-6 flex-wrap">
            <Meter label="5-hour session" icon={Clock} usedPercent={session} resetText={usage?.sessionResetTime} />
            <Meter label="Weekly" icon={TrendingUp} usedPercent={weekly} resetText={usage?.weeklyResetTime} />
          </div>

          {/* Status hint */}
          <div className={cn('text-[11px] font-medium', status.cls)}>{status.text}</div>

          {/* Today's spend + sparkline */}
          <div className="flex items-center justify-between gap-4 pt-3 border-t border-[var(--border)]">
            <div className="flex items-center gap-3">
              <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400">
                <Coins className="w-4 h-4" />
              </span>
              <div>
                <div className="font-mono-ui text-lg font-semibold text-[var(--text-primary)] leading-none">
                  ${today.toFixed(2)}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">spent today</div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              {daily && (
                <div className="hidden sm:flex flex-col items-end gap-0.5 text-[10px] text-[var(--text-muted)]">
                  <span>Yesterday <span className="font-mono-ui text-[var(--text-secondary)]">${daily.yesterday.toFixed(2)}</span></span>
                  <span>This week <span className="font-mono-ui text-[var(--text-secondary)]">${daily.week.toFixed(2)}</span></span>
                </div>
              )}
              {daily && <Sparkline series={daily.byDay} />}
            </div>
          </div>
          {/* Per-model breakdown */}
          {daily && daily.byModel && daily.byModel.length > 0 && (
            <div className="pt-3 border-t border-[var(--border)]">
              <div className="flex items-center justify-between mb-2.5">
                <span className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] font-medium">
                  <Cpu className="w-3.5 h-3.5" /> By model
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">last 7 days</span>
              </div>
              <div className="space-y-2.5">
                {daily.byModel.map((m) => (
                  <ModelRow key={m.model} m={m} weekTotal={daily.week} />
                ))}
              </div>
            </div>
          )}

          {daily && (
            <p className="text-[10px] text-[var(--text-muted)]">
              Spend is estimated from your imported tasks' Claude sessions (last 7 days). Limits above are Claude's official 5-hour and weekly windows.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
