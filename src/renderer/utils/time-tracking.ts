import { splitTimeByDate } from '../../shared/utils';

/**
 * Post time entries to the task manager, split by calendar day.
 * If the session spans midnight, creates one entry per day.
 */
export async function postTimeEntriesByDate(
  taskId: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  const entries = splitTimeByDate(startMs, endMs);
  for (const entry of entries) {
    await window.electronAPI.postTaskTimeEntry(taskId, entry.startMs, entry.durationMs);
  }
}

/**
 * Fire-and-forget version for beforeunload / sync contexts.
 * Posts each day-segment without awaiting.
 */
export function postTimeEntriesByDateSync(
  taskId: string,
  startMs: number,
  endMs: number,
): void {
  const entries = splitTimeByDate(startMs, endMs);
  for (const entry of entries) {
    try {
      window.electronAPI.postTaskTimeEntry(taskId, entry.startMs, entry.durationMs);
    } catch { /* best effort */ }
  }
}
