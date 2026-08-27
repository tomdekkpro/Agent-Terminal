import { useMemo, useState } from 'react';
import { Check, Loader2, Search, Users, X } from 'lucide-react';
import type { ChatUser } from '../../../shared/types';
import { cn } from '../../../shared/utils';
import { Avatar } from './Avatar';

interface NewDmModalProps {
  people: ChatUser[];
  onClose: () => void;
  onStart: (userIds: string[]) => Promise<string | null>;
}

/** Pick one person for a DM, or several for a group. ClickUp returns the
 *  existing conversation when there is one, so this never creates duplicates. */
export function NewDmModal({ people, onClose, onStart }: NewDmModalProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) => p.username.toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q),
    );
  }, [people, query]);

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id].slice(0, 15),
    );

  const start = async () => {
    if (selected.length === 0 || starting) return;
    setStarting(true);
    setError(null);
    const channelId = await onStart(selected);
    setStarting(false);
    if (channelId) onClose();
    else setError('ClickUp would not open that conversation. Check the workspace has Chat enabled.');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[70vh] flex flex-col rounded-2xl bg-[var(--bg-card)] border border-[var(--border-strong)] shadow-[var(--shadow-float)]"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <Users className="w-4 h-4 text-[var(--accent)]" />
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">New direct message</h2>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 border-b border-[var(--border)]">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email"
              className="w-full pl-8 pr-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-transparent focus:border-[var(--accent)]/50 outline-none text-[13px] placeholder:text-[var(--text-muted)]"
            />
          </div>
          {selected.length > 0 && (
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              {selected.length === 1
                ? '1 person selected'
                : `${selected.length} people selected — this becomes a group chat`}
            </p>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-[var(--text-muted)]">
              {people.length === 0 ? 'No workspace members loaded.' : 'Nobody matches that.'}
            </p>
          )}
          {filtered.map((person) => {
            const picked = selected.includes(person.id);
            return (
              <button
                key={person.id}
                onClick={() => toggle(person.id)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors',
                  picked ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-tertiary)]',
                )}
              >
                <Avatar user={person} size="sm" presence />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-[var(--text-primary)] truncate">{person.username}</div>
                  {person.email && (
                    <div className="text-[10px] text-[var(--text-muted)] truncate">{person.email}</div>
                  )}
                </div>
                {picked && <Check className="w-4 h-4 text-[var(--accent)] shrink-0" />}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="mx-3 mb-2 p-2 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[11px] text-[var(--error)]">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 px-3 py-3 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            onClick={start}
            disabled={selected.length === 0 || starting}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium',
              selected.length > 0 && !starting
                ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]',
            )}
          >
            {starting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Start conversation
          </button>
        </div>
      </div>
    </div>
  );
}
