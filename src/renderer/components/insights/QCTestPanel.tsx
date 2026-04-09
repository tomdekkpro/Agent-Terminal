import { useState, useEffect, useCallback, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Play, Square, CheckCircle, XCircle, AlertTriangle, Clock, ChevronDown, ChevronRight,
  RefreshCw, Loader2, Globe, FileText, ShieldCheck, Plus, Trash2, Pencil,
  Save, X, Image, KeyRound, Eye, EyeOff, Timer, GripVertical, RotateCcw,
  Link2, ExternalLink, Zap, MessageSquare, ClipboardCopy, Send, CheckCircle2,
} from 'lucide-react';
import type { QCTask, QCTestCase, QCTestStep, QCCredential, TaskManagerTask } from '../../../shared/types';
import { useSettingsStore } from '../../stores/settings-store';
import { cn } from '../../../shared/utils';
import { TaskPickerModal } from '../terminal/TerminalView';

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

interface QCTestPanelProps {
  sessionId: string;
  qcTask: QCTask | undefined;
  model: string;
  onTaskUpdate: (task: QCTask) => void | Promise<void>;
  onNewTask?: () => void;
  onRenameSession?: (title: string) => void | Promise<void>;
}

function StepStatusIcon({ status, running, executed, queued }: { status: QCTestStep['status']; running?: boolean; executed?: boolean; queued?: boolean }) {
  if (running) {
    return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
  }
  switch (status) {
    case 'passed':
      return <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-red-400" />;
    case 'skipped':
      return <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />;
    default:
      // Step was executed (before current running step) but final result not yet known
      if (executed) return <CheckCircle className="w-3.5 h-3.5 text-blue-400/60" />;
      // Step is queued — test is running but hasn't reached this step yet
      if (queued) return <Clock className="w-3.5 h-3.5 text-blue-400/40 animate-pulse" />;
      return <Clock className="w-3.5 h-3.5 text-[var(--text-muted)]" />;
  }
}

function TestCaseStatusIcon({ status }: { status: QCTestCase['status'] }) {
  switch (status) {
    case 'passed':
      return <CheckCircle className="w-4 h-4 text-emerald-400" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-400" />;
    case 'error':
      return <AlertTriangle className="w-4 h-4 text-red-400" />;
    case 'running':
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
    default:
      return <Clock className="w-4 h-4 text-[var(--text-muted)]" />;
  }
}

// ─── Editable Step Row ───────────────────────────────────────────

