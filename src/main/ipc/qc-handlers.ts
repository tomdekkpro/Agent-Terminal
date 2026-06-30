import type { BrowserWindow, IpcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { IPC_CHANNELS } from '../../shared/constants';
import type { InsightsModel, QCTask } from '../../shared/types';
import { splitTimeByDate } from '../../shared/utils';
import { generateTestCases, runAllTests, runTestCase, abortQC } from '../qc/qc-executor';
import { getSession, saveSession } from '../insights/session-storage';
import { getActiveProvider } from './task-manager-handlers';
import { getSettings } from './settings-handlers';
import { listKanbanTasks } from '../kanban/kanban-task-store';
import { broadcastKanbanTaskUpdate } from './kanban-handlers';
import { recordActivity } from '../activity/activity-store';

/** Bridge a finished QC run to the auto-code loop + activity feed. When tests
 *  fail and the QC task is linked to a tracked task, mirror the captured
 *  console/network diagnostics onto the matching KanbanTask (so the next
 *  auto-code attempt sees them) and record a 'qc-failed' activity event. */
function bridgeQCDiagnostics(task: QCTask): void {
  if (!task.linkedTask) return;
  const failed = task.testCases.filter((tc) => tc.status === 'failed');
  if (failed.length === 0) return;

  const dedupe = (arr: string[]) => Array.from(new Set(arr.filter(Boolean))).slice(0, 40);
  const consoleErrors = dedupe(failed.flatMap((tc) => tc.consoleErrors || []));
  const networkErrors = dedupe(failed.flatMap((tc) => tc.networkErrors || []));

  try {
    const match = listKanbanTasks().find((t) => t.clickupTaskId === task.linkedTask!.id);
    if (match && (consoleErrors.length || networkErrors.length)) {
      broadcastKanbanTaskUpdate(match.id, {
        qcDiagnostics: { consoleErrors, networkErrors, capturedAt: new Date().toISOString() },
      });
    }
  } catch { /* non-critical */ }

  const extras: string[] = [];
  if (consoleErrors.length) extras.push(`${consoleErrors.length} console error(s)`);
  if (networkErrors.length) extras.push(`${networkErrors.length} network error(s)`);
  recordActivity({
    source: 'qc',
    kind: 'qc-failed',
    level: 'error',
    title: `QC failed: ${task.linkedTask.name || task.title}`,
    message: `${failed.length} test(s) failed${extras.length ? ` — ${extras.join(', ')}` : ''}.`,
    clickupTaskId: task.linkedTask.id,
    taskName: task.linkedTask.name || task.title,
    url: task.linkedTask.url,
  });
}

/** Post QC duration as time entries split by calendar day to the linked task */
async function postQCTimeEntries(task: QCTask): Promise<void> {
  if (!task.linkedTask || !task.startedAt) return;
  const provider = getActiveProvider();
  if (!provider) return;

  const startMs = new Date(task.startedAt).getTime();
  const endMs = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  if (endMs <= startMs) return;

  const entries = splitTimeByDate(startMs, endMs);
  const settings = getSettings();
  for (const entry of entries) {
    try {
      await provider.postTimeEntry(settings, task.linkedTask.id, entry.startMs, entry.durationMs, `QC: ${task.title}`);
    } catch { /* non-critical */ }
  }
}

export function registerQCHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  // Generate test cases from task description
  ipcMain.handle(
    IPC_CHANNELS.QC_GENERATE_TESTS,
    async (_event, sessionId: string, title: string, description: string, targetUrl: string, model: InsightsModel) => {
      try {
        const session = await getSession(sessionId);
        if (!session) return { success: false, error: 'Session not found' };

        const testCases = await generateTestCases(sessionId, title, description, targetUrl, model, getWindow);

        const qcTask: QCTask = {
          id: uuidv4(),
          sessionId,
          title,
          description,
          targetUrl,
          testCases,
          status: 'ready',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        session.qcTask = qcTask;
        session.updatedAt = new Date().toISOString();
        await saveSession(session);

        return { success: true, data: qcTask };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to generate tests' };
      }
    },
  );

  // Run all test cases
  ipcMain.handle(
    IPC_CHANNELS.QC_RUN_TESTS,
    async (_event, sessionId: string, model: InsightsModel) => {
      try {
        const session = await getSession(sessionId);
        if (!session?.qcTask) return { success: false, error: 'No QC task found' };

        // Reset all test cases to pending so re-runs work after completion
        session.qcTask.testCases = session.qcTask.testCases.map(tc => ({
          ...tc,
          status: 'pending' as const,
          startedAt: undefined,
          completedAt: undefined,
          durationMs: undefined,
          errorMessage: undefined,
          steps: tc.steps.map(s => ({ ...s, status: 'pending' as const, actual: undefined, screenshot: undefined })),
        }));
        session.qcTask.status = 'running';
        session.qcTask.startedAt = new Date().toISOString();
        session.qcTask.completedAt = undefined;
        session.qcTask.durationMs = undefined;
        session.qcTask.summary = undefined;
        await saveSession(session);

        const updatedTask = await runAllTests(sessionId, session.qcTask, model, getWindow);

        // Reload session and update
        const freshSession = await getSession(sessionId);
        if (freshSession) {
          freshSession.qcTask = updatedTask;
          freshSession.updatedAt = new Date().toISOString();
          await saveSession(freshSession);
        }

        // Post QC time entries to linked task (split by date)
        try { await postQCTimeEntries(updatedTask); } catch { /* non-critical */ }

        // Bridge diagnostics → auto-code loop + activity feed
        try { bridgeQCDiagnostics(updatedTask); } catch { /* non-critical */ }

        return { success: true, data: updatedTask };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to run tests' };
      }
    },
  );

  // Run a single test case
  ipcMain.handle(
    IPC_CHANNELS.QC_RUN_SINGLE_TEST,
    async (_event, sessionId: string, testCaseId: string, model: InsightsModel) => {
      try {
        const session = await getSession(sessionId);
        if (!session?.qcTask) return { success: false, error: 'No QC task found' };

        const testCase = session.qcTask.testCases.find((tc) => tc.id === testCaseId);
        if (!testCase) return { success: false, error: 'Test case not found' };

        const result = await runTestCase(
          sessionId,
          session.qcTask.id,
          { ...testCase, status: 'pending', steps: testCase.steps.map((s) => ({ ...s, status: 'pending' as const })) },
          session.qcTask.targetUrl,
          session.qcTask.credentials,
          model,
          getWindow,
        );

        // Update session
        const freshSession = await getSession(sessionId);
        if (freshSession?.qcTask) {
          freshSession.qcTask.testCases = freshSession.qcTask.testCases.map((tc) =>
            tc.id === testCaseId ? result : tc,
          );
          freshSession.qcTask.updatedAt = new Date().toISOString();
          await saveSession(freshSession);

          // Post single test case time entry to linked task (split by date)
          if (freshSession.qcTask.linkedTask && result.startedAt && result.durationMs) {
            const provider = getActiveProvider();
            if (provider) {
              const startMs = new Date(result.startedAt).getTime();
              const endMs = result.completedAt ? new Date(result.completedAt).getTime() : startMs + result.durationMs;
              const entries = splitTimeByDate(startMs, endMs);
              const settings = getSettings();
              for (const entry of entries) {
                try {
                  await provider.postTimeEntry(settings, freshSession.qcTask.linkedTask.id, entry.startMs, entry.durationMs, `QC: ${result.name}`);
                } catch { /* non-critical */ }
              }
            }
          }
        }

        return { success: true, data: result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to run test' };
      }
    },
  );

  // Abort QC execution
  ipcMain.handle(IPC_CHANNELS.QC_ABORT, async (_event, sessionId: string) => {
    abortQC(sessionId);

    // Update task and test case statuses on disk
    try {
      const session = await getSession(sessionId);
      if (session?.qcTask) {
        session.qcTask.testCases = session.qcTask.testCases.map(tc =>
          tc.status === 'running' ? { ...tc, status: 'pending' as const } : tc,
        );
        session.qcTask.status = 'ready';
        session.qcTask.updatedAt = new Date().toISOString();
        await saveSession(session);
        return { success: true, data: session.qcTask };
      }
    } catch { /* non-critical */ }

    return { success: true };
  });
}
