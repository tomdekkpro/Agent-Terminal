import { useState, useEffect, useRef, useCallback } from 'react';
import { Sparkles, PanelLeftClose, PanelLeftOpen, Square, Send, FolderOpen, AlertCircle, X, ChevronDown, Download, Users, User, ClipboardList, Play, Terminal, Settings2, Share2, Globe, Ticket } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useInsightsStore } from '../../stores/insights-store';
import { useProjectStore } from '../../stores/project-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { sendAgentPrompt } from '../../lib/send-agent-prompt';
import { ChatMessage } from './ChatMessage';
import { ModelSelector } from './ModelSelector';
import { SessionSidebar } from './SessionSidebar';
import { PersonaBadge } from './PersonaBadge';
import { PersonaManager } from './PersonaManager';
import { PipelineCard } from './PipelineCard';
import { TaskPickerModal } from '../terminal/TerminalView';
import type { AgentProviderId, AgentProviderMeta, InsightsModel, InsightsMessage, Persona, SharedSessionInfo, TaskManagerTask } from '../../../shared/types';
import { cn } from '../../../shared/utils';
import { useTeamStore, onSessionMessage, onSessionParticipants } from '../../stores/team-store';

const QUICK_PROMPTS = [
  { label: 'Explain codebase', prompt: 'Give me a high-level overview of this codebase. What are the main components, how are they organized, and what does the application do?' },
  { label: 'Find bugs', prompt: 'Review this codebase for potential bugs, error handling issues, or edge cases that could cause problems. Focus on the most impactful issues.' },
  { label: 'Suggest improvements', prompt: 'What are the top improvements you would suggest for this codebase? Consider code quality, architecture, performance, and maintainability.' },
  { label: 'Optimize performance', prompt: 'Analyze this codebase for performance bottlenecks and suggest specific optimizations. Focus on areas that would have the biggest impact.' },
];

