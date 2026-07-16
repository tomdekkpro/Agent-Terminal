import { useState, useEffect, useCallback } from 'react';
import { Zap } from 'lucide-react';
import type { ProjectSkill } from '../../../shared/types';
import { useProjectStore } from '../../stores/project-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { SkillsPanel } from '../terminal/SkillsPanel';
import { cn } from '../../../shared/utils';
import { sendAgentPrompt } from '../../lib/send-agent-prompt';

/** Skills toggle button that opens the SkillsPanel as a fixed-position right drawer.
 *  When invoked from a context where there's an active terminal, sends the skill prompt to it.
 *  Otherwise copies the skill prompt to the clipboard so the user can paste it into a new terminal. */
export function ProjectSkillsAction() {
  const activeProject = useProjectStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [claudeSkills, setClaudeSkills] = useState<ProjectSkill[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!activeProject?.path) { setClaudeSkills([]); return; }
    window.electronAPI.loadClaudeSkills(activeProject.path)
      .then((result: any) => {
        if (result?.success && result.data) setClaudeSkills(result.data);
      })
      .catch(() => {});
  }, [activeProject?.path]);

  const projectSkills: ProjectSkill[] = [
    ...(activeProject?.skills || []),
    ...claudeSkills,
  ];

  const handleInvoke = useCallback(async (skill: ProjectSkill) => {
    const active = useTerminalStore.getState().getActiveTerminal();
    if (active) {
      try {
        // Bracketed paste (no auto-submit) so multi-line skill prompts aren't
        // truncated at the first newline; user reviews then presses Enter.
        sendAgentPrompt(active.id, skill.prompt, { submit: false });
        setToast(`Sent "${skill.name}" to active terminal`);
      } catch {
        setToast('Failed to send skill to terminal');
      }
    } else {
      try {
        await navigator.clipboard.writeText(skill.prompt);
        setToast(`Copied "${skill.name}" prompt — paste into a terminal`);
      } catch {
        setToast('No active terminal and clipboard write failed');
      }
    }
    setTimeout(() => setToast(null), 3500);
  }, []);

  if (!activeProject || projectSkills.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setSkillsOpen((v) => !v)}
        title={skillsOpen ? 'Close skills panel' : 'Open skills panel'}
        className={cn(
          'flex items-center gap-1 px-2 h-7 rounded-md text-[11px] transition-all',
          'hover:bg-[var(--bg-tertiary)] border border-transparent',
          skillsOpen
            ? 'text-violet-400 border-violet-500/20 bg-violet-500/10'
            : 'text-[var(--text-muted)]',
        )}
      >
        <Zap className="w-3 h-3" />
        <span>Skills</span>
      </button>
      {skillsOpen && (
        <div className="fixed top-0 right-0 bottom-0 w-80 z-40 bg-[var(--bg-secondary)] border-l border-[var(--border)] shadow-2xl flex flex-col min-h-0">
          <SkillsPanel
            skills={projectSkills}
            onInvokeSkill={handleInvoke}
            projectPath={activeProject.path}
            onClose={() => setSkillsOpen(false)}
          />
        </div>
      )}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 px-3 py-2 rounded-md text-xs bg-violet-500/20 text-violet-300 border border-violet-500/30 shadow-lg">
          {toast}
        </div>
      )}
    </>
  );
}
