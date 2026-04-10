import { useState, useRef, useEffect } from 'react';
import { Zap, ChevronDown } from 'lucide-react';
import type { ProjectSkill } from '../../../shared/types';
import { SkillIcon } from '../project/ProjectSettingsModal';
import { cn } from '../../../shared/utils';

interface SkillsDropdownProps {
  skills: ProjectSkill[];
  onInvokeSkill: (skill: ProjectSkill) => void;
  disabled?: boolean;
}

export function SkillsDropdown({ skills, onInvokeSkill, disabled }: SkillsDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  if (skills.length === 0) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          'flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors',
          'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
        title="Run a skill"
      >
        <Zap className="w-3 h-3" />
        <span>Skills</span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {isOpen && (() => {
        const manualSkills = skills.filter((s) => !s.id.startsWith('claude-skill:'));
        const claudeSkills = skills.filter((s) => s.id.startsWith('claude-skill:'));

        const renderSkill = (skill: ProjectSkill) => (
          <button
            key={skill.id}
            onClick={() => { onInvokeSkill(skill); setIsOpen(false); }}
            className="w-full flex items-start gap-2.5 px-3 py-2 hover:bg-[var(--bg-tertiary)] transition-colors text-left"
          >
            <div
              className="w-6 h-6 rounded flex items-center justify-center shrink-0 mt-0.5"
              style={{ backgroundColor: `${skill.color || '#6366f1'}20`, color: skill.color || '#6366f1' }}
            >
              <SkillIcon name={skill.icon || 'Zap'} className="w-3 h-3" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-[var(--text-primary)]">{skill.name}</div>
              {skill.description && (
                <div className="text-[10px] text-[var(--text-muted)] truncate">{skill.description}</div>
              )}
            </div>
          </button>
        );

        return (
          <div className="absolute left-0 top-full mt-1 z-50 w-72 max-h-80 overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl">
            {manualSkills.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border)]">
                  Project Skills
                </div>
                {manualSkills.map(renderSkill)}
              </>
            )}
            {claudeSkills.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border)] flex items-center gap-1">
                  <span>.claude/skills</span>
                </div>
                {claudeSkills.map(renderSkill)}
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}