function StreamingMessage({ text, providerLabel, persona }: { text: string; providerLabel: string; persona?: Persona }) {
  return (
    <div className="flex gap-3 px-4 py-3 bg-[var(--bg-secondary)]/30">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-purple-500/20 text-purple-400">
        {persona ? <PersonaBadge persona={persona} showName={false} size="sm" thinking /> : <Sparkles className="w-4 h-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium" style={persona ? { color: persona.color } : undefined}>
            {persona ? `${persona.name} (${persona.role})` : providerLabel}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-[var(--accent)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
            {text ? 'writing...' : 'thinking...'}
          </span>
        </div>
        {text ? (
          <div className="insights-prose text-sm text-[var(--text-primary)]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        ) : (
          <div className="flex gap-1 py-2">
            <span className="w-2 h-2 rounded-full bg-[var(--text-muted)] animate-bounce [animation-delay:0ms]" />
            <span className="w-2 h-2 rounded-full bg-[var(--text-muted)] animate-bounce [animation-delay:150ms]" />
            <span className="w-2 h-2 rounded-full bg-[var(--text-muted)] animate-bounce [animation-delay:300ms]" />
          </div>
        )}
      </div>
    </div>
  );
}

export function InsightsView() {
  const store = useInsightsStore();
  const {
    sessions, activeSession, isStreaming, streamingText, streamingPersonaId,
    sidebarOpen, error, selectedProjectPath, selectedProvider, searchQuery, personas,
    loadSessions, selectSession, createSession, createRoundTableSession,
    deleteSession, renameSession, sendMessage, advanceRoundTable,
    abortStream, toggleSidebar, handleStreamEvent, clearError,
    setSelectedProjectPath, setSelectedProvider, setSearchQuery,
    togglePin, deleteMessage, retryLastMessage, exportSession,
    loadPersonas, generateSpec, addStatusMessage, linkTerminal,
    linkTask, unlinkTask,
  } = store;

  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const settingsProvider = useSettingsStore((s) => s.settings.defaultAgentProvider) || 'claude';
  const settingsAgentModels = useSettingsStore((s) => s.settings.agentModels) || {};
  const addTerminal = useTerminalStore((s) => s.addTerminal);

  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [agentProviders, setAgentProviders] = useState<AgentProviderMeta[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [showNewChatMenu, setShowNewChatMenu] = useState(false);
  const [showPersonaManager, setShowPersonaManager] = useState(false);
  const [showPersonaSelector, setShowPersonaSelector] = useState(false);
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<string[]>([]);
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  // @mention autocomplete
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);

  // Team integration
  const teamConnected = useTeamStore((s) => s.connected);
  const teamUser = useTeamStore((s) => s.currentUser);
  const sharedSessions = useTeamStore((s) => s.sharedSessions);
  const teamShareSession = useTeamStore((s) => s.shareSession);
  const teamJoinSession = useTeamStore((s) => s.joinSession);
  const teamSendSessionMessage = useTeamStore((s) => s.sendSessionMessage);

  // Listen for incoming session messages from teammates
  useEffect(() => {
    const unsubMsg = onSessionMessage((sessionId, message) => {
      const { activeSession } = useInsightsStore.getState();
      if (activeSession?.id === sessionId) {
        // Append teammate's message to active session
        useInsightsStore.setState({
          activeSession: {
            ...activeSession,
            messages: [...activeSession.messages, message],
          },
        });
      }
    });

    const unsubParticipants = onSessionParticipants((sessionId, participants) => {
      const { activeSession } = useInsightsStore.getState();
      if (activeSession?.id === sessionId) {
        useInsightsStore.setState({
          activeSession: { ...activeSession, participants },
        });
      }
    });

    return () => { unsubMsg(); unsubParticipants(); };
  }, []);

  const handleShareSession = useCallback(async () => {
    if (!activeSession || !teamConnected || !teamUser) return;
    const personaNames = (activeSession.personas || []).map((pid) => {
      const p = personas.find((pp) => pp.id === pid);
      return p?.name || pid;
    });
    const info: SharedSessionInfo = {
      id: activeSession.id,
      title: activeSession.title,
      owner: teamUser.username,
      repo: teamUser.repo,
      mode: activeSession.mode || 'single',
      personas: personaNames,
      participantCount: (activeSession.participants?.length || 0) + 1,
      messageCount: activeSession.messages.length,
    };
    await teamShareSession(info);
    // Mark session as shared
    await window.electronAPI.insightsUpdateSession(activeSession.id, { shared: true });
    useInsightsStore.setState({
      activeSession: { ...activeSession, shared: true },
    });
  }, [activeSession, teamConnected, teamUser, personas, teamShareSession]);

  const handleJoinSharedSession = useCallback(async (session: SharedSessionInfo) => {
    await teamJoinSession(session.id);
    // Check if we already have this session locally, if not create a placeholder
    const existing = sessions.find((s) => s.id === session.id);
    if (existing) {
      await selectSession(session.id);
    }
    // The session content will sync through session-message events
  }, [teamJoinSession, sessions, selectSession]);

  // Load agent providers and personas on mount
  useEffect(() => {
    window.electronAPI.getAgentProviders?.()
      .then((result: any) => {
        if (result.success && result.data) setAgentProviders(result.data);
      })
      .catch(() => {});
    loadPersonas();
  }, [loadPersonas]);

  const currentProviderMeta = agentProviders.find((p) => p.id === selectedProvider);
  const currentModels = currentProviderMeta?.models || [];

  useEffect(() => {
    if (!currentProviderMeta) return;
    const savedModel = settingsAgentModels[currentProviderMeta.id];
    if (savedModel && currentModels.some((m) => m.id === savedModel)) {
      setSelectedModel(savedModel);
    } else {
      setSelectedModel(currentProviderMeta.defaultModel);
    }
  }, [selectedProvider, currentProviderMeta, currentModels, settingsAgentModels]);

  const prevSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const currentId = activeSession?.id ?? null;
    if (prevSessionIdRef.current === undefined) {
      prevSessionIdRef.current = currentId;
      if (activeSession?.provider) setSelectedProvider(activeSession.provider);
      else if (!activeSession) setSelectedProvider(settingsProvider as AgentProviderId);
    } else if (currentId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = currentId;
      if (activeSession?.provider) setSelectedProvider(activeSession.provider);
    }
  }, [activeSession, settingsProvider, setSelectedProvider]);

  useEffect(() => {
    if (selectedProjectPath === null && activeProjectId) {
      const proj = projects.find((p) => p.id === activeProjectId);
      if (proj) setSelectedProjectPath(proj.path);
    }
  }, [activeProjectId, projects, selectedProjectPath, setSelectedProjectPath]);

  useEffect(() => {
    loadSessions();
    const cleanup = window.electronAPI.onInsightsStreamEvent(handleStreamEvent);
    return () => { cleanup(); };
  }, [loadSessions, handleStreamEvent]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages, streamingText]);

  useEffect(() => {
    if (activeSession?.model) setSelectedModel(activeSession.copilotModel || activeSession.model);
  }, [activeSession?.model, activeSession?.copilotModel]);

  // Ctrl+I focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'i' && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (textareaRef.current) { e.preventDefault(); textareaRef.current.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // File drag-and-drop on input area
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el) return;
    let dragCounter = 0;
    const onDragEnter = (e: DragEvent) => { e.preventDefault(); dragCounter++; if (e.dataTransfer?.types.includes('Files')) setIsDragOver(true); };
    const onDragOver = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const onDragLeave = (e: DragEvent) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; setIsDragOver(false); } };
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation(); setIsDragOver(false); dragCounter = 0;
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        let p: string | undefined;
        try { p = window.electronAPI.getPathForFile(files[i]); } catch { p = (files[i] as any).path; }
        if (p) paths.push(p);
      }
      if (paths.length > 0) {
        setInput((prev) => prev ? `${prev} ${paths.join(' ')}` : paths.join(' '));
        textareaRef.current?.focus();
      }
    };
    el.addEventListener('dragenter', onDragEnter, true);
    el.addEventListener('dragover', onDragOver, true);
    el.addEventListener('dragleave', onDragLeave, true);
    el.addEventListener('drop', onDrop, true);
    return () => { el.removeEventListener('dragenter', onDragEnter, true); el.removeEventListener('dragover', onDragOver, true); el.removeEventListener('dragleave', onDragLeave, true); el.removeEventListener('drop', onDrop, true); };
  }, []);

  const getModelParams = useCallback(() => {
    const currentProvider = useInsightsStore.getState().selectedProvider;
    const isClaudeProvider = currentProvider === 'claude';
    const insightsModel: InsightsModel = isClaudeProvider ? (selectedModel as InsightsModel) || 'sonnet' : 'sonnet';
    const agentModel = !isClaudeProvider ? selectedModel : undefined;
    return { insightsModel, agentModel };
  }, [selectedModel]);

  // Parse @mentions from text — returns { mentioned: Persona[], cleanText: string }
  const parseMentions = useCallback((text: string) => {
    const mentioned: Persona[] = [];
    let cleanText = text;
    // Match @PersonaName patterns (case-insensitive)
    for (const p of personas) {
      const pattern = new RegExp(`@${p.name}\\b`, 'gi');
      if (pattern.test(text)) {
        mentioned.push(p);
        cleanText = cleanText.replace(pattern, '').trim();
      }
    }
    return { mentioned, cleanText: cleanText || text };
  }, [personas]);

  // Filtered personas for @mention autocomplete
  const mentionSuggestions = mentionQuery !== null
    ? personas.filter((p) =>
        p.name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
        p.role.toLowerCase().includes(mentionQuery.toLowerCase())
      )
    : [];

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    // Detect @mention trigger
    const cursorPos = e.target.selectionStart || 0;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\w*)$/);

    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionStartPos(cursorPos - atMatch[0].length);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  const insertMention = (persona: Persona) => {
    const before = input.slice(0, mentionStartPos);
    const after = input.slice(textareaRef.current?.selectionStart || input.length);
    const newInput = `${before}@${persona.name} ${after}`;
    setInput(newInput);
    setMentionQuery(null);
    textareaRef.current?.focus();
    // Set cursor position after the inserted mention
    setTimeout(() => {
      const pos = mentionStartPos + persona.name.length + 2; // @name + space
      textareaRef.current?.setSelectionRange(pos, pos);
    }, 0);
  };

  // Broadcast new messages to team if session is shared
  const broadcastNewMessages = useCallback((prevCount: number) => {
    const session = useInsightsStore.getState().activeSession;
    if (!session?.shared || !teamConnected) return;
    const newMsgs = session.messages.slice(prevCount);
    for (const msg of newMsgs) {
      if (!msg.teamUser) { // Don't re-broadcast messages from teammates
        teamSendSessionMessage(session.id, msg);
      }
    }
  }, [teamConnected, teamSendSessionMessage]);

  const handleSend = useCallback(async (content: string) => {
    const text = content.trim();
    if (!text || isStreaming) return;
    setInput('');
    setMentionQuery(null);

    const { insightsModel, agentModel } = getModelParams();
    const prevMsgCount = activeSession?.messages.length || 0;

    // Check for @mentions — route to specific persona(s)
    if (activeSession?.mode === 'roundtable') {
      const { mentioned, cleanText } = parseMentions(text);

      if (mentioned.length > 0) {
        // Show user message optimistically
        const optimisticMsg = {
          id: `temp-${Date.now()}`,
          role: 'user' as const,
          content: text,
          timestamp: new Date().toISOString(),
        };
        useInsightsStore.setState({
          activeSession: { ...activeSession, messages: [...activeSession.messages, optimisticMsg] },
        });

        // Send to mentioned personas — first call also saves the user message to backend
        for (let i = 0; i < mentioned.length; i++) {
          const persona = mentioned[i];
          const contextMsg = `The user asked you specifically: "${cleanText}"\n\nPlease respond from your perspective as ${persona.name} (${persona.role}). Consider what other team members have already said in this discussion.`;
          await useInsightsStore.getState().sendPersonaMessage(
            contextMsg, persona, insightsModel, agentModel,
            i === 0 ? text : undefined, // only first call saves the user message
          );
        }
        // Refresh sidebar once after all responses complete
        await useInsightsStore.getState().loadSessions();
        broadcastNewMessages(prevMsgCount);
        return;
      }

      // No specific mention — advance through all personas
      await advanceRoundTable(text, insightsModel, agentModel);
      broadcastNewMessages(prevMsgCount);
      return;
    }

    // Normal single mode
    if (!activeSession) {
      const session = await createSession(insightsModel, selectedProjectPath ?? undefined, useInsightsStore.getState().selectedProvider, agentModel);
      if (!session) return;
      useInsightsStore.getState().sendMessage(text, insightsModel, agentModel);
      return;
    }
    await sendMessage(text, insightsModel, agentModel);
    broadcastNewMessages(prevMsgCount);
  }, [activeSession, isStreaming, selectedProjectPath, createSession, sendMessage, advanceRoundTable, getModelParams, parseMentions, store, broadcastNewMessages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle mention autocomplete navigation
    if (mentionQuery !== null && mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        insertMention(mentionSuggestions[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(input); }
  };

  useEffect(() => {
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; }
  }, [input]);

  const handleNewSingleChat = async () => {
    const { insightsModel, agentModel } = getModelParams();
    await createSession(insightsModel, selectedProjectPath ?? undefined, useInsightsStore.getState().selectedProvider, agentModel);
    setShowNewChatMenu(false);
  };

  const handleNewRoundTable = () => {
    setShowNewChatMenu(false);
    setSelectedPersonaIds(personas.map((p) => p.id));
    setShowPersonaSelector(true);
  };

  const handleStartRoundTable = async () => {
    if (selectedPersonaIds.length === 0) return;
    const { insightsModel, agentModel } = getModelParams();
    await createRoundTableSession(insightsModel, selectedPersonaIds, selectedProjectPath ?? undefined, useInsightsStore.getState().selectedProvider, agentModel);
    setShowPersonaSelector(false);
  };

  const handleExport = async () => {
    const md = await exportSession();
    if (md) navigator.clipboard.writeText(md);
  };

  const handleRetry = () => {
    const { insightsModel, agentModel } = getModelParams();
    retryLastMessage(insightsModel, agentModel);
  };

  const handleGenerateSpec = async () => {
    await generateSpec();
  };

  const handleImplement = async () => {
    if (!activeSession) return;
    // Find the spec message
    const specMsg = activeSession.messages.find((m) => m.messageType === 'spec');
    const specContent = specMsg?.content || '';
    if (!specContent) return;

    // Create a new terminal
    const terminal = addTerminal(activeSession.projectPath);
    if (!terminal) return;
    const terminalId = terminal.id;

    // Link terminal to session
    await linkTerminal(terminalId);

    // Add implementation card
    await addStatusMessage('Implementation started', 'implementation', { terminalId, status: 'running' });

    // Create the terminal PTY
    await window.electronAPI.createTerminal({ id: terminalId, cwd: activeSession.projectPath || '', cols: 80, rows: 24 });

    // Start the agent with the spec
    const provider = activeSession.provider || 'claude';
    await window.electronAPI.invokeAgent(terminalId, provider, {
      cwd: activeSession.projectPath,
      skipPermissions: false,
    });

    // Send the spec as the first prompt after a brief delay
    setTimeout(() => {
      const prompt = `Please implement the following specification:\n\n${specContent}`;
      sendAgentPrompt(terminalId, prompt);
    }, 2000);
  };

  const handleProviderChange = (provider: AgentProviderId) => setSelectedProvider(provider);

  const messages: InsightsMessage[] = activeSession?.messages ?? [];
  const providerLocked = !!activeSession && messages.length > 0;
  const providerLabel = currentProviderMeta?.displayName || selectedProvider;
  const isRoundTable = activeSession?.mode === 'roundtable';
  const discussionStatus = activeSession?.discussionStatus;

  // Find last assistant message index
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
  }

  // Get streaming persona
  const streamingPersona = streamingPersonaId ? personas.find((p) => p.id === streamingPersonaId) : undefined;

  // Get persona for a message
  const getPersona = (msg: InsightsMessage) => msg.personaId ? personas.find((p) => p.id === msg.personaId) : undefined;

  return (
    <div className="flex h-full relative">
      {showPersonaManager && <PersonaManager onClose={() => setShowPersonaManager(false)} />}
      {showTaskPicker && (
        <TaskPickerModal
          mode="link"
          onSelect={(task: TaskManagerTask) => {
            linkTask({
              id: task.id,
              customId: task.customId,
              name: task.name,
              status: task.status.name,
              statusColor: task.status.color,
              url: task.url,
              provider: task.provider,
            });
            setShowTaskPicker(false);
          }}
          onCancel={() => setShowTaskPicker(false)}
        />
      )}

      {/* Persona selector for new round table */}
      {showPersonaSelector && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setShowPersonaSelector(false)}>
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl w-[400px] p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-[var(--text-primary)] mb-3 flex items-center gap-2">
              <Users className="w-4 h-4 text-[var(--accent)]" /> Select Participants
            </h3>
            <div className="space-y-2 mb-4">
              {personas.map((p) => (
                <label key={p.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedPersonaIds.includes(p.id)}
                    onChange={(e) => {
                      setSelectedPersonaIds((prev) =>
                        e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)
                      );
                    }}
                    className="rounded"
                  />
                  <PersonaBadge persona={p} size="sm" />
                  <span className="text-xs text-[var(--text-muted)]">{p.role}</span>
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowPersonaSelector(false)} className="text-xs text-[var(--text-muted)] px-3 py-1.5 rounded hover:bg-[var(--bg-tertiary)]">Cancel</button>
              <button
                onClick={handleStartRoundTable}
                disabled={selectedPersonaIds.length === 0}
                className="flex items-center gap-1 text-xs text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] px-3 py-1.5 rounded disabled:opacity-50"
              >
                <Play className="w-3 h-3" /> Start Round Table
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session sidebar */}
      {sidebarOpen && (
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSession?.id ?? null}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSelect={selectSession}
          onNew={handleNewSingleChat}
          onDelete={deleteSession}
          onRename={renameSession}
          onTogglePin={togglePin}
          sharedSessions={teamConnected ? sharedSessions : []}
          onJoinSharedSession={handleJoinSharedSession}
        />
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
          <button onClick={toggleSidebar} className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors" title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}>
            {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>

          {isRoundTable ? (
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-[var(--accent)]" />
              <span className="text-sm font-medium text-[var(--text-primary)]">{activeSession?.title || 'Round Table'}</span>
              {/* Participant badges */}
              <div className="flex items-center gap-1 ml-1">
                {activeSession?.personas?.map((pid) => {
                  const p = personas.find((pp) => pp.id === pid);
                  return p ? <PersonaBadge key={p.id} persona={p} showName={false} size="sm" /> : null;
                })}
              </div>
              {/* Status badge */}
              {discussionStatus && (
                <span className={cn(
                  'text-[10px] px-2 py-0.5 rounded-full font-medium',
                  discussionStatus === 'discussing' && 'bg-sky-500/20 text-sky-400',
                  discussionStatus === 'spec-ready' && 'bg-indigo-500/20 text-indigo-400',
                  discussionStatus === 'implementing' && 'bg-emerald-500/20 text-emerald-400',
                  discussionStatus === 'reviewing' && 'bg-amber-500/20 text-amber-400',
                  discussionStatus === 'completed' && 'bg-green-500/20 text-green-400',
                )}>
                  {discussionStatus.replace('-', ' ')}
                </span>
              )}
            </div>
          ) : (
            <>
              <Sparkles className="w-4 h-4 text-[var(--accent)]" />
              <span className="text-sm font-medium text-[var(--text-primary)]">{activeSession?.title || 'Chat'}</span>
            </>
          )}

          {/* Project picker */}
          <div className="relative">
            <select value={selectedProjectPath ?? ''} onChange={(e) => setSelectedProjectPath(e.target.value || null)} disabled={isStreaming} className="appearance-none text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border)] rounded-md pl-6 pr-5 py-1 outline-none focus:border-[var(--accent)] disabled:opacity-50 cursor-pointer max-w-[180px] truncate">
              <option value="">No project</option>
              {projects.map((p) => (<option key={p.id} value={p.path}>{p.name}</option>))}
            </select>
            <FolderOpen className="w-3 h-3 absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
            <ChevronDown className="w-3 h-3 absolute right-1 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Pipeline actions */}
            {isRoundTable && !isStreaming && messages.length > 0 && (
              <>
                {discussionStatus === 'discussing' && (
                  <button onClick={handleGenerateSpec} className="flex items-center gap-1 text-xs text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 px-2.5 py-1 rounded-md transition-colors" title="Ask PM to generate implementation spec">
                    <ClipboardList className="w-3 h-3" /> Generate Spec
                  </button>
                )}
                {discussionStatus === 'spec-ready' && (
                  <button onClick={handleImplement} className="flex items-center gap-1 text-xs text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 px-2.5 py-1 rounded-md transition-colors" title="Create terminal and start implementation">
                    <Terminal className="w-3 h-3" /> Implement
                  </button>
                )}
              </>
            )}

            {/* Linked task */}
            {activeSession?.linkedTask ? (
              <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 max-w-[200px]">
                <Ticket className="w-2.5 h-2.5 shrink-0" />
                <button
                  onClick={() => window.electronAPI.openExternal?.(activeSession.linkedTask!.url)}
                  className="truncate hover:underline"
                  title={activeSession.linkedTask.name}
                >
                  {activeSession.linkedTask.customId || activeSession.linkedTask.name}
                </button>
                <button
                  onClick={() => unlinkTask()}
                  className="ml-0.5 hover:text-amber-200 shrink-0"
                  title="Unlink task"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ) : activeSession ? (
              <button
                onClick={() => setShowTaskPicker(true)}
                className="flex items-center gap-1 text-xs text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-2.5 py-1 rounded-md transition-colors"
                title="Link a ClickUp/Jira task"
              >
                <Ticket className="w-3 h-3" /> Link Task
              </button>
            ) : null}

            {/* Share with team */}
            {teamConnected && activeSession && !activeSession.shared && (
              <button
                onClick={handleShareSession}
                className="flex items-center gap-1 text-xs text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20 px-2.5 py-1 rounded-md transition-colors"
                title="Share this session with your team"
              >
                <Share2 className="w-3 h-3" /> Share
              </button>
            )}
            {activeSession?.shared && (
              <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full">
                <Globe className="w-2.5 h-2.5" /> Shared
                {activeSession.participants && activeSession.participants.length > 0 && (
                  <span className="text-green-300">({activeSession.participants.length + 1})</span>
                )}
              </span>
            )}

            {/* Persona manager */}
            <button onClick={() => setShowPersonaManager(true)} className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors" title="Manage personas">
              <Settings2 className="w-3.5 h-3.5" />
            </button>

            {/* New chat dropdown */}
            <div className="relative">
              <button onClick={() => setShowNewChatMenu(!showNewChatMenu)} className="flex items-center gap-1 text-xs text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20 px-2.5 py-1 rounded-md transition-colors">
                New Chat <ChevronDown className="w-3 h-3" />
              </button>
              {showNewChatMenu && (
                <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl overflow-hidden">
                  <button onClick={handleNewSingleChat} className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] flex items-center gap-2">
                    <User className="w-3.5 h-3.5" /> Single Chat
                  </button>
                  <button onClick={handleNewRoundTable} className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] flex items-center gap-2">
                    <Users className="w-3.5 h-3.5" /> Round Table
                  </button>
                </div>
              )}
            </div>

            {activeSession && messages.length > 0 && (
              <button onClick={handleExport} className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors" title="Export chat to clipboard">
                <Download className="w-3.5 h-3.5" />
              </button>
            )}

            <select value={selectedProvider} onChange={(e) => handleProviderChange(e.target.value as AgentProviderId)} disabled={isStreaming || providerLocked} className="text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-muted)] border border-[var(--border)] rounded-md px-2 py-1 outline-none focus:border-[var(--accent)] disabled:opacity-50 cursor-pointer" title={providerLocked ? 'Provider locked' : 'Select AI provider'}>
              {agentProviders.length > 0 ? agentProviders.map((p) => (<option key={p.id} value={p.id}>{p.displayName}{!p.available ? ' (N/A)' : ''}</option>)) : (<><option value="claude">Claude Code</option><option value="copilot">GitHub Copilot</option></>)}
            </select>
            <ModelSelector models={currentModels} value={selectedModel} onChange={setSelectedModel} disabled={isStreaming} />
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-center gap-2 px-4 py-2 bg-[var(--error)]/10 border-b border-[var(--error)]/20">
            <AlertCircle className="w-4 h-4 text-[var(--error)] shrink-0" />
            <span className="text-xs text-[var(--error)] flex-1">{error}</span>
            <button onClick={clearError} className="text-[var(--error)] hover:text-[var(--error)]/80"><X className="w-3 h-3" /></button>
          </div>
        )}

        {/* Messages or empty state */}
        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 && !isStreaming ? (
            <div className="flex flex-col items-center justify-center h-full gap-6 px-4">
              <div className="flex flex-col items-center gap-3">
                <div className="w-16 h-16 rounded-2xl bg-[var(--accent)]/10 flex items-center justify-center">
                  <Sparkles className="w-8 h-8 text-[var(--accent)]" />
                </div>
                <h2 className="text-lg font-medium text-[var(--text-primary)]">
                  {isRoundTable ? 'Start the discussion' : 'Start a conversation'}
                </h2>
                <p className="text-sm text-[var(--text-muted)] text-center max-w-md">
                  {isRoundTable
                    ? 'Describe the feature or topic. All personas will respond with their perspective.'
                    : `Ask questions about your code, get suggestions, or explore ideas with ${providerLabel}.`}
                </p>
              </div>
              {!isRoundTable && (
                <div className="grid grid-cols-2 gap-3 w-full max-w-lg">
                  {QUICK_PROMPTS.map((qp) => (
                    <button key={qp.label} onClick={() => handleSend(qp.prompt)} className={cn('text-left px-4 py-3 rounded-lg border border-[var(--border)]', 'bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors', 'text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]')}>
                      {qp.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              {messages.map((msg, idx) => {
                // Render pipeline cards for special message types
                if (msg.messageType && msg.messageType !== 'message') {
                  return <PipelineCard key={msg.id} message={msg} />;
                }

                const msgPersona = getPersona(msg);
                return (
                  <ChatMessage
                    key={msg.id}
                    message={msg}
                    providerLabel={msgPersona ? `${msgPersona.name} (${msgPersona.role})` : providerLabel}
                    persona={msgPersona}
                    onDelete={!isStreaming ? deleteMessage : undefined}
                    onRetry={!isStreaming && idx === lastAssistantIdx ? handleRetry : undefined}
                    isLastAssistant={idx === lastAssistantIdx && msg.role === 'assistant'}
                  />
                );
              })}
              {isStreaming && <StreamingMessage text={streamingText} providerLabel={providerLabel} persona={streamingPersona} />}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input area */}
        <div ref={inputAreaRef} className={cn('border-t border-[var(--border)] bg-[var(--bg-secondary)] p-3 relative', isDragOver && 'ring-2 ring-[var(--accent)] ring-inset')}>
          {isDragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg-secondary)]/90 backdrop-blur-sm rounded">
              <span className="text-sm text-[var(--accent)] font-medium">Drop file to add path</span>
            </div>
          )}
          <div className="flex items-end gap-2 max-w-4xl mx-auto relative">
            {isRoundTable && (
              <div className="flex items-center gap-1 pb-2">
                {activeSession?.personas?.map((pid) => {
                  const p = personas.find((pp) => pp.id === pid);
                  return p ? <PersonaBadge key={p.id} persona={p} showName={false} size="sm" /> : null;
                })}
              </div>
            )}

            {/* @mention autocomplete dropdown */}
            {mentionQuery !== null && mentionSuggestions.length > 0 && (
              <div className="absolute bottom-full mb-1 left-0 z-50 w-56 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl overflow-hidden">
                {mentionSuggestions.map((p, idx) => (
                  <button
                    key={p.id}
                    onClick={() => insertMention(p)}
                    className={cn(
                      'w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors',
                      idx === mentionIndex ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-tertiary)]',
                    )}
                  >
                    <PersonaBadge persona={p} showName={false} size="sm" />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium" style={{ color: p.color }}>@{p.name}</span>
                      <span className="text-[var(--text-muted)] ml-1.5">{p.role}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onBlur={() => setTimeout(() => setMentionQuery(null), 200)}
              placeholder={isRoundTable ? 'Type @ to mention a persona, or describe topic for all...' : 'Ask anything... (drop files to add paths)'}
              rows={1}
              disabled={isStreaming}
              className={cn('flex-1 resize-none bg-[var(--bg-primary)] text-sm text-[var(--text-primary)]', 'border border-[var(--border)] rounded-lg px-3 py-2.5 outline-none', 'focus:border-[var(--accent)] placeholder:text-[var(--text-muted)]', 'disabled:opacity-50')}
            />
            {isStreaming ? (
              <button onClick={abortStream} className="w-9 h-9 rounded-lg bg-[var(--error)]/20 text-[var(--error)] flex items-center justify-center hover:bg-[var(--error)]/30 transition-colors shrink-0" title="Stop">
                <Square className="w-4 h-4" />
              </button>
            ) : (
              <button onClick={() => handleSend(input)} disabled={!input.trim()} className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors', input.trim() ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]')} title="Send (Enter)">
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
