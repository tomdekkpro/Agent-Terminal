import { app } from 'electron';
import { join } from 'path';
import { readdir, readFile, writeFile, unlink, mkdir } from 'fs/promises';
import type { InsightsSession, InsightsSessionMeta } from '../../shared/types';

function getSessionsDir(): string {
  return join(app.getPath('userData'), 'insights', 'sessions');
}

async function ensureDir(): Promise<void> {
  await mkdir(getSessionsDir(), { recursive: true });
}

export async function listSessions(): Promise<InsightsSessionMeta[]> {
  await ensureDir();
  const dir = getSessionsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const metas: InsightsSessionMeta[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file), 'utf-8');
      const session: InsightsSession = JSON.parse(raw);
      metas.push({
        id: session.id,
        title: session.title,
        messageCount: session.messages.length,
        model: session.model,
        provider: session.provider,
        projectPath: session.projectPath,
        pinned: session.pinned,
        mode: session.mode,
        discussionStatus: session.discussionStatus,
        qcStatus: session.qcTask?.status,
        qcPassed: session.qcTask?.testCases.filter((tc) => tc.status === 'passed').length,
        qcFailed: session.qcTask?.testCases.filter((tc) => tc.status === 'failed' || tc.status === 'error').length,
        qcTotal: session.qcTask?.testCases.length,
        qcDurationMs: session.qcTask?.durationMs,
        linkedTaskName: session.linkedTask?.name || session.qcTask?.linkedTask?.name,
        linkedTaskColor: session.linkedTask?.statusColor || session.qcTask?.linkedTask?.statusColor,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    } catch {
      // skip corrupt files
    }
  }

  // Pinned sessions first, then by updatedAt
  return metas.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

export async function getSession(id: string): Promise<InsightsSession | null> {
  try {
    const raw = await readFile(join(getSessionsDir(), `${id}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveSession(session: InsightsSession): Promise<void> {
  await ensureDir();
  await writeFile(join(getSessionsDir(), `${session.id}.json`), JSON.stringify(session, null, 2));
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await unlink(join(getSessionsDir(), `${id}.json`));
  } catch {
    // already gone
  }
}

export async function renameSession(id: string, title: string): Promise<void> {
  const session = await getSession(id);
  if (!session) return;
  session.title = title;
  session.updatedAt = new Date().toISOString();
  await saveSession(session);
}

export async function togglePinSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;
  session.pinned = !session.pinned;
  await saveSession(session);
  return session.pinned;
}

export async function deleteMessageAndAfter(sessionId: string, messageId: string): Promise<InsightsSession | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  const idx = session.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return session;
  session.messages = session.messages.slice(0, idx);
  session.updatedAt = new Date().toISOString();
  await saveSession(session);
  return session;
}

export async function exportSessionAsMarkdown(id: string): Promise<string | null> {
  const session = await getSession(id);
  if (!session) return null;
  const lines: string[] = [`# ${session.title}`, ''];
  if (session.projectPath) lines.push(`**Project:** ${session.projectPath}`, '');
  lines.push(`**Provider:** ${session.provider || 'claude'} | **Model:** ${session.model}`, '');
  lines.push(`**Created:** ${new Date(session.createdAt).toLocaleString()}`, '---', '');
  for (const msg of session.messages) {
    const label = msg.role === 'user' ? '## You' : `## ${session.provider || 'Claude'}`;
    lines.push(label, '', msg.content, '');
  }
  return lines.join('\n');
}