function EditableStep({
  step,
  editing,
  running,
  executed,
  queued,
  onSave,
  onDelete,
  onStartEdit,
  onCancel,
  dragOverStep,
  onDragStartStep,
  onDragOverStep,
  onDropStep,
  onDragEndStep,
}: {
  step: QCTestStep;
  editing: boolean;
  running?: boolean;
  executed?: boolean;
  queued?: boolean;
  onSave: (step: QCTestStep) => void;
  onDelete: () => void;
  onStartEdit: () => void;
  onCancel: () => void;
  dragOverStep?: string | null;
  onDragStartStep?: (id: string) => void;
  onDragOverStep?: (id: string | null) => void;
  onDropStep?: (fromId: string, toId: string) => void;
  onDragEndStep?: () => void;
}) {
  const [action, setAction] = useState(step.action);
  const [expected, setExpected] = useState(step.expected);

  useEffect(() => {
    setAction(step.action);
    setExpected(step.expected);
  }, [step, editing]);

  if (editing) {
    return (
      <div className="text-xs border border-[var(--accent)]/30 rounded-md p-3 bg-[var(--bg-primary)] space-y-2">
        <div className="flex items-center gap-2 text-[var(--text-muted)]">
          <span className="font-mono text-[10px]">Step {step.order}</span>
          <span className="text-[10px]">Editing</span>
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-muted)] uppercase font-medium block mb-1">Action</label>
          <textarea
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="Describe the action to perform..."
            rows={2}
            className="w-full min-h-[48px] text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
            autoFocus
          />
        </div>
        <div>
          <label className="text-[10px] text-[var(--text-muted)] uppercase font-medium block mb-1">Expected Result</label>
          <textarea
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            placeholder="Describe the expected result..."
            rows={2}
            className="w-full min-h-[48px] text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
          />
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => onSave({ ...step, action, expected })}
            disabled={!action.trim() || !expected.trim()}
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50"
          >
            <Save className="w-2.5 h-2.5" /> Save
          </button>
          <button
            onClick={onCancel}
            className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <X className="w-2.5 h-2.5" /> Cancel
          </button>
        </div>
      </div>
    );
  }

  const hasResult = step.status === 'passed' || step.status === 'failed';

  return (
    <div
      className={cn(
        "group/step text-xs border rounded-md overflow-hidden transition-colors",
        running ? "border-blue-500/30 bg-blue-500/5"
        : hasResult ? (step.status === 'passed' ? "border-emerald-500/20 bg-emerald-500/5" : "border-red-500/20 bg-red-500/5")
        : queued ? "border-blue-500/10 bg-blue-500/[0.02]"
        : "border-[var(--border)] bg-[var(--bg-primary)]",
        dragOverStep === step.id && "ring-2 ring-[var(--accent)]",
      )}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-qc-step', step.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStartStep?.(step.id);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-qc-step')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          onDragOverStep?.(step.id);
        }
      }}
      onDragLeave={() => onDragOverStep?.(null)}
      onDrop={(e) => {
        e.preventDefault();
        const fromId = e.dataTransfer.getData('application/x-qc-step');
        if (fromId && fromId !== step.id) onDropStep?.(fromId, step.id);
      }}
      onDragEnd={() => onDragEndStep?.()}
    >
      {/* Step header */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[var(--bg-secondary)]/50">
        <div className="shrink-0 cursor-grab active:cursor-grabbing text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
          <GripVertical className="w-3 h-3" />
        </div>
        <StepStatusIcon status={step.status} running={running} executed={executed} queued={queued} />
        <span className="text-[var(--text-muted)] font-mono text-[10px]">Step {step.order}</span>
        <span className="flex-1 text-[var(--text-primary)] truncate">{step.action}</span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover/step:opacity-100 transition-opacity shrink-0">
          <button
            onClick={onStartEdit}
            className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
            title="Edit step"
          >
            <Pencil className="w-2.5 h-2.5" />
          </button>
          <button
            onClick={onDelete}
            className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-red-400 transition-colors"
            title="Remove step"
          >
            <Trash2 className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>

      {/* Step body */}
      <div className="px-2.5 py-1.5 space-y-1">
        <div className="flex gap-1.5">
          <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase shrink-0 w-14 mt-px">Action</span>
          <p className="text-[var(--text-primary)] flex-1">{step.action}</p>
        </div>
        <div className="flex gap-1.5">
          <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase shrink-0 w-14 mt-px">Expected</span>
          <p className="text-[var(--text-secondary)] flex-1">{step.expected}</p>
        </div>
        {step.actual && (
          <div className="flex gap-1.5">
            <span className={cn("text-[10px] font-medium uppercase shrink-0 w-14 mt-px", step.status === 'passed' ? 'text-emerald-400' : 'text-red-400')}>Actual</span>
            <p className={cn('flex-1', step.status === 'passed' ? 'text-emerald-400' : 'text-red-400')}>
              {step.actual}
            </p>
          </div>
        )}
        {step.screenshot && (
          <div className="flex gap-1.5">
            <span className="text-[10px] font-medium text-[var(--text-muted)] uppercase shrink-0 w-14" />
            {(/\.(png|jpe?g|gif|webp)/i).test(step.screenshot) ? (
              <button
                className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded bg-blue-500/10 text-blue-400 hover:text-blue-300 hover:bg-blue-500/20 cursor-pointer transition-colors"
                onClick={() => window.electronAPI.openPath(step.screenshot!)}
                title="Click to open screenshot"
              >
                <Image className="w-3 h-3" />
                View Screenshot
              </button>
            ) : (
              <span className="flex items-center gap-1 text-[10px] text-blue-400/70">
                <Image className="w-3 h-3" />
                {step.screenshot}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Test Case Card ──────────────────────────────────────────────

function TestCaseCard({
  testCase,
  sessionId,
  model,
  runningStepOrder,
  onUpdate,
  onDelete,
  dragOverTc,
  onDragStartTc,
  onDragOverTc,
  onDropTc,
  onDragEndTc,
}: {
  testCase: QCTestCase;
  sessionId: string;
  model: string;
  runningStepOrder?: number;
  onUpdate: (tc: QCTestCase) => void;
  onDelete: () => void;
  dragOverTc?: string | null;
  onDragStartTc?: (id: string) => void;
  onDragOverTc?: (id: string | null) => void;
  onDropTc?: (fromId: string, toId: string) => void;
  onDragEndTc?: () => void;
}) {
  const isRunning = testCase.status === 'running';
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [nameText, setNameText] = useState(testCase.name);
  const [descText, setDescText] = useState(testCase.description);
  const [addingStep, setAddingStep] = useState(false);
  const [dragOverStepId, setDragOverStepId] = useState<string | null>(null);
  const [, setDraggingStepId] = useState<string | null>(null);

  // Auto-expand when running, auto-collapse when finished
  useEffect(() => {
    if (isRunning) {
      setExpanded(true);
    } else if (testCase.status === 'passed' || testCase.status === 'failed' || testCase.status === 'error') {
      setExpanded(false);
    }
  }, [isRunning, testCase.status]);

  const handleRunSingle = async () => {
    setRunning(true);
    try {
      const result = await window.electronAPI.qcRunSingleTest(sessionId, testCase.id, model);
      if (result.success) {
        onUpdate(result.data);
      }
    } finally {
      setRunning(false);
    }
  };

  const handleSaveName = () => {
    if (nameText.trim()) {
      onUpdate({ ...testCase, name: nameText.trim(), description: descText.trim() });
    }
    setEditingName(false);
  };

  const handleSaveStep = (updatedStep: QCTestStep) => {
    const newSteps = testCase.steps.map((s) => s.id === updatedStep.id ? updatedStep : s);
    onUpdate({ ...testCase, steps: newSteps, status: 'pending' });
    setEditingStepId(null);
  };

  const handleDeleteStep = (stepId: string) => {
    const newSteps = testCase.steps
      .filter((s) => s.id !== stepId)
      .map((s, i) => ({ ...s, order: i + 1 }));
    onUpdate({ ...testCase, steps: newSteps });
  };

  const handleAddStep = (action: string, expected: string) => {
    const newStep: QCTestStep = {
      id: uuidv4(),
      order: testCase.steps.length + 1,
      action,
      expected,
      status: 'pending',
    };
    onUpdate({ ...testCase, steps: [...testCase.steps, newStep], status: 'pending' });
    setAddingStep(false);
  };

  const handleStepDrop = (fromId: string, toId: string) => {
    const fromIdx = testCase.steps.findIndex((s) => s.id === fromId);
    const toIdx = testCase.steps.findIndex((s) => s.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...testCase.steps];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const renumbered = reordered.map((s, i) => ({ ...s, order: i + 1 }));
    onUpdate({ ...testCase, steps: renumbered });
    setDragOverStepId(null);
    setDraggingStepId(null);
  };

  return (
    <div
      className={cn(
        "border border-[var(--border)] rounded-lg overflow-hidden",
        dragOverTc === testCase.id && "border-t-2 border-t-[var(--accent)]",
      )}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-qc-testcase')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          onDragOverTc?.(testCase.id);
        }
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes('application/x-qc-testcase') && !e.currentTarget.contains(e.relatedTarget as Node)) {
          onDragOverTc?.(null);
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes('application/x-qc-testcase')) {
          e.preventDefault();
          const fromId = e.dataTransfer.getData('application/x-qc-testcase');
          if (fromId && fromId !== testCase.id) onDropTc?.(fromId, testCase.id);
        }
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors group/card"
        onClick={() => setExpanded(!expanded)}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-qc-testcase', testCase.id);
          e.dataTransfer.effectAllowed = 'move';
          onDragStartTc?.(testCase.id);
        }}
        onDragEnd={() => onDragEndTc?.()}
      >
        <div className="shrink-0 cursor-grab active:cursor-grabbing text-[var(--text-muted)] hover:text-[var(--text-secondary)]" title="Drag to reorder">
          <GripVertical className="w-3.5 h-3.5" />
        </div>
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
        <TestCaseStatusIcon status={testCase.status} />
        <span className="text-sm text-[var(--text-primary)] flex-1 truncate">{testCase.name}</span>
        {isRunning && runningStepOrder ? (
          <span className="text-[10px] text-blue-400 flex items-center gap-1">
            <Loader2 className="w-2.5 h-2.5 animate-spin" />
            Step {runningStepOrder}/{testCase.steps.length}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-muted)]">{testCase.steps.length} steps</span>
            {testCase.durationMs != null && (
              <span className="text-[10px] text-[var(--text-muted)] flex items-center gap-0.5">
                <Timer className="w-2.5 h-2.5" />
                {formatDuration(testCase.durationMs)}
              </span>
            )}
          </span>
        )}
        <div className="flex items-center gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(true); setEditingName(true); }}
            className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
            title="Edit test case"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-red-400 transition-colors"
            title="Remove test case"
          >
            <Trash2 className="w-3 h-3" />
          </button>
          {testCase.status !== 'running' && (
            <button
              onClick={(e) => { e.stopPropagation(); handleRunSingle(); }}
              disabled={running}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-50"
            >
              {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {running ? 'Running' : 'Run'}
            </button>
          )}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 py-2 space-y-2">
          {/* Editable name/description */}
          {editingName ? (
            <div className="space-y-2 p-3 border border-[var(--accent)]/30 rounded-md bg-[var(--bg-primary)]">
              <div>
                <label className="text-[10px] text-[var(--text-muted)] uppercase font-medium block mb-1">Test Case Name</label>
                <input
                  value={nameText}
                  onChange={(e) => setNameText(e.target.value)}
                  placeholder="Test case name"
                  className="w-full text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-[10px] text-[var(--text-muted)] uppercase font-medium block mb-1">Description</label>
                <textarea
                  value={descText}
                  onChange={(e) => setDescText(e.target.value)}
                  placeholder="Describe what this test case verifies..."
                  rows={3}
                  className="w-full min-h-[72px] text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
                />
              </div>
              <div className="flex gap-1">
                <button onClick={handleSaveName} className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30">
                  <Save className="w-2.5 h-2.5" /> Save
                </button>
                <button onClick={() => { setEditingName(false); setNameText(testCase.name); setDescText(testCase.description); }} className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                  <X className="w-2.5 h-2.5" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">{testCase.description}</p>
          )}

          {testCase.errorMessage && (
            <div className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">
              {testCase.errorMessage}
            </div>
          )}

          {/* Steps */}
          <div className="space-y-1.5">
            {testCase.steps.map((step) => (
              <EditableStep
                key={step.id}
                step={step}
                editing={editingStepId === step.id}
                running={isRunning && runningStepOrder === step.order}
                executed={isRunning && runningStepOrder != null && runningStepOrder > 0 && step.order < runningStepOrder}
                queued={isRunning && runningStepOrder != null && step.order > runningStepOrder && step.status === 'pending'}
                onSave={handleSaveStep}
                onDelete={() => handleDeleteStep(step.id)}
                onStartEdit={() => setEditingStepId(step.id)}
                onCancel={() => setEditingStepId(null)}
                dragOverStep={dragOverStepId}
                onDragStartStep={setDraggingStepId}
                onDragOverStep={setDragOverStepId}
                onDropStep={handleStepDrop}
                onDragEndStep={() => { setDragOverStepId(null); setDraggingStepId(null); }}
              />
            ))}
          </div>

          {/* Add step */}
          {addingStep ? (
            <NewStepForm
              order={testCase.steps.length + 1}
              onAdd={handleAddStep}
              onCancel={() => setAddingStep(false)}
            />
          ) : (
            <button
              onClick={() => setAddingStep(true)}
              className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors px-1 py-0.5"
            >
              <Plus className="w-3 h-3" /> Add step
            </button>
          )}

        </div>
      )}
    </div>
  );
}

