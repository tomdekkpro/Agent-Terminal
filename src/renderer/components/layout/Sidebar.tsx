import { Terminal, Kanban, ShieldCheck, Sparkles, GitPullRequestDraft, Settings } from 'lucide-react';
import type { ViewType } from '../../App';
import { cn } from '../../../shared/utils';
import { APP_VERSION } from '../../lib/version';

interface SidebarProps {
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
}

const navItems: { id: ViewType; icon: typeof Terminal; label: string; shortcut: string }[] = [
  { id: 'terminals', icon: Terminal, label: 'Terminals', shortcut: 'Ctrl+T' },
  { id: 'kanban', icon: Kanban, label: 'Kanban Board', shortcut: 'Ctrl+K' },
  { id: 'qc', icon: ShieldCheck, label: 'QC Testing', shortcut: 'Ctrl+Q' },
  { id: 'insights', icon: Sparkles, label: 'Chat', shortcut: 'Ctrl+I' },
  { id: 'code-review', icon: GitPullRequestDraft, label: 'Code Review', shortcut: 'Ctrl+R' },
  { id: 'settings', icon: Settings, label: 'Settings', shortcut: 'Ctrl+S' },
];

/** Compact app logo — terminal prompt + AI nodes */
function AppLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="72" y="100" width="368" height="296" rx="24" fill="#1e1b4b"/>
      <rect x="72" y="100" width="368" height="44" rx="24" fill="#2e2960"/>
      <rect x="72" y="120" width="368" height="24" fill="#2e2960"/>
      <circle cx="104" cy="122" r="8" fill="#ef4444" opacity="0.9"/>
      <circle cx="130" cy="122" r="8" fill="#f59e0b" opacity="0.9"/>
      <circle cx="156" cy="122" r="8" fill="#22c55e" opacity="0.9"/>
      <path d="M112 200 L152 232 L112 264" stroke="#22c55e" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round"/>
      <rect x="174" y="218" width="12" height="28" rx="2" fill="#e2e8f0" opacity="0.85"/>
      <circle cx="290" cy="210" r="7" fill="#818cf8" opacity="0.8"/>
      <circle cx="332" cy="192" r="6" fill="#a78bfa" opacity="0.7"/>
      <circle cx="370" cy="216" r="7" fill="#818cf8" opacity="0.8"/>
      <circle cx="312" cy="250" r="6" fill="#a78bfa" opacity="0.7"/>
      <circle cx="355" cy="260" r="5" fill="#c4b5fd" opacity="0.6"/>
      <line x1="290" y1="210" x2="332" y2="192" stroke="#818cf8" strokeWidth="3" opacity="0.5"/>
      <line x1="332" y1="192" x2="370" y2="216" stroke="#818cf8" strokeWidth="3" opacity="0.5"/>
      <line x1="290" y1="210" x2="312" y2="250" stroke="#818cf8" strokeWidth="3" opacity="0.5"/>
      <line x1="370" y1="216" x2="355" y2="260" stroke="#818cf8" strokeWidth="3" opacity="0.5"/>
      <line x1="312" y1="250" x2="355" y2="260" stroke="#818cf8" strokeWidth="3" opacity="0.5"/>
      <rect x="112" y="300" width="180" height="7" rx="3.5" fill="#475569" opacity="0.4"/>
      <rect x="112" y="322" width="130" height="7" rx="3.5" fill="#475569" opacity="0.3"/>
    </svg>
  );
}

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  return (
    <div className="w-16 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col items-center py-4 gap-2">
      {/* App icon */}
      <div className="w-10 h-10 rounded-xl bg-[var(--accent)] flex items-center justify-center mb-4 drag-region overflow-hidden">
        <AppLogo className="w-9 h-9 no-drag" />
      </div>

      {/* Navigation */}
      {navItems.map(({ id, icon: Icon, label, shortcut }) => (
        <button
          key={id}
          onClick={() => onViewChange(id)}
          title={`${label}  (${shortcut})`}
          className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-200',
            'hover:bg-[var(--bg-tertiary)]',
            activeView === id
              ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
              : 'text-[var(--text-muted)]'
          )}
        >
          <Icon className="w-5 h-5" />
        </button>
      ))}

      {/* Version at bottom */}
      <div className="mt-auto pt-2">
        <span className="text-[9px] text-[var(--text-muted)] opacity-40">v{APP_VERSION}</span>
      </div>
    </div>
  );
}
