import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { AlertTriangle, Check, Copy, CornerDownLeft, Loader2, Sparkles, X } from 'lucide-react';
import type { ChatAssistKind } from '../../../shared/types';
import type { ChatAssistState } from '../../stores/chat-store';
import { cn } from '../../../shared/utils';
import { MARKDOWN_COMPONENTS, REMARK_PLUGINS } from './markdown';

const TITLES: Record<ChatAssistKind, string> = {
  suggest: 'Suggested replies',
  summarize: 'Summary',
  translate: 'Translation',
  explain: 'What this means',
  'action-items': 'Action items',
  rewrite: 'Rewritten',
};

/** Kinds that produce a body meant to go straight into the composer. */
const INSERTABLE: ChatAssistKind[] = ['translate', 'rewrite'];

interface AssistPanelProps {
  assist: ChatAssistState;
  onClose: () => void;
  /** Drop text into the composer, replacing whatever is there. */
  onUse: (text: string) => void;
  /** Send the AI's answer to the conversation as a message. */
  onSend?: (text: string) => void;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title="Copy"
      className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

/**
 * Where every AI answer lands.
 *
 * One panel for all six actions rather than a dialog per action: the user's
 * next move is always the same shape — read it, copy it, or put it in the
 * composer — so the affordances stay in one predictable place.
 */
export function AssistPanel({ assist, onClose, onUse, onSend }: AssistPanelProps) {
  const { running, kind, suggestions, summary, text, raw, error, selection } = assist;
  if (!running && !kind && !error) return null;

  const title = kind ? TITLES[kind] : 'Working…';
  const body = summary || raw;

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-card)]/80 max-h-[45%] flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <Sparkles className="w-3.5 h-3.5 text-purple-400" />
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">{title}</span>
        {running && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--text-muted)]" />}
        <button
          onClick={onClose}
          className="ml-auto p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="overflow-y-auto p-3 space-y-2">
        {selection && (
          <div className="px-2 py-1.5 rounded-lg bg-[var(--bg-tertiary)]/60 border-l-2 border-[var(--accent)]/50">
            <p className="text-[11px] text-[var(--text-muted)] line-clamp-3 italic">“{selection}”</p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30">
            <AlertTriangle className="w-3.5 h-3.5 text-[var(--error)] shrink-0 mt-0.5" />
            <p className="text-[11px] text-[var(--error)]">{error}</p>
          </div>
        )}

        {running && !suggestions.length && !body && !text && (
          <p className="text-[11px] text-[var(--text-muted)] py-2">
            Running the local agent — this takes a few seconds.
          </p>
        )}

        {/* suggest: pick one */}
        {suggestions.map((suggestion, i) => (
          <div
            key={i}
            className="group rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/60 hover:border-[var(--accent)]/40 transition-colors"
          >
            <div className="flex items-center gap-2 px-2.5 pt-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                {suggestion.title}
              </span>
              <div className="ml-auto flex items-center gap-0.5">
                <CopyButton text={suggestion.text} />
                <button
                  onClick={() => onUse(suggestion.text)}
                  title="Put this in the composer"
                  className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--accent)]"
                >
                  <CornerDownLeft className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <button
              onClick={() => onUse(suggestion.text)}
              className="w-full text-left px-2.5 pb-2 pt-1 text-[12px] leading-relaxed text-[var(--text-primary)]"
            >
              {suggestion.text}
            </button>
          </div>
        ))}

        {/* translate / rewrite: one body, ready to send */}
        {text && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/60 p-2.5">
            <p className="text-[12px] leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap break-words">
              {text}
            </p>
            <div className="flex items-center gap-1 mt-2 pt-2 border-t border-[var(--border)]">
              <button
                onClick={() => onUse(text)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--accent)]/15 text-[var(--accent)] text-[11px] font-medium hover:bg-[var(--accent)]/25"
              >
                <CornerDownLeft className="w-3 h-3" />
                Use in composer
              </button>
              {onSend && kind && INSERTABLE.includes(kind) && (
                <button
                  onClick={() => onSend(text)}
                  className="px-2 py-1 rounded-md text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                >
                  Send it now
                </button>
              )}
              <div className="ml-auto">
                <CopyButton text={text} />
              </div>
            </div>
          </div>
        )}

        {/* summarize / explain / action-items: read it */}
        {body && (
          <div className={cn('rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/60 p-2.5')}>
            <div className="insights-prose text-[12px] text-[var(--text-primary)]">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
                {body}
              </ReactMarkdown>
            </div>
            <div className="flex justify-end mt-1 pt-1.5 border-t border-[var(--border)]">
              <CopyButton text={body} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
