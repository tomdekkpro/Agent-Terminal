import { useState, useEffect, useCallback } from 'react';
import { X, Zap, Search, Play } from 'lucide-react';
import type { ProjectSkill } from '../../../shared/types';
import { SkillIcon } from '../project/ProjectSettingsModal';
import { cn } from '../../../shared/utils';

interface SkillsPanelProps {
  skills: ProjectSkill[];
  onInvokeSkill: (skill: ProjectSkill) => void;
  projectPath?: string;
  onClose: () => void;
}

/**
 * Where to read a skill's markdown from.
 *
 * The loader now reports `filePath` directly, which is the only thing that
 * works for skills outside the project — a plugin skill such as `dp:ship`
 * lives in the plugin cache, not under `.claude/skills`, so guessing a
 * project-relative path could never find it. The guess is kept as a fallback
 * for skills that predate `filePath`.
 */
function resolveSkillPaths(projectPath: string | undefined, skill: ProjectSkill): string[] {
  if (skill.filePath) return [skill.filePath];
  if (!projectPath) return [];
  const name = skill.id.replace('claude-skill:', '');
  const base = projectPath.replace(/\\/g, '/');
  return [
    `${base}/.claude/skills/${name}/SKILL.md`,
    `${base}/.claude/skills/${name}.md`,
  ].map((p) => p.replace(/\//g, '\\'));
}

export function SkillsPanel({ skills, onInvokeSkill, projectPath, onClose }: SkillsPanelProps) {
  const [search, setSearch] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<ProjectSkill | null>(null);
  const [skillContent, setSkillContent] = useState<string | null>(null);

  // Skills configured by hand in project settings, versus the three kinds
  // discovered on disk. Plugin skills are listed separately because their name
  // is namespaced (`dp:ship`) and they are shared across every project the
  // plugin is enabled for, not owned by this one.
  const manualSkills = skills.filter((s) => !s.id.startsWith('claude-skill:'));
  const discovered = skills.filter((s) => s.id.startsWith('claude-skill:'));
  const claudeSkills = discovered.filter((s) => s.source !== 'plugin');
  const pluginSkills = discovered.filter((s) => s.source === 'plugin');

  const lower = search.toLowerCase();
  const filterFn = (s: ProjectSkill) =>
    !search || s.name.toLowerCase().includes(lower) || s.description?.toLowerCase().includes(lower);
  const filteredManual = manualSkills.filter(filterFn);
  const filteredClaude = claudeSkills.filter(filterFn);
  const filteredPlugin = pluginSkills.filter(filterFn);

  // Load skill file content when selected
  useEffect(() => {
    if (!selectedSkill) { setSkillContent(null); return; }

    // A hand-configured skill has no file — its prompt IS the content. A
    // discovered skill needs either its own filePath or a project to guess in.
    if (!selectedSkill.id.startsWith('claude-skill:') || (!selectedSkill.filePath && !projectPath)) {
      setSkillContent(selectedSkill.prompt);
      return;
    }

    let cancelled = false;
    const paths = resolveSkillPaths(projectPath, selectedSkill);
    (async () => {
      for (const p of paths) {
        try {
          const result = await window.electronAPI.readFile(p);
          if (!cancelled && result?.success) {
            setSkillContent(result.data);
            return;
          }
        } catch { /* try next */ }
      }
      if (!cancelled) setSkillContent(selectedSkill.description || selectedSkill.prompt);
    })();
    return () => { cancelled = true; };
  }, [selectedSkill, projectPath]);

  const handleInvoke = useCallback((skill: ProjectSkill) => {
    onInvokeSkill(skill);
  }, [onInvokeSkill]);

  const renderSkillItem = (skill: ProjectSkill) => {
    const isSelected = selectedSkill?.id === skill.id;
    return (
      <div
        key={skill.id}
        className={cn(
          'group/skill flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors rounded-md mx-1',
          isSelected
            ? 'bg-[var(--accent)]/10 border border-[var(--accent)]/30'
            : 'hover:bg-[var(--bg-tertiary)] border border-transparent',
        )}
        onClick={() => setSelectedSkill(isSelected ? null : skill)}
      >
        <div
          className="w-6 h-6 rounded flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${skill.color || '#6366f1'}20`, color: skill.color || '#6366f1' }}
        >
          <SkillIcon name={skill.icon || 'Zap'} className="w-3 h-3" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-[var(--text-primary)] truncate">{skill.name}</div>
          {skill.description && (
            <div className="text-[10px] text-[var(--text-muted)] truncate">{skill.description}</div>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); handleInvoke(skill); }}
          className="w-6 h-6 rounded flex items-center justify-center shrink-0 text-emerald-400 hover:bg-emerald-500/20 transition-colors opacity-0 group-hover/skill:opacity-100"
          title={`Run "${skill.name}"`}
        >
          <Play className="w-3 h-3" />
        </button>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)] border-l border-[var(--border)]">
      {/* Toolbar */}
      <div className="h-9 bg-[var(--bg-card)] border-b border-[var(--border)] flex items-center px-2 gap-1 shrink-0">
        <Zap className="w-3.5 h-3.5 text-violet-400 shrink-0" />
        <span className="text-[11px] text-[var(--text-primary)] font-medium truncate flex-1">Skills</span>
        <span className="text-[10px] text-[var(--text-muted)]">{skills.length}</span>
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
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search skills..."
            className="w-full text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded pl-7 pr-2 py-1 outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      {/* Skills list */}
      <div className={cn('overflow-y-auto py-1', selectedSkill ? 'max-h-[55%]' : 'flex-1')}>
        {filteredManual.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Project Skills
            </div>
            {filteredManual.map(renderSkillItem)}
          </>
        )}
        {filteredClaude.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] mt-1">
              .claude/skills
            </div>
            {filteredClaude.map(renderSkillItem)}
          </>
        )}
        {filteredPlugin.length > 0 && (
          <>
            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] mt-1">
              Plugin Skills
            </div>
            {filteredPlugin.map(renderSkillItem)}
          </>
        )}
        {filteredManual.length === 0 && filteredClaude.length === 0 && filteredPlugin.length === 0 && (
          <div className="text-center py-8 text-xs text-[var(--text-muted)]">
            {search ? 'No matching skills' : 'No skills configured'}
          </div>
        )}
      </div>

      {/* Selected skill detail */}
      {selectedSkill && (
        <div className="border-t border-[var(--border)] flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] shrink-0">
            <div
              className="w-5 h-5 rounded flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${selectedSkill.color || '#6366f1'}20`, color: selectedSkill.color || '#6366f1' }}
            >
              <SkillIcon name={selectedSkill.icon || 'Zap'} className="w-2.5 h-2.5" />
            </div>
            <span className="text-xs font-medium text-[var(--text-primary)] flex-1 truncate">{selectedSkill.name}</span>
            <button
              onClick={() => handleInvoke(selectedSkill)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors shrink-0"
              title={`Run "${selectedSkill.name}" in active terminal`}
            >
              <Play className="w-3 h-3" />
              Run
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            <pre className="text-[10px] text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono leading-relaxed">
              {skillContent || '...'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
