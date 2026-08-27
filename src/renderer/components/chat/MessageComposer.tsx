import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  FileText,
  Languages,
  Loader2,
  Paperclip,
  Send,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import type { ChatLanguage, ChatPendingAttachment } from '../../../shared/types';
import { cn } from '../../../shared/utils';

/** Matches the main process's cap — rejecting here means a 20MB payload never
 *  crosses IPC just to be turned away on the other side. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

let attachmentSeq = 0;

/** Read a File/Blob into the base64 shape the upload IPC takes. */
async function toPendingAttachment(file: File): Promise<ChatPendingAttachment | { error: string }> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return { error: `${file.name || 'That file'} is larger than 20MB` };
  }
  const buffer = await file.arrayBuffer();
  // Chunked so a multi-MB file doesn't blow the argument limit of
  // String.fromCharCode(...spread), which throws on large arrays.
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const mime = file.type || 'application/octet-stream';
  return {
    id: `att-${++attachmentSeq}`,
    // A pasted screenshot arrives as "image.png" or with no name at all.
    name: file.name || `pasted-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`,
    mime,
    size: file.size,
    data: btoa(binary),
    isImage: mime.startsWith('image/'),
  };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface UploadProgress {
  fileName: string;
  index: number;
  total: number;
}

/** Staged files, above the input, each removable before sending. */
function AttachmentTray({
  attachments,
  onRemove,
  uploading,
  onCancelUpload,
}: {
  attachments: ChatPendingAttachment[];
  onRemove: (id: string) => void;
  uploading?: UploadProgress;
  onCancelUpload: () => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {attachments.map((file) => (
        <div
          key={file.id}
          className="group relative flex items-center gap-2 pl-1.5 pr-6 py-1.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border)]"
        >
          {file.isImage ? (
            <img
              src={`data:${file.mime};base64,${file.data}`}
              alt={file.name}
              className="w-8 h-8 rounded object-cover"
            />
          ) : (
            <div className="w-8 h-8 rounded bg-[var(--bg-secondary)] flex items-center justify-center">
              <FileText className="w-4 h-4 text-[var(--text-muted)]" />
            </div>
          )}
          <div className="min-w-0 max-w-[140px]">
            <div className="text-[11px] text-[var(--text-primary)] truncate">{file.name}</div>
            <div className="text-[9px] text-[var(--text-muted)]">{humanSize(file.size)}</div>
          </div>
          {!uploading && (
            <button
              onClick={() => onRemove(file.id)}
              title="Remove"
              className="absolute right-1 top-1 p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--error)]"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ))}
      {uploading && (
        <div className="flex items-center gap-2 px-2 text-[11px] text-[var(--text-muted)]">
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
          <span className="truncate max-w-[180px]">
            Uploading {uploading.total > 1 ? `${uploading.index}/${uploading.total} · ` : ''}
            {uploading.fileName}
          </span>
          <button
            onClick={onCancelUpload}
            className="px-1.5 py-0.5 rounded-md text-[10px] font-medium text-[var(--error)] hover:bg-[var(--error)]/10"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

const LANGUAGES: { id: ChatLanguage; label: string; flag: string }[] = [
  { id: 'vi', label: 'Vietnamese', flag: '🇻🇳' },
  { id: 'en', label: 'English', flag: '🇬🇧' },
  { id: 'no', label: 'Norwegian', flag: '🇳🇴' },
];

const TONES = [
  { id: 'polite', label: 'More polite' },
  { id: 'shorter', label: 'Shorter' },
  { id: 'direct', label: 'More direct' },
  { id: 'formal', label: 'More formal' },
] as const;

export type ComposerTone = (typeof TONES)[number]['id'];

interface MessageComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
  placeholder: string;
  disabled?: boolean;
  /** AI is busy — the assist buttons go quiet rather than queueing runs. */
  assistRunning: boolean;
  language: ChatLanguage;
  onLanguageChange: (language: ChatLanguage) => void;
  onSuggest: () => void;
  onTranslate: () => void;
  onRewrite: (tone: ComposerTone) => void;
  /** Bumping this refocuses the textarea (after a quote or a suggestion lands). */
  focusToken?: number;
  /** Files staged for this message, and how to change them. */
  attachments: ChatPendingAttachment[];
  onAttach: (files: ChatPendingAttachment[]) => void;
  onRemoveAttachment: (id: string) => void;
  /** Set while the staged files are being uploaded, one at a time. */
  uploading?: UploadProgress;
  onCancelUpload: () => void;
  /** When false, attaching is refused up front with `attachmentsHint` as the
   *  reason — rather than letting the user stage a file and only discover at
   *  send time that there is nowhere to put it. */
  attachmentsEnabled: boolean;
  attachmentsHint?: string;
}

export function MessageComposer({
  value,
  onChange,
  onSend,
  sending,
  placeholder,
  disabled,
  assistRunning,
  language,
  onLanguageChange,
  onSuggest,
  onTranslate,
  onRewrite,
  focusToken,
  attachments,
  onAttach,
  onRemoveAttachment,
  uploading,
  onCancelUpload,
  attachmentsEnabled,
  attachmentsHint,
}: MessageComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [langOpen, setLangOpen] = useState(false);
  const [toneOpen, setToneOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Nested drag enter/leave events fire constantly over child elements, so
   *  the highlight is driven by a depth count rather than the last event. */
  const dragDepth = useRef(0);

  const stage = useCallback(
    async (files: FileList | File[] | null) => {
      const list = Array.from(files || []);
      if (list.length === 0) return;
      if (!attachmentsEnabled) {
        setAttachError(attachmentsHint || 'Attachments are not configured.');
        return;
      }
      setAttachError(null);
      const staged: ChatPendingAttachment[] = [];
      for (const file of list) {
        const result = await toPendingAttachment(file);
        if ('error' in result) setAttachError(result.error);
        else staged.push(result);
      }
      if (staged.length > 0) onAttach(staged);
    },
    [onAttach, attachmentsEnabled, attachmentsHint],
  );

  // Grow with the text, up to a third of the window.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  useEffect(() => {
    if (focusToken) textareaRef.current?.focus();
  }, [focusToken]);

  // A file with no caption is a perfectly good message.
  const canSend = (!!value.trim() || attachments.length > 0) && !sending && !disabled && !uploading;
  const dropAllowed = attachmentsEnabled;
  const hasDraft = !!value.trim();
  const currentLanguage = LANGUAGES.find((l) => l.id === language) || LANGUAGES[0];

  const assistButton = (
    label: string,
    Icon: any,
    onClick: () => void,
    opts?: { enabled?: boolean; title?: string; accent?: string },
  ) => (
    <button
      onClick={onClick}
      disabled={assistRunning || opts?.enabled === false}
      title={opts?.title || label}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors',
        'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:hover:bg-transparent',
        opts?.accent,
      )}
    >
      {assistRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {label}
    </button>
  );

  return (
    <div
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        // Without this the drop never fires — the window handler in App
        // cancels navigation but the element must claim the drop itself.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        void stage(e.dataTransfer.files);
      }}
      className={cn(
        'relative border-t border-[var(--border)] bg-[var(--bg-secondary)]/50',
        dragOver && 'ring-2 ring-inset ring-[var(--accent)]',
      )}
    >
      {dragOver && dropAllowed && (
        <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-[var(--bg-secondary)]/90 text-[12px] font-medium text-[var(--accent)] pointer-events-none">
          <Paperclip className="w-4 h-4" />
          Drop to attach
        </div>
      )}

      <AttachmentTray
        attachments={attachments}
        onRemove={onRemoveAttachment}
        uploading={uploading}
        onCancelUpload={onCancelUpload}
      />

      {attachError && (
        <div className="flex items-center gap-1.5 mx-3 mt-2 px-2 py-1 rounded-md bg-[var(--error)]/10 border border-[var(--error)]/30">
          <p className="flex-1 text-[10px] text-[var(--error)]">{attachError}</p>
          <button onClick={() => setAttachError(null)} className="text-[var(--error)]">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* AI toolbar */}
      <div className="flex items-center gap-0.5 px-3 pt-2 flex-wrap">
        {assistButton('Suggest reply', Sparkles, onSuggest, {
          title: hasDraft ? 'Polish what you typed into three options' : 'Draft three replies to this conversation',
          accent: 'hover:text-purple-400',
        })}

        <div className="relative">
          <div className="flex items-center">
            {assistButton(`Translate → ${currentLanguage.flag}`, Languages, onTranslate, {
              enabled: hasDraft,
              title: hasDraft
                ? `Rewrite your draft in ${currentLanguage.label}`
                : 'Type something first, or highlight a message to translate it',
              accent: 'hover:text-[var(--accent-2)]',
            })}
            <button
              onClick={() => setLangOpen((v) => !v)}
              title="Change target language"
              className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
              <ChevronDown className="w-3 h-3" />
            </button>
          </div>
          {langOpen && (
            <div className="absolute bottom-full left-0 mb-1 w-40 py-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] shadow-[var(--shadow-float)] z-20">
              {LANGUAGES.map((l) => (
                <button
                  key={l.id}
                  onClick={() => {
                    onLanguageChange(l.id);
                    setLangOpen(false);
                  }}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-tertiary)]',
                    l.id === language ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
                  )}
                >
                  <span>{l.flag}</span>
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          {assistButton('Rewrite', Wand2, () => setToneOpen((v) => !v), {
            enabled: hasDraft,
            title: hasDraft ? 'Rewrite your draft in a different tone' : 'Type something first',
            accent: 'hover:text-[var(--accent)]',
          })}
          {toneOpen && hasDraft && (
            <div className="absolute bottom-full left-0 mb-1 w-40 py-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] shadow-[var(--shadow-float)] z-20">
              {TONES.map((tone) => (
                <button
                  key={tone.id}
                  onClick={() => {
                    onRewrite(tone.id);
                    setToneOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  {tone.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="flex items-end gap-2 p-3 pt-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void stage(e.target.files);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = '';
          }}
        />
        <button
          onClick={() => {
            if (!attachmentsEnabled) {
              setAttachError(attachmentsHint || 'Attachments are not configured.');
              return;
            }
            fileInputRef.current?.click();
          }}
          disabled={disabled || !!uploading}
          title={attachmentsEnabled ? 'Attach a file' : attachmentsHint || 'Attachments are not configured'}
          className={cn(
            'p-2.5 rounded-xl shrink-0 hover:bg-[var(--bg-tertiary)] disabled:opacity-40',
            attachmentsEnabled
              ? 'text-[var(--text-secondary)] hover:text-[var(--accent)]'
              : 'text-[var(--text-muted)] opacity-50',
          )}
        >
          <Paperclip className="w-4 h-4" />
        </button>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          onPaste={(e) => {
            // Only intercept when the clipboard actually carries files —
            // otherwise a normal text paste would be swallowed.
            const files = Array.from(e.clipboardData?.files || []);
            if (files.length === 0) return;
            e.preventDefault();
            void stage(files);
          }}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          className="flex-1 resize-none bg-[var(--bg-tertiary)] rounded-xl px-3 py-2.5 text-[13px] leading-relaxed outline-none border border-transparent focus:border-[var(--accent)]/50 placeholder:text-[var(--text-muted)] disabled:opacity-50"
        />
        <button
          onClick={onSend}
          disabled={!canSend}
          title="Send  (Enter)"
          className={cn(
            'p-2.5 rounded-xl transition-colors shrink-0',
            canSend
              ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
              : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
          )}
        >
          {sending || uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
