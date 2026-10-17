import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Ticket, X } from 'lucide-react';
import type { TaskManagerList } from '../../../shared/types';
import { cn } from '../../../shared/utils';

interface CreateTaskModalProps {
  /** The message (or highlighted excerpt) the task is being made from. */
  source: string;
  /** Who said it and where, appended to the description for traceability. */
  attribution?: string;
  onClose: () => void;
}

/** First line of the message, trimmed to something that reads as a title. */
function suggestTitle(source: string): string {
  const firstLine = (source || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  return firstLine.slice(0, 120);
}

/**
 * "Can you make a ticket for this?" — the most common thing that happens to a
 * message in a dev team's chat, done without leaving the conversation.
 */
export function CreateTaskModal({ source, attribution, onClose }: CreateTaskModalProps) {
  const [lists, setLists] = useState<TaskManagerList[]>([]);
  const [listId, setListId] = useState('');
  const [name, setName] = useState(() => suggestTitle(source));
  const [description, setDescription] = useState(
    () => (attribution ? `${source}\n\n---\nFrom ClickUp Chat — ${attribution}` : source),
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ url?: string; customId?: string; id: string } | null>(null);

  useEffect(() => {
    window.electronAPI.getTaskManagerLists().then((result: any) => {
      if (result?.success && Array.isArray(result.data)) {
        setLists(result.data);
        setListId((current) => current || result.data[0]?.id || '');
      }
    }).catch(() => {});
  }, []);

  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    const result = await window.electronAPI.chatCreateTaskFromMessage({
      name: name.trim(),
      description,
      listId: listId || undefined,
    });
    setCreating(false);
    if (!result?.success) {
      setError(result?.error || 'Failed to create the task');
      return;
    }
    setCreated({ url: result.data?.url, customId: result.data?.customId, id: result.data?.id });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl bg-[var(--bg-card)] border border-[var(--border-strong)] shadow-[var(--shadow-float)]"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <Ticket className="w-4 h-4 text-[var(--clickup-purple)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">New task from this message</h2>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {created ? (
          <div className="p-6 text-center space-y-3">
            <p className="text-sm text-[var(--text-primary)]">
              Created <span className="font-semibold">{created.customId || created.id}</span>
            </p>
            <div className="flex items-center justify-center gap-2">
              {created.url && (
                <button
                  onClick={() => window.electronAPI.openExternal(created.url!)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)]/15 text-[var(--accent)] text-[12px] font-medium hover:bg-[var(--accent)]/25"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open in ClickUp
                </button>
              )}
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  Title
                </label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-transparent focus:border-[var(--accent)]/50 outline-none text-[13px]"
                />
              </div>

              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  List
                </label>
                <select
                  value={listId}
                  onChange={(e) => setListId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-transparent focus:border-[var(--accent)]/50 outline-none text-[13px]"
                >
                  {lists.length === 0 && <option value="">Default list from Settings</option>}
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.space ? `${list.space} › ` : ''}{list.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-transparent focus:border-[var(--accent)]/50 outline-none text-[12px] leading-relaxed resize-none"
                />
              </div>

              {error && (
                <p className="p-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[11px] text-[var(--error)]">
                  {error}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                Cancel
              </button>
              <button
                onClick={create}
                disabled={!name.trim() || creating}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium',
                  name.trim() && !creating
                    ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
                )}
              >
                {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Create task
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
