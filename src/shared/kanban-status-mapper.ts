import type { AppSettings, KanbanTaskStatus } from './types';

function csvToSet(csv: string | undefined): Set<string> {
  if (!csv) return new Set();
  return new Set(
    csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

/**
 * Maps a ClickUp status name to the local Kanban column it belongs to,
 * using the user's configured status names from settings.
 *
 * Returns `null` when the status doesn't match any known column — callers
 * should leave the existing `kanbanStatus` untouched in that case so manual
 * drags are not overwritten.
 */
export function mapClickupStatusToKanban(
  clickupStatus: string | null | undefined,
  settings: AppSettings,
): KanbanTaskStatus | null {
  if (!clickupStatus) return null;
  const s = clickupStatus.trim().toLowerCase();

  if (s === (settings.autoFixFailedStatus || 'failed').toLowerCase()) return 'failed';
  if (s === (settings.autoFixDoneStatus || 'done').toLowerCase()) return 'done';
  if (s === (settings.autoFixRetestStatus || 'qc').toLowerCase()) return 'review';

  if (csvToSet(settings.kanbanBacklogStatuses).has(s)) return 'todo';
  if (csvToSet(settings.kanbanInProgressStatuses).has(s)) return 'in-progress';

  // Common review/closed aliases — covers the typical ClickUp status vocabulary
  if (s === 'review' || s === 'in review' || s === 'ready for review') return 'review';
  if (s === 'complete' || s === 'closed') return 'done';
  if (s === 'in progress') return 'in-progress';

  return null;
}
