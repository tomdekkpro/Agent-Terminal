import { Notification, shell } from 'electron';
import type { ActivityEvent } from '../../shared/types';
import { getSettings } from '../ipc/settings-handlers';
import { debugLog } from '../../shared/utils';

/** Activity kinds that warrant a native OS notification. Routine info events
 *  (e.g. "fix started") are recorded in the feed but don't interrupt the user. */
const NOTIFY_KINDS = new Set<string>([
  'fix-pushed',
  'fix-escalated',
  'fix-failed',
  'pr-auto-merged',
  'merge-blocked',
  'qc-failed',
  'review-rejected',
  'review-failed',
]);

/** Fire a native OS notification for an activity event when appropriate.
 *  Gated by the global `notificationsEnabled` setting and the kind allowlist.
 *  Clicking the notification opens the event's URL (PR/ClickUp) if present. */
export function maybeNotify(ev: ActivityEvent): void {
  try {
    if (!getSettings().notificationsEnabled) return;
    if (!NOTIFY_KINDS.has(ev.kind)) return;
    if (!Notification.isSupported()) return;

    const n = new Notification({
      title: ev.title,
      body: ev.message || '',
      // 'critical' urgency on Linux; harmless elsewhere.
      urgency: ev.level === 'error' ? 'critical' : 'normal',
    });
    if (ev.url) {
      n.on('click', () => {
        void shell.openExternal(ev.url!).catch(() => { /* non-critical */ });
      });
    }
    n.show();
  } catch (err) {
    debugLog(`[Notifier] Failed to show notification: ${err instanceof Error ? err.message : String(err)}`);
  }
}