// ─── Credentials Section ─────────────────────────────────────────

function CredentialsSection({
  credentials,
  onChange,
}: {
  credentials: QCCredential[];
  onChange: (creds: QCCredential[]) => void;
}) {
  const [expanded, setExpanded] = useState(credentials.length > 0);
  const [visibleValues, setVisibleValues] = useState<Record<number, boolean>>({});

  const handleAdd = () => {
    onChange([...credentials, { label: '', value: '' }]);
    setExpanded(true);
  };

  const handleUpdate = (index: number, field: 'label' | 'value', val: string) => {
    const updated = credentials.map((c, i) => i === index ? { ...c, [field]: val } : c);
    onChange(updated);
  };

  const handleRemove = (index: number) => {
    onChange(credentials.filter((_, i) => i !== index));
  };

  const toggleVisible = (index: number) => {
    setVisibleValues(prev => ({ ...prev, [index]: !prev[index] }));
  };

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-secondary)] cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" /> : <ChevronRight className="w-3 h-3 text-[var(--text-muted)]" />}
        <KeyRound className="w-3.5 h-3.5 text-amber-400" />
        <span className="text-xs font-medium text-[var(--text-primary)]">Login Credentials</span>
        {credentials.length > 0 && (
          <span className="text-[10px] text-[var(--text-muted)]">{credentials.length} field{credentials.length !== 1 ? 's' : ''}</span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); handleAdd(); }}
          className="ml-auto w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
          title="Add credential field"
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>
      {expanded && (
        <div className="px-3 py-2 space-y-2">
          {credentials.length === 0 && (
            <p className="text-[10px] text-[var(--text-muted)] italic">No credentials configured. Add login info so tests can authenticate automatically.</p>
          )}
          {credentials.map((cred, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={cred.label}
                onChange={(e) => handleUpdate(i, 'label', e.target.value)}
                placeholder="Label (e.g. Email)"
                className="w-24 text-[11px] bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2 py-1 outline-none focus:border-[var(--accent)]"
              />
              <div className="flex-1 relative">
                <input
                  type={visibleValues[i] ? 'text' : 'password'}
                  value={cred.value}
                  onChange={(e) => handleUpdate(i, 'value', e.target.value)}
                  placeholder="Value"
                  className="w-full text-[11px] bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2 py-1 pr-7 outline-none focus:border-[var(--accent)]"
                />
                <button
                  onClick={() => toggleVisible(i)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {visibleValues[i] ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
              </div>
              <button
                onClick={() => handleRemove(i)}
                className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-red-400 transition-colors shrink-0"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── New Step Form ───────────────────────────────────────────────

function NewStepForm({
  order,
  onAdd,
  onCancel,
}: {
  order: number;
  onAdd: (action: string, expected: string) => void;
  onCancel: () => void;
}) {
  const [action, setAction] = useState('');
  const [expected, setExpected] = useState('');

  return (
    <div className="text-xs border border-[var(--accent)]/30 rounded-md p-3 bg-[var(--bg-primary)] space-y-2">
      <div className="flex items-center gap-2 text-[var(--text-muted)]">
        <span className="font-mono text-[10px]">Step {order}</span>
        <span className="text-[10px]">New step</span>
      </div>
      <div>
        <label className="text-[10px] text-[var(--text-muted)] uppercase font-medium block mb-1">Action</label>
        <textarea
          value={action}
          onChange={(e) => setAction(e.target.value)}
          placeholder="Describe the action to perform..."
          rows={2}
          className="w-full min-h-[48px] text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
          autoFocus
        />
      </div>
      <div>
        <label className="text-[10px] text-[var(--text-muted)] uppercase font-medium block mb-1">Expected Result</label>
        <textarea
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          placeholder="Describe the expected result..."
          rows={2}
          className="w-full min-h-[48px] text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && action.trim() && expected.trim()) { e.preventDefault(); onAdd(action.trim(), expected.trim()); }
            if (e.key === 'Escape') onCancel();
          }}
        />
      </div>
      <div className="flex gap-1">
        <button
          onClick={() => onAdd(action.trim(), expected.trim())}
          disabled={!action.trim() || !expected.trim()}
          className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50"
        >
          <Plus className="w-2.5 h-2.5" /> Add
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <X className="w-2.5 h-2.5" /> Cancel
        </button>
      </div>
    </div>
  );
}

// ─── New Test Case Form ──────────────────────────────────────────

function NewTestCaseForm({
  onAdd,
  onCancel,
}: {
  onAdd: (tc: QCTestCase) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleAdd = () => {
    if (!name.trim()) return;
    const tc: QCTestCase = {
      id: uuidv4(),
      name: name.trim(),
      description: description.trim(),
      steps: [],
      status: 'pending',
    };
    onAdd(tc);
  };

  return (
    <div className="space-y-2 p-3 border border-[var(--accent)]/30 rounded-lg bg-[var(--bg-primary)]">
      <div>
        <label className="text-[10px] text-[var(--text-muted)] uppercase font-medium block mb-1">Test Case Name *</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Login form validation"
          className="w-full text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
          autoFocus
        />
      </div>
      <div>
        <label className="text-[10px] text-[var(--text-muted)] uppercase font-medium block mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what this test case verifies..."
          rows={3}
          className="w-full min-h-[72px] text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && name.trim()) { e.preventDefault(); handleAdd(); } if (e.key === 'Escape') onCancel(); }}
        />
      </div>
      <div className="flex gap-1">
        <button
          onClick={handleAdd}
          disabled={!name.trim()}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50"
        >
          <Plus className="w-3 h-3" /> Add Test Case
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Task Status Dropdown ───────────────────────────────────────

function TaskStatusDropdown({
  taskId,
  currentStatus,
  statusColor,
  onStatusChanged,
}: {
  taskId: string;
  currentStatus: string;
  statusColor: string;
  onStatusChanged: (status: string, color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<{ name: string; color: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpen = async () => {
    setOpen(!open);
    if (!open && statuses.length === 0) {
      setLoading(true);
      try {
        const result = await window.electronAPI.getTaskStatuses(taskId);
        if (result.success && result.data) setStatuses(result.data);
      } catch { /* non-critical */ }
      setLoading(false);
    }
  };

  const handleSelect = async (status: string, color: string) => {
    setUpdating(true);
    try {
      const result = await window.electronAPI.updateTaskStatus(taskId, status);
      if (result.success) onStatusChanged(status, color);
    } catch { /* non-critical */ }
    setUpdating(false);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); handleOpen(); }}
        className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] hover:opacity-80 transition-opacity"
        style={{
          backgroundColor: `${statusColor}20`,
          color: statusColor,
        }}
        title="Click to change status"
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: statusColor }}
        />
        {updating ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : currentStatus}
        <ChevronDown className="w-2.5 h-2.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-48 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-30 py-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" />
            </div>
          ) : statuses.length === 0 ? (
            <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">No statuses available</div>
          ) : (
            statuses.map((s) => (
              <button
                key={s.name}
                onClick={(e) => { e.stopPropagation(); handleSelect(s.name, s.color); }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  s.name.toLowerCase() === currentStatus.toLowerCase()
                    ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]',
                )}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: s.color }}
                />
                <span className="capitalize">{s.name}</span>
                {s.name.toLowerCase() === currentStatus.toLowerCase() && (
                  <CheckCircle className="w-3 h-3 ml-auto text-emerald-400" />
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── QC Actions Dropdown ────────────────────────────────────────

function formatTestCasesText(task: QCTask): string {
  const lines: string[] = [`QC Test: ${task.title}`, `URL: ${task.targetUrl}`, ''];
  task.testCases.forEach((tc, i) => {
    lines.push(`${i + 1}. ${tc.name}`);
    if (tc.description) lines.push(`   ${tc.description}`);
    tc.steps.forEach((s) => {
      lines.push(`   Step ${s.order}: ${s.action}`);
      lines.push(`   Expected: ${s.expected}`);
    });
    lines.push('');
  });
  return lines.join('\n');
}

function formatTestResultsText(task: QCTask): string {
  const passed = task.testCases.filter((tc) => tc.status === 'passed').length;
  const failed = task.testCases.filter((tc) => tc.status === 'failed').length;
  const errors = task.testCases.filter((tc) => tc.status === 'error').length;
  const total = task.testCases.length;

  const lines: string[] = [
    `QC Test Results: ${task.title}`,
    `URL: ${task.targetUrl}`,
    `Summary: ${passed} passed, ${failed} failed, ${errors} errors out of ${total} total`,
    task.durationMs ? `Duration: ${Math.round(task.durationMs / 1000)}s` : '',
    '',
  ];
  task.testCases.forEach((tc, i) => {
    const icon = tc.status === 'passed' ? '\u2705' : tc.status === 'failed' ? '\u274C' : tc.status === 'error' ? '\u26A0\uFE0F' : '\u23F3';
    lines.push(`${icon} ${i + 1}. ${tc.name} — ${tc.status.toUpperCase()}`);
    tc.steps.forEach((s) => {
      const stepIcon = s.status === 'passed' ? '\u2705' : s.status === 'failed' ? '\u274C' : '\u2014';
      lines.push(`   ${stepIcon} Step ${s.order}: ${s.action}`);
      if (s.actual) lines.push(`      Actual: ${s.actual}`);
    });
    if (tc.errorMessage) lines.push(`   Error: ${tc.errorMessage}`);
    lines.push('');
  });
  return lines.join('\n');
}

function QCActionsDropdown({ task }: { task: QCTask }) {
  const [open, setOpen] = useState(false);
  const [posting, setPosting] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const taskLabel = task.linkedTask?.customId || task.linkedTask?.id || '';
  const hasLinkedTask = !!task.linkedTask;
  const hasResults = task.status === 'completed' && task.testCases.some((tc) => tc.status !== 'pending');

  const handlePostTestCases = async () => {
    if (!task.linkedTask) return;
    setPosting('cases');
    try {
      const text = formatTestCasesText(task);
      await window.electronAPI.postTaskComment(task.linkedTask.id, text);
    } catch { /* non-critical */ }
    setPosting(null);
    setOpen(false);
  };

  const handlePostResults = async () => {
    if (!task.linkedTask) return;
    setPosting('results');
    try {
      const text = formatTestResultsText(task);
      await window.electronAPI.postTaskComment(task.linkedTask.id, text);
    } catch { /* non-critical */ }
    setPosting(null);
    setOpen(false);
  };

  const handleCopyTestCases = async () => {
    const text = formatTestCasesText(task);
    await navigator.clipboard.writeText(text);
    setOpen(false);
  };

  const handleCopyResults = async () => {
    const text = formatTestResultsText(task);
    await navigator.clipboard.writeText(text);
    setOpen(false);
  };

  const handleUpdateStatus = async (status: string) => {
    if (!task.linkedTask) return;
    setPosting('status');
    try {
      await window.electronAPI.updateTaskStatus(task.linkedTask.id, status);
    } catch { /* non-critical */ }
    setPosting(null);
    setOpen(false);
  };

  const actions: { icon: React.ReactNode; label: string; description?: string; action: () => void; disabled?: boolean; loading?: boolean }[] = [
    {
      icon: <ClipboardCopy className="w-3.5 h-3.5" />,
      label: 'Copy Test Cases',
      description: 'Copy test plan to clipboard',
      action: handleCopyTestCases,
    },
    {
      icon: <ClipboardCopy className="w-3.5 h-3.5" />,
      label: 'Copy Test Results',
      description: 'Copy results to clipboard',
      action: handleCopyResults,
      disabled: !hasResults,
    },
    {
      icon: <Send className="w-3.5 h-3.5" />,
      label: 'Post Test Cases',
      description: hasLinkedTask ? `Comment on ${taskLabel}` : 'Link a ClickUp task first',
      action: handlePostTestCases,
      disabled: !hasLinkedTask,
      loading: posting === 'cases',
    },
    {
      icon: <MessageSquare className="w-3.5 h-3.5" />,
      label: 'Post Test Results',
      description: hasLinkedTask ? `Comment on ${taskLabel}` : 'Link a ClickUp task first',
      action: handlePostResults,
      disabled: !hasLinkedTask || !hasResults,
      loading: posting === 'results',
    },
    {
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      label: 'Set Ready for Review',
      description: hasLinkedTask ? `Update ${taskLabel} status` : 'Link a ClickUp task first',
      action: () => handleUpdateStatus('ready for review'),
      disabled: !hasLinkedTask,
      loading: posting === 'status',
    },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-colors"
        title="QC actions"
      >
        <Zap className="w-3.5 h-3.5" />
        Actions
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-xl z-30 py-1 overflow-hidden">
          {actions.map((a, i) => (
            <button
              key={i}
              onClick={(e) => { e.stopPropagation(); if (!a.disabled) a.action(); }}
              className={cn(
                'w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors',
                a.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-[var(--bg-tertiary)] cursor-pointer',
              )}
              disabled={a.disabled}
            >
              <span className="mt-0.5 text-[var(--text-muted)]">
                {a.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : a.icon}
              </span>
              <div className="min-w-0">
                <div className="text-xs text-[var(--text-primary)]">{a.label}</div>
                {a.description && (
                  <div className="text-[10px] text-[var(--text-muted)] truncate">{a.description}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Panel ──────────────────────────────────────────────────

export function QCTestPanel({ sessionId, qcTask, model, onTaskUpdate, onNewTask: _onNewTask, onRenameSession }: QCTestPanelProps) {
  const qcSettingsUrl = useSettingsStore((s) => s.settings.qcTestingUrl) || '';
  const qcSettingsCredentials = useSettingsStore((s) => s.settings.qcTestingCredentials) || [];
  const [showCreateForm, setShowCreateForm] = useState(!qcTask);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetUrl, setTargetUrl] = useState(qcSettingsUrl);
  const [generating, setGenerating] = useState(false);
  const [showTaskPicker, setShowTaskPicker] = useState(false);
  const [linkedTask, setLinkedTask] = useState<TaskManagerTask | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize description textarea
  const autoResizeDescription = useCallback(() => {
    const el = descriptionRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(120, el.scrollHeight)}px`;
  }, []);

  // Reset form when switching to a new session
  useEffect(() => {
    setShowCreateForm(!qcTask);
    setTitle('');
    setDescription('');
    setTargetUrl(qcSettingsUrl);
    setGenerating(false);
    setError(null);
    setLinkedTask(null);
    setShowTaskPicker(false);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [runningAll, setRunningAll] = useState(
    () => qcTask?.status === 'running' || (qcTask?.testCases.some(tc => tc.status === 'running') ?? false),
  );
  const [error, setError] = useState<string | null>(null);
  const [addingTestCase, setAddingTestCase] = useState(false);
  const [dragOverTcId, setDragOverTcId] = useState<string | null>(null);
  const [, setDraggingTcId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editUrl, setEditUrl] = useState('');
  // Track which step is currently running per test case: { [testCaseId]: stepOrder }
  const [runningSteps, setRunningSteps] = useState<Record<string, number>>({});
  // Ref to always access the latest qcTask inside event listeners (avoids stale closures).
  // IMPORTANT: Only sync from the prop via useEffect (not on every render) so that
  // manual ref updates from event handlers are not overwritten by intermediate re-renders
  // (e.g. from setRunningSteps/setTestLogs) before the parent has processed the prop update.
  const qcTaskRef = useRef(qcTask);
  useEffect(() => {
    qcTaskRef.current = qcTask;
  }, [qcTask]);
  const onTaskUpdateRef = useRef(onTaskUpdate);
  onTaskUpdateRef.current = onTaskUpdate;

  // Keep runningAll in sync with persisted task/test-case status
  useEffect(() => {
    const isRunning = qcTask?.status === 'running' || (qcTask?.testCases.some(tc => tc.status === 'running') ?? false);
    setRunningAll(isRunning);
  }, [qcTask?.status, qcTask?.testCases]);

  // Listen for QC events — uses refs to always read the latest qcTask/onTaskUpdate
  // so that completed test cases keep their final status (passed/failed) instead of
  // being reverted to 'running' by a stale closure.
  useEffect(() => {
    const cleanup = window.electronAPI.onQCEvent((event: any) => {
      if (event.sessionId !== sessionId) return;
      const task = qcTaskRef.current;
      const update = onTaskUpdateRef.current;

      // Track step progress
      if (event.type === 'step-update' && event.testCaseId && event.stepOrder) {
        setRunningSteps(prev => ({ ...prev, [event.testCaseId!]: event.stepOrder! }));
        if (task) {
          const tc = task.testCases.find(t => t.id === event.testCaseId);
          if (tc && tc.status !== 'running') {
            const updatedTask = {
              ...task,
              testCases: task.testCases.map(t =>
                t.id === event.testCaseId ? { ...t, status: 'running' as const } : t,
              ),
            };
            qcTaskRef.current = updatedTask;
            update(updatedTask);
          }
        }
      }

      if (event.type === 'test-start' && event.testCaseId && task) {
        setRunningSteps(prev => ({ ...prev, [event.testCaseId!]: 0 }));
        const updatedTask = {
          ...task,
          status: 'running' as const,
          testCases: task.testCases.map(tc =>
            tc.id === event.testCaseId ? { ...tc, status: 'running' as const } : tc,
          ),
        };
        qcTaskRef.current = updatedTask;
        update(updatedTask);
      }

      // Attach screenshot to step in real-time
      if (event.type === 'screenshot' && event.testCaseId && event.stepOrder && event.screenshot && task) {
        const updatedTask = {
          ...task,
          testCases: task.testCases.map(tc =>
            tc.id === event.testCaseId
              ? { ...tc, steps: tc.steps.map(s => s.order === event.stepOrder ? { ...s, screenshot: event.screenshot } : s) }
              : tc,
          ),
        };
        qcTaskRef.current = updatedTask;
        update(updatedTask);
      }

      if (event.type === 'test-done' && event.testCase && task) {
        setRunningSteps(prev => {
          const next = { ...prev };
          delete next[event.testCaseId!];
          return next;
        });
        const updatedTask = {
          ...task,
          testCases: task.testCases.map((tc: QCTestCase) =>
            tc.id === event.testCaseId ? event.testCase! : tc,
          ),
        };
        qcTaskRef.current = updatedTask;
        update(updatedTask);
      }

      if (event.type === 'all-done' && event.summary) {
        setRunningSteps({});
        setRunningAll(false);
      }
    });
    return () => { cleanup(); };
  }, [sessionId]);

  const handleGenerate = useCallback(async () => {
    // Use current task values when regenerating, form values when creating
    const genTitle = qcTask?.title || title;
    const genDesc = qcTask?.description || description;
    const genUrl = qcTask?.targetUrl || targetUrl;
    if (!genTitle.trim() || !genUrl.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await window.electronAPI.qcGenerateTests(sessionId, genTitle, genDesc, genUrl, model);
      if (result.success) {
        const task = result.data;
        // Pre-fill credentials from settings if task has none and settings has them
        if ((!task.credentials || task.credentials.length === 0) && qcSettingsCredentials.length > 0) {
          task.credentials = [...qcSettingsCredentials];
        }
        // Persist linked task reference
        if (linkedTask) {
          task.linkedTask = {
            id: linkedTask.id,
            customId: linkedTask.customId,
            name: linkedTask.name,
            status: linkedTask.status.name,
            statusColor: linkedTask.status.color,
            url: linkedTask.url,
          };
        }
        await onTaskUpdate(task);
        setShowCreateForm(false);
        // Update session title AFTER onTaskUpdate has persisted qcTask to disk
        // to avoid concurrent file writes that can corrupt the session JSON.
        await onRenameSession?.(`QC: ${genTitle}`);
      } else {
        setError(result.error || 'Failed to generate tests');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate tests');
    } finally {
      setGenerating(false);
    }
  }, [sessionId, qcTask, title, description, targetUrl, model, onTaskUpdate, qcSettingsCredentials, linkedTask]);

  const handleRunAll = useCallback(async () => {
    setRunningAll(true);
    setError(null);
    try {
      const result = await window.electronAPI.qcRunTests(sessionId, model);
      if (result.success) {
        onTaskUpdate(result.data);
      } else {
        setError(result.error || 'Failed to run tests');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run tests');
    } finally {
      setRunningAll(false);
    }
  }, [sessionId, model, onTaskUpdate]);

  const handleAbort = useCallback(async () => {
    const result = await window.electronAPI.qcAbort(sessionId);
    setRunningAll(false);
    setRunningSteps({});
    if (result?.data) {
      onTaskUpdate(result.data);
    }
  }, [sessionId, onTaskUpdate]);

  const handleTestCaseUpdate = useCallback((updatedTc: QCTestCase) => {
    if (!qcTask) return;
    onTaskUpdate({
      ...qcTask,
      testCases: qcTask.testCases.map((tc) => tc.id === updatedTc.id ? updatedTc : tc),
      updatedAt: new Date().toISOString(),
    });
  }, [qcTask, onTaskUpdate]);

  const handleDeleteTestCase = useCallback((tcId: string) => {
    if (!qcTask) return;
    onTaskUpdate({
      ...qcTask,
      testCases: qcTask.testCases.filter((tc) => tc.id !== tcId),
      updatedAt: new Date().toISOString(),
    });
  }, [qcTask, onTaskUpdate]);

  const handleAddTestCase = useCallback((tc: QCTestCase) => {
    if (!qcTask) return;
    onTaskUpdate({
      ...qcTask,
      testCases: [...qcTask.testCases, tc],
      status: 'ready',
      updatedAt: new Date().toISOString(),
    });
    setAddingTestCase(false);
  }, [qcTask, onTaskUpdate]);

  const handleTestCaseDrop = useCallback((fromId: string, toId: string) => {
    if (!qcTask) return;
    const fromIdx = qcTask.testCases.findIndex((tc) => tc.id === fromId);
    const toIdx = qcTask.testCases.findIndex((tc) => tc.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = [...qcTask.testCases];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    onTaskUpdate({ ...qcTask, testCases: reordered, updatedAt: new Date().toISOString() });
    setDragOverTcId(null);
    setDraggingTcId(null);
  }, [qcTask, onTaskUpdate]);

  // Summary stats
  const passed = qcTask?.testCases.filter((tc) => tc.status === 'passed').length || 0;
  const failed = qcTask?.testCases.filter((tc) => tc.status === 'failed').length || 0;
  const errors = qcTask?.testCases.filter((tc) => tc.status === 'error').length || 0;
  const running = qcTask?.testCases.filter((tc) => tc.status === 'running').length || 0;
  const pending = qcTask?.testCases.filter((tc) => tc.status === 'pending').length || 0;
  const total = qcTask?.testCases.length || 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">QC Testing</h3>
          <div className="flex items-center gap-2 ml-auto text-[10px]">
            {qcTask && total > 0 && (
              <>
                {running > 0 && <span className="flex items-center gap-0.5 text-blue-400"><Loader2 className="w-2.5 h-2.5 animate-spin" />{running} running</span>}
                {passed > 0 && <span className="flex items-center gap-0.5 text-emerald-400"><CheckCircle className="w-2.5 h-2.5" />{passed}</span>}
                {failed > 0 && <span className="flex items-center gap-0.5 text-red-400"><XCircle className="w-2.5 h-2.5" />{failed}</span>}
                {errors > 0 && <span className="flex items-center gap-0.5 text-red-400"><AlertTriangle className="w-2.5 h-2.5" />{errors}</span>}
                {pending > 0 && <span className="flex items-center gap-0.5 text-[var(--text-muted)]"><Clock className="w-2.5 h-2.5" />{pending}</span>}
                {qcTask.durationMs != null && (
                  <span className="flex items-center gap-0.5 text-[var(--text-muted)]"><Timer className="w-2.5 h-2.5" />{formatDuration(qcTask.durationMs)}</span>
                )}
              </>
            )}
            {qcTask && <QCActionsDropdown task={qcTask} />}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {error && (
          <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">&times;</button>
          </div>
        )}

        {/* Create form */}
        {showCreateForm && (
          <div className="space-y-3 p-4 border border-[var(--border)] rounded-lg bg-[var(--bg-card)]">
            {/* ClickUp task link — import or linked badge */}
            {linkedTask ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)]">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: linkedTask.status.color }}
                />
                {linkedTask.customId && (
                  <span className="text-[11px] font-mono text-[var(--text-muted)] shrink-0">{linkedTask.customId}</span>
                )}
                <span className="text-xs text-[var(--text-primary)] truncate flex-1">{linkedTask.name}</span>
                <button
                  onClick={() => { if (linkedTask.url) window.electronAPI?.openExternal?.(linkedTask.url); }}
                  className="text-[var(--text-muted)] hover:text-[var(--accent)] shrink-0"
                  title="Open in ClickUp"
                >
                  <ExternalLink className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setLinkedTask(null)}
                  className="text-[var(--text-muted)] hover:text-red-400 shrink-0"
                  title="Unlink task"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowTaskPicker(true)}
                className="flex items-center gap-1.5 w-full text-xs px-3 py-2 rounded-md border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]/50 transition-colors"
                title="Import from ClickUp task"
              >
                <Link2 className="w-3.5 h-3.5" />
                Import from ClickUp
              </button>
            )}

            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Task Title *</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Login page validation"
                className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-1.5 outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-[var(--text-muted)] block mb-1">Description</label>
              <textarea
                ref={descriptionRef}
                value={description}
                onChange={(e) => { setDescription(e.target.value); autoResizeDescription(); }}
                placeholder="Describe the feature to test... The more detail you provide, the better the generated test cases will be."
                rows={6}
                className="w-full min-h-[120px] max-h-[400px] text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md px-3 py-2 outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
              />
            </div>
            <div>
              <label className="text-xs text-[var(--text-muted)] block mb-1">Target URL *</label>
              <div className="relative">
                <Globe className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded-md pl-8 pr-3 py-1.5 outline-none focus:border-[var(--accent)]"
                />
              </div>
              {qcSettingsUrl && targetUrl === qcSettingsUrl && (
                <p className="text-[10px] text-emerald-400 mt-0.5">Using URL from Settings</p>
              )}
            </div>
            {qcSettingsCredentials.length > 0 && (
              <p className="text-[10px] text-[var(--text-muted)]">
                <KeyRound className="w-3 h-3 inline-block mr-0.5 text-amber-400" />
                {qcSettingsCredentials.length} login credential{qcSettingsCredentials.length !== 1 ? 's' : ''} will be applied from Settings.
              </p>
            )}
            <button
              onClick={handleGenerate}
              disabled={generating || !title.trim() || !targetUrl.trim()}
              className="w-full flex items-center justify-center gap-2 text-sm font-medium px-4 py-2 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors disabled:opacity-50"
            >
              {generating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating test cases...
                </>
              ) : (
                <>
                  <FileText className="w-4 h-4" />
                  Generate Test Cases
                </>
              )}
            </button>
          </div>
        )}

        {/* Task Picker Modal */}
        {showTaskPicker && (
          <TaskPickerModal
            mode="link"
            onSelect={async (task: TaskManagerTask) => {
              setLinkedTask(task);
              setTitle(task.name);
              setShowTaskPicker(false);

              // Fetch full task details (description etc.) from ClickUp
              try {
                const result = await window.electronAPI.getTaskManagerTask(task.id);
                if (result.success && result.data) {
                  const fullTask = result.data as TaskManagerTask;
                  setLinkedTask(fullTask);
                  if (fullTask.description) {
                    const desc = fullTask.description.length > 2000
                      ? fullTask.description.slice(0, 2000) + '...'
                      : fullTask.description;
                    setDescription(desc);
                    setTimeout(autoResizeDescription, 50);
                  }
                }
              } catch { /* non-critical — title is already set */ }
            }}
            onCancel={() => setShowTaskPicker(false)}
          />
        )}

        {/* Task info */}
        {qcTask && !showCreateForm && (
          <>
            <div className="p-3 border border-[var(--border)] rounded-lg bg-[var(--bg-card)]">
              {editingTask ? (
                <div className="space-y-2">
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Task title"
                    className="w-full text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                    autoFocus
                  />
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="Description..."
                    rows={6}
                    className="w-full min-h-[120px] max-h-[400px] text-sm bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded px-2.5 py-1.5 outline-none focus:border-[var(--accent)] resize-y leading-relaxed"
                  />
                  <div className="relative">
                    <Globe className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      placeholder="https://example.com"
                      className="w-full text-xs bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border)] rounded pl-7 pr-2.5 py-1.5 outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        if (editTitle.trim()) {
                          onTaskUpdate({ ...qcTask, title: editTitle.trim(), description: editDescription.trim(), targetUrl: editUrl.trim() || qcTask.targetUrl, updatedAt: new Date().toISOString() });
                        }
                        setEditingTask(false);
                      }}
                      disabled={!editTitle.trim()}
                      className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-50"
                    >
                      <Save className="w-3 h-3" /> Save
                    </button>
                    <button
                      onClick={() => setEditingTask(false)}
                      className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="group/task">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="text-sm font-medium text-[var(--text-primary)]">{qcTask.title}</h4>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => { setEditTitle(qcTask.title); setEditDescription(qcTask.description); setEditUrl(qcTask.targetUrl); setEditingTask(true); }}
                        className="opacity-0 group-hover/task:opacity-100 transition-opacity w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)]"
                        title="Edit task"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {qcTask.description && (
                    <p className="text-xs text-[var(--text-muted)] mb-1 whitespace-pre-wrap break-words line-clamp-3">{qcTask.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                    <Globe className="w-3 h-3" />
                    <span className="truncate">{qcTask.targetUrl}</span>
                  </div>
                  {qcTask.linkedTask && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <TaskStatusDropdown
                        taskId={qcTask.linkedTask.id}
                        currentStatus={qcTask.linkedTask.status}
                        statusColor={qcTask.linkedTask.statusColor}
                        onStatusChanged={(status, color) => {
                          onTaskUpdate({
                            ...qcTask,
                            linkedTask: { ...qcTask.linkedTask!, status, statusColor: color },
                            updatedAt: new Date().toISOString(),
                          });
                        }}
                      />
                      <button
                        onClick={() => { if (qcTask.linkedTask?.url) window.electronAPI?.openExternal?.(qcTask.linkedTask.url); }}
                        className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] hover:opacity-80 transition-opacity"
                        style={{
                          backgroundColor: `${qcTask.linkedTask.statusColor}20`,
                          color: qcTask.linkedTask.statusColor,
                        }}
                        title={`${qcTask.linkedTask.name} — Click to open task`}
                      >
                        {qcTask.linkedTask.customId && (
                          <span className="font-mono shrink-0">{qcTask.linkedTask.customId}</span>
                        )}
                        <span className="truncate">{qcTask.linkedTask.name}</span>
                        <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Credentials */}
            <CredentialsSection
              credentials={qcTask.credentials || []}
              onChange={(creds) => {
                onTaskUpdate({ ...qcTask, credentials: creds, updatedAt: new Date().toISOString() });
              }}
            />

            {/* Action buttons */}
            <div className="flex gap-2">
              {runningAll ? (
                <button
                  onClick={handleAbort}
                  className="flex-1 flex items-center justify-center gap-2 text-sm px-4 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                >
                  <Square className="w-3.5 h-3.5" />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleRunAll}
                  disabled={total === 0}
                  className="flex-1 flex items-center justify-center gap-2 text-sm px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
                >
                  {qcTask.status === 'completed' ? (
                    <><RotateCcw className="w-3.5 h-3.5" /> Re-run All Tests ({total})</>
                  ) : (
                    <><Play className="w-3.5 h-3.5" /> Run All Tests ({total})</>
                  )}
                </button>
              )}
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/80 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', generating && 'animate-spin')} />
                Regenerate
              </button>
            </div>

            {/* Summary */}
            {qcTask.summary && (
              <div className={cn(
                'text-xs px-3 py-2 rounded-lg',
                failed > 0 ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400',
              )}>
                {qcTask.summary}
              </div>
            )}

            {/* Test case list */}
            <div className="space-y-2">
              {qcTask.testCases.map((tc) => (
                <TestCaseCard
                  key={tc.id}
                  testCase={tc}
                  sessionId={sessionId}
                  model={model}
                  runningStepOrder={runningSteps[tc.id]}
                  onUpdate={handleTestCaseUpdate}
                  onDelete={() => handleDeleteTestCase(tc.id)}
                  dragOverTc={dragOverTcId}
                  onDragStartTc={setDraggingTcId}
                  onDragOverTc={setDragOverTcId}
                  onDropTc={handleTestCaseDrop}
                  onDragEndTc={() => { setDragOverTcId(null); setDraggingTcId(null); }}
                />
              ))}
            </div>

            {/* Add test case */}
            {addingTestCase ? (
              <NewTestCaseForm onAdd={handleAddTestCase} onCancel={() => setAddingTestCase(false)} />
            ) : (
              <button
                onClick={() => setAddingTestCase(true)}
                className="flex items-center gap-1.5 w-full justify-center text-xs text-[var(--text-muted)] hover:text-[var(--accent)] border border-dashed border-[var(--border)] hover:border-[var(--accent)]/50 rounded-lg py-2.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Add Test Case
              </button>
            )}
          </>
        )}

        {/* Empty state */}
        {!qcTask && !showCreateForm && (
          <div className="text-center py-12">
            <ShieldCheck className="w-10 h-10 text-amber-400/30 mx-auto mb-3" />
            <p className="text-sm text-[var(--text-muted)] mb-3">No QC task assigned yet</p>
            <button
              onClick={() => setShowCreateForm(true)}
              className="text-sm text-amber-400 hover:text-amber-300 transition-colors"
            >
              Create a test task
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
