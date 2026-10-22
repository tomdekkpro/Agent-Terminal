import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { AgentProviderId, InsightsMessage, InsightsModel, InsightsStreamEvent, Persona } from '../../shared/types';
import { agentRegistry } from '../ipc/providers/agent-registry';
import { enrichContext, fetchTaskContext } from './context-enricher';

const activeStreams = new Map<string, ChildProcess>();

export async function sendMessage(
  sessionId: string,
  messages: InsightsMessage[],
  userMessage: string,
  model: InsightsModel,
  projectPath: string | undefined,
  getWindow: () => BrowserWindow | null,
  provider?: AgentProviderId,
  copilotModel?: string,
  persona?: Persona,
  linkedTaskId?: string,
): Promise<string> {
  const providerId = provider || 'claude';
  const agentProvider = agentRegistry.get(providerId);

  if (!agentProvider) {
    return Promise.reject(new Error(`Unknown agent provider: ${providerId}`));
  }

  if (!agentProvider.isAvailable()) {
    return Promise.reject(new Error(`${agentProvider.displayName} CLI is not installed. ${agentProvider.installHint}`));
  }

  // Fetch external context (ClickUp tasks, GitHub PRs/issues) based on persona integrations
  let externalContext = '';
  try {
    externalContext = await enrichContext(userMessage, persona, projectPath);
  } catch {
    // Non-critical — continue without enrichment
  }

  // Inject linked task context (always, since user explicitly linked it)
  if (linkedTaskId) {
    try {
      const taskCtx = await fetchTaskContext(linkedTaskId);
      if (taskCtx) {
        const linkedBlock = `--- LINKED TASK CONTEXT ---\n${taskCtx}\n--- END LINKED TASK CONTEXT ---\n`;
        externalContext = externalContext ? `${linkedBlock}\n${externalContext}` : linkedBlock;
      }
    } catch {
      // Non-critical
    }
  }

  // Build the effective user message, injecting persona context and external data
  let effectiveMessage = userMessage;
  if (externalContext) {
    effectiveMessage = `${externalContext}\n${effectiveMessage}`;
  }
  if (persona) {
    effectiveMessage = `[IMPORTANT: You are playing the role of "${persona.name}" (${persona.role}). ${persona.systemPrompt}]\n\n${effectiveMessage}`;
  }

  // Use provider-specific insights methods if available, otherwise fall back to generic spawn
  if (agentProvider.buildInsightsPrompt && agentProvider.buildInsightsArgs) {
    return spawnAgentChat(
      sessionId,
      agentProvider.command,
      agentProvider.buildInsightsPrompt(messages, effectiveMessage),
      agentProvider.buildInsightsArgs(providerId === 'copilot' ? (copilotModel || model) : model, projectPath),
      agentProvider.parseInsightsStreamLine?.bind(agentProvider) || null,
      providerId === 'copilot' ? projectPath : undefined,
      copilotModel && providerId === 'copilot' ? copilotModel : undefined,
      getWindow,
    );
  }

  // Fallback: pipe prompt to stdin, read raw stdout
  const prompt = messages.length > 0
    ? messages.map((m) => `${m.role}: ${m.content}`).join('\n\n') + `\n\nuser: ${effectiveMessage}`
    : effectiveMessage;

  return spawnAgentChat(
    sessionId,
    agentProvider.command,
    prompt,
    [],
    null,
    projectPath,
    undefined,
    getWindow,
  );
}

const CHAT_TIMEOUT = 5 * 60_000; // 5 minutes max per chat request

function spawnAgentChat(
  sessionId: string,
  command: string,
  prompt: string,
  args: string[],
  lineParser: ((line: string) => string | null) | null,
  cwd: string | undefined,
  copilotModel: string | undefined,
  getWindow: () => BrowserWindow | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // For copilot, append --model if provided
    const finalArgs = [...args];
    if (copilotModel && command === 'copilot') {
      finalArgs.push('--model', copilotModel);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn(command, finalArgs, {
      env,
      cwd: cwd || undefined,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.write(prompt);
    child.stdin?.end();

    activeStreams.set(sessionId, child);
    let fullText = '';
    let stderrText = '';
    let buffer = '';
    let settled = false;

    const sendEvent = (event: InsightsStreamEvent) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.INSIGHTS_STREAM_EVENT, event);
      }
    };

    // Timeout: kill the child process if it takes too long
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      activeStreams.delete(sessionId);
      child.kill('SIGTERM');
      if (fullText) {
        // Got partial output — resolve with what we have
        sendEvent({ type: 'done', sessionId });
        resolve(fullText);
      } else {
        const errorMsg = `${command} timed out after ${CHAT_TIMEOUT / 1000}s`;
        sendEvent({ type: 'error', sessionId, error: errorMsg });
        reject(new Error(errorMsg));
      }
    }, CHAT_TIMEOUT);

    child.stdout?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();

      if (lineParser) {
        // Line-based parsing (e.g. Claude stream-json)
        buffer += data;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const text = lineParser(line);
          if (text) {
            fullText += text;
            sendEvent({ type: 'text', sessionId, text });
          }
        }
      } else {
        // Raw stdout (e.g. Copilot, Gemini)
        fullText += data;
        sendEvent({ type: 'text', sessionId, text: data });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeStreams.delete(sessionId);
      // Flush remaining buffer
      if (lineParser && buffer.trim()) {
        const text = lineParser(buffer);
        if (text) {
          fullText += text;
          sendEvent({ type: 'text', sessionId, text });
        }
      }
      if (code !== 0 && !fullText) {
        const errorMsg = stderrText.trim() || `${command} exited with code ${code}`;
        sendEvent({ type: 'error', sessionId, error: errorMsg });
        reject(new Error(errorMsg));
      } else {
        sendEvent({ type: 'done', sessionId });
        resolve(fullText);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeStreams.delete(sessionId);
      sendEvent({ type: 'error', sessionId, error: err.message });
      reject(err);
    });
  });
}

export function abortStream(sessionId: string): void {
  const child = activeStreams.get(sessionId);
  if (child) {
    child.kill('SIGTERM');
    activeStreams.delete(sessionId);
  }
}

export function abortAllStreams(): void {
  for (const [id, child] of activeStreams) {
    child.kill('SIGTERM');
    activeStreams.delete(id);
  }
}
