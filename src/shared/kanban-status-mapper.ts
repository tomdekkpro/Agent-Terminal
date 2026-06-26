import type { AppSettings, KanbanTaskStatus } from './types';

function csvToSet(csv: string | undefined): Set<string> {
  if (!csv) return new Set();
  return new Set(
    csv.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

/**
 * True when `status` matches any entry in a comma-separated status setting.
 * The Auto Code status fields (Failed/Start/Re-Test/Done) accept a single
 * value OR a comma-separated list, so a workflow with several "failed"-type
 * statuses (e.g. "Failed, Review Failed") can trigger the same behaviour.
 * Matching is case-insensitive and whitespace-trimmed.
 */
export function statusMatchesAny(
  status: string | null | undefined,
  csv: string | undefined,
  fallback = '',
): boolean {
  if (!status) return false;
  const s = status.trim().toLowerCase();
  if (!s) return false;
  const list = csv && csv.trim() ? csv : fallback;
  return csvToSet(list).has(s);
}

/**
 * The status name to WRITE BACK for a setting that may hold a list — the first
 * entry, with original casing preserved (ClickUp status names can be
 * case-sensitive when updating). Falls back when the setting is empty.
 */
export function primaryStatus(csv: string | undefined, fallback: string): string {
  const first = (csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first || fallback;
}

/**
 * Which settings field holds the ClickUp status list for each Kanban column.
 * The order here is also the match priority: when a ClickUp status appears in
 * more than one column's list, the first match (top of this list) wins.
 */
const COLUMN_STATUS_SETTING: Array<[KanbanTaskStatus, keyof AppSettings]> = [
  ['todo', 'kanbanBacklogStatuses'],
  ['in-progress', 'kanbanInProgressStatuses'],
  ['review', 'kanbanReviewStatuses'],
  ['failed', 'kanbanFailedStatuses'],
  ['done', 'kanbanDoneStatuses'],
];

/**
 * Maps a ClickUp status name to the local Kanban column it belongs to,
 * using the user's configured per-column status names from settings.
 *
 * Returns `null` when the status doesn't match any column — callers should
 * leave the existing `kanbanStatus` untouched in that case so manual drags are
 * not overwritten.
 */
export function mapClickupStatusToKanban(
  clickupStatus: string | null | undefined,
  settings: AppSettings,
): KanbanTaskStatus | null {
  if (!clickupStatus) return null;
  const s = clickupStatus.trim().toLowerCase();

  // Auto-fix write-back targets always map, so the loop's own ClickUp
  // transitions are recognised even if the user trimmed them from the
  // per-column lists below.
  if (statusMatchesAny(s, settings.autoCodeFailedStatus, 'failed')) return 'failed';
  if (statusMatchesAny(s, settings.autoCodeReviewFailedStatus, 'review failed')) return 'failed';
  if (statusMatchesAny(s, settings.autoCodeDoneStatus, 'done')) return 'done';
  if (statusMatchesAny(s, settings.autoCodeReviewStatus, 'ready for review')) return 'review';
  if (statusMatchesAny(s, settings.autoCodeInProgressStatus, 'in progress')) return 'in-progress';

  // User-configured per-column mapping
  for (const [column, settingKey] of COLUMN_STATUS_SETTING) {
    if (csvToSet(settings[settingKey] as string | undefined).has(s)) return column;
  }

  return null;
}
