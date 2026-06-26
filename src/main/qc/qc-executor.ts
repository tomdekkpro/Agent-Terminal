import { spawn, execSync, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { QCTask, QCTestCase, QCTestStep, QCCredential, InsightsModel } from '../../shared/types';
import { getSession, saveSession } from '../insights/session-storage';
import { DEFAULT_PERSONAS } from '../../shared/types';
import { agentRegistry } from '../ipc/providers/agent-registry';
import { loadPersonas } from '../insights/persona-storage';
import { getSettings } from '../ipc/settings-handlers';

/** Get or create a directory for QC screenshots */
function getScreenshotDir(sessionId: string): string {
  const dir = path.join(app.getPath('userData'), 'qc-screenshots', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Load the QC persona's systemPrompt (falls back to default if not found) */
async function getQCPersonaPrompt(): Promise<string> {
  try {
    const personas = await loadPersonas();
    const qcPersona = personas.find((p) => p.id === 'qc');
    if (qcPersona?.systemPrompt) return qcPersona.systemPrompt;
  } catch { /* fall through to default */ }
  const defaultQC = DEFAULT_PERSONAS.find((p) => p.id === 'qc');
  return defaultQC?.systemPrompt ?? '';
}

/** Kill a process and its entire tree (important on Windows where SIGTERM doesn't cascade) */
function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      // Send SIGTERM to process group
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    // Fallback: direct kill
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

const activeProcesses = new Map<string, ChildProcess>();
const abortedSessions = new Set<string>();

export interface QCEvent {
  type: 'generating' | 'test-start' | 'step-update' | 'test-done' | 'screenshot' | 'all-done' | 'error';
  sessionId: string;
  taskId: string;
  testCaseId?: string;
  stepId?: string;
  stepOrder?: number;
  status?: string;
  message?: string;
  screenshot?: string;
  testCase?: QCTestCase;
  summary?: string;
}

function sendQCEvent(getWindow: () => BrowserWindow | null, event: QCEvent): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.QC_EVENT, event);
  }
}

/**
 * Generate test cases from a task description using AI.
 * The AI analyzes the task and produces structured test cases.
 */
export async function generateTestCases(
  _sessionId: string,
  taskTitle: string,
  taskDescription: string,
  targetUrl: string,
  model: InsightsModel,
  _getWindow: () => BrowserWindow | null,
): Promise<QCTestCase[]> {
  const claude = agentRegistry.get('claude');
  if (!claude || !claude.isAvailable()) {
    throw new Error('Claude CLI is required for QC testing');
  }

  const personaPrompt = await getQCPersonaPrompt();

  const prompt = `${personaPrompt}

Generate manual test cases for the following task.

TASK: ${taskTitle}
DESCRIPTION: ${taskDescription}
TARGET URL: ${targetUrl}

Generate test cases as a JSON array. Each test case should have practical, executable browser-based steps.
Focus on user-visible behavior that can be verified visually.

RESPOND WITH ONLY valid JSON in this exact format (no markdown, no explanation):
[
  {
    "name": "Test case name",
    "description": "Brief description of what this tests",
    "steps": [
      {
        "action": "Navigate to ${targetUrl}",
        "expected": "Page loads showing the main dashboard"
      },
      {
        "action": "Click on the 'Login' button",
        "expected": "Login form appears with email and password fields"
      }
    ]
  }
]

Generate 3-8 test cases covering:
- Happy path / main flow
- Edge cases and error handling
- UI/UX validation
- Form validation (if applicable)
- Navigation and routing
- Responsive behavior`;

  const modelId = model === 'opus' ? 'claude-opus-4-8' : model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn('claude', [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', modelId,
      '--dangerously-skip-permissions',
    ], {
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.write(prompt);
    child.stdin?.end();

    let fullText = '';
    let buffer = '';
    let stderrOutput = '';

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text;
          }
          if (parsed.type === 'result' && parsed.result) {
            const text = typeof parsed.result === 'string'
              ? parsed.result
              : parsed.result.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '';
            if (text) fullText += text;
          }
          if (parsed.type === 'assistant' && parsed.content) {
            fullText += parsed.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    child.on('close', () => {
      try {
        // Extract JSON from response (handle markdown code blocks)
        let jsonStr = fullText.trim();
        const jsonMatch = jsonStr.match(/\[[\s\S]*\]/);
        if (jsonMatch) jsonStr = jsonMatch[0];

        const raw = JSON.parse(jsonStr) as Array<{
          name: string;
          description: string;
          steps: Array<{ action: string; expected: string }>;
        }>;

        const testCases: QCTestCase[] = raw.map((tc) => ({
          id: uuidv4(),
          name: tc.name,
          description: tc.description,
          steps: tc.steps.map((s, i) => ({
            id: uuidv4(),
            order: i + 1,
            action: s.action,
            expected: s.expected,
            status: 'pending' as const,
          })),
          status: 'pending' as const,
        }));

        resolve(testCases);
      } catch (err) {
        reject(new Error(`Failed to parse test cases: ${err instanceof Error ? err.message : 'Unknown error'}\n\nRaw output:\n${fullText.slice(0, 500)}\n\nStderr:\n${stderrOutput.slice(0, 500)}`));
      }
    });

    child.on('error', reject);

    // 2 minute timeout for generation
    setTimeout(() => {
      killProcessTree(child);
      reject(new Error('Test case generation timed out'));
    }, 120_000);
  });
}

/**
 * Execute a single test case using Claude CLI with Playwright MCP tools.
 * Claude navigates the browser, performs actions, takes screenshots, and evaluates pass/fail.
 */
export async function runTestCase(
  sessionId: string,
  taskId: string,
  testCase: QCTestCase,
  targetUrl: string,
  credentials: QCCredential[] | undefined,
  model: InsightsModel,
  getWindow: () => BrowserWindow | null,
): Promise<QCTestCase> {
  const claude = agentRegistry.get('claude');
  if (!claude || !claude.isAvailable()) {
    throw new Error('Claude CLI is required for QC testing');
  }

  const tcStartedAt = new Date().toISOString();
  testCase.startedAt = tcStartedAt;

  sendQCEvent(getWindow, {
    type: 'test-start',
    sessionId,
    taskId,
    testCaseId: testCase.id,
    message: `Starting: ${testCase.name}`,
  });

  const personaPrompt = await getQCPersonaPrompt();

  const stepsDescription = testCase.steps
    .map((s, i) => `  Step ${i + 1}: ACTION: ${s.action} | EXPECTED: ${s.expected}`)
    .join('\n');

  const credentialsBlock = credentials && credentials.length > 0
    ? `\nLOGIN CREDENTIALS (use these whenever login/authentication is needed):\n${credentials.map(c => `  ${c.label}: ${c.value}`).join('\n')}\n`
    : '';

  const screenshotDir = getScreenshotDir(sessionId);

  const captureDiagnostics = getSettings().qcCaptureDiagnostics !== false;
  const diagnosticsInstructions = captureDiagnostics
    ? `

DIAGNOSTICS CAPTURE (REQUIRED):
- Before finishing, call browser_console_messages to read the browser console, and browser_network_requests to list network activity.
- Collect any console messages of type error/warning and any network requests that failed or returned a 4xx/5xx status.
- Report them in the JSON fields "consoleErrors" and "networkErrors" (arrays of short strings). Use empty arrays if there are none.`
    : '';
  const diagnosticsJsonFields = captureDiagnostics
    ? `,
  "consoleErrors": ["text of each console error/warning, if any"],
  "networkErrors": ["METHOD URL -> STATUS for each failed/4xx/5xx request, if any"]`
    : '';

  const prompt = `${personaPrompt}

You are executing a manual test case using a real browser.
You MUST use the Playwright browser tools (MCP) to perform each step.

TEST CASE: ${testCase.name}
DESCRIPTION: ${testCase.description}
TARGET URL: ${targetUrl}
${credentialsBlock}
STEPS TO EXECUTE:
${stepsDescription}

INSTRUCTIONS:
1. Use browser_navigate to open the target URL
2. For each step:
   a. Perform the action described (click, type, navigate, etc.) using the appropriate browser tool
   b. IMPORTANT: After performing the action, ALWAYS take a screenshot for evidence.
      Call browser_take_screenshot to capture the current state of the page.
   c. Evaluate if the actual result matches the expected result
3. After all steps, provide a summary

SCREENSHOT REQUIREMENTS:
- You MUST take a screenshot after EVERY step for evidence
- Use browser_take_screenshot after each action
- This is critical for QC documentation
${diagnosticsInstructions}

RESPOND WITH ONLY valid JSON (no markdown):
{
  "steps": [
    {
      "order": 1,
      "actual": "What actually happened after performing the action",
      "status": "passed" or "failed",
      "screenshot": "description of what the screenshot shows"
    }
  ],
  "overallStatus": "passed" or "failed",
  "summary": "Brief summary of test execution"${diagnosticsJsonFields}
}

IMPORTANT: Actually use the browser tools to navigate and interact with the page. Do NOT just imagine the results. Use browser_navigate, browser_click, browser_type, browser_take_screenshot, browser_snapshot, etc.`;

  const modelId = model === 'opus' ? 'claude-opus-4-8' : model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

  // Record start time so we can find screenshots created during this test
  const testStartTime = Date.now();

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn('claude', [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', modelId,
      '--allowedTools', 'mcp__plugin_playwright_playwright__*',
      '--dangerously-skip-permissions',
    ], {
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcesses.set(`${sessionId}:${testCase.id}`, child);

    child.stdin?.write(prompt);
    child.stdin?.end();

    let fullText = '';
    let buffer = '';
    let stderrOutput = '';
    let currentStepOrder = 0;
    let lastReportedStep = 0;
    let recentText = ''; // Accumulate recent text for step detection across fragments
    const screenshotPaths: Map<number, string> = new Map(); // stepOrder -> file path
    let resultText = ''; // The final result payload from Claude CLI
    // Queue of step orders at the time each browser_take_screenshot was requested.
    // Popped when the corresponding tool_result with image data arrives.
    const screenshotStepQueue: number[] = [];

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    // Detect which step is being executed from accumulated recent text
    const detectStep = (): void => {
      // Search all occurrences of step patterns in recent text, take the highest
      const matches = [...recentText.matchAll(/\b[Ss]tep\s+(\d+)\b/g)];
      if (matches.length > 0) {
        const stepNum = parseInt(matches[matches.length - 1][1], 10);
        // Only advance forward — never go backward (Claude may reference earlier steps in text)
        if (stepNum >= 1 && stepNum <= testCase.steps.length && stepNum > lastReportedStep) {
          currentStepOrder = stepNum;
          lastReportedStep = stepNum;
          const step = testCase.steps.find(s => s.order === stepNum);
          sendQCEvent(getWindow, {
            type: 'step-update',
            sessionId,
            taskId,
            testCaseId: testCase.id,
            stepOrder: stepNum,
            stepId: step?.id,
            status: 'running',
            message: `Running step ${stepNum}: ${step?.action || ''}`,
          });
          // Reset recent text after detecting a step to avoid re-detecting
          recentText = '';
        }
      }
      // Keep recent text manageable
      if (recentText.length > 500) recentText = recentText.slice(-200);
    };

    let screenshotCounter = 0;

    // Extract screenshot file path from tool_result content
    const extractScreenshotPath = (content: string): string | undefined => {
      // Match paths like .playwright-mcp\page-xxx.png or absolute paths
      const match = content.match(/\.(playwright-mcp[\\/][^\s)\]"]+\.png)/i)
        || content.match(/([A-Za-z]:[\\/][^\s)\]"]+\.(?:png|jpg|jpeg))/i)
        || content.match(/([\\/][^\s)\]"]+\.(?:png|jpg|jpeg))/i)
        || content.match(/(playwright[^\s)\]"]*\.(?:png|jpg|jpeg))/i);
      return match ? match[0] : undefined;
    };

    // Save base64 image data to a file and return the path
    const saveBase64Screenshot = (base64Data: string, forStep: number): string | undefined => {
      try {
        screenshotCounter++;
        const filename = `step-${forStep || screenshotCounter}-${Date.now()}.png`;
        const filePath = path.join(screenshotDir, filename);
        // Strip data URI prefix if present
        const raw = base64Data.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(filePath, Buffer.from(raw, 'base64'));
        return filePath;
      } catch { return undefined; }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text;
            recentText += parsed.delta.text;
            detectStep();
          }
          if (parsed.type === 'result' && parsed.result) {
            const text = typeof parsed.result === 'string'
              ? parsed.result
              : parsed.result.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '';
            if (text) {
              fullText += text;
              resultText = text; // Keep the final result — most reliable source for JSON
            }
          }
          if (parsed.type === 'assistant' && parsed.content) {
            const text = parsed.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
            fullText += text;
            recentText += text;
            detectStep();
          }
          // Detect tool_use events - browser interactions
          if (parsed.type === 'tool_use') {
            const toolName: string = parsed.name || '';
            // If no step detected yet, default to step 1 on first browser tool
            if (currentStepOrder === 0 && (toolName.includes('navigate') || toolName.includes('click') || toolName.includes('type') || toolName.includes('fill'))) {
              currentStepOrder = 1;
              lastReportedStep = 1;
              const step = testCase.steps[0];
              sendQCEvent(getWindow, {
                type: 'step-update',
                sessionId,
                taskId,
                testCaseId: testCase.id,
                stepOrder: 1,
                stepId: step?.id,
                status: 'running',
                message: `Running step 1: ${step?.action || ''}`,
              });
            }
            if (toolName.includes('screenshot')) {
              // Record which step this screenshot was requested for — currentStepOrder may
              // advance before the tool_result arrives, so we snapshot it now.
              screenshotStepQueue.push(currentStepOrder);
              sendQCEvent(getWindow, {
                type: 'screenshot',
                sessionId,
                taskId,
                testCaseId: testCase.id,
                stepOrder: currentStepOrder,
                message: `Step ${currentStepOrder}: Taking screenshot...`,
              });
            }
          }
          // Capture screenshot file paths from tool results
          if (parsed.type === 'tool_result') {
            // Check if this tool_result contains image data (i.e. a screenshot response)
            const hasImage = (Array.isArray(parsed.content) && parsed.content.some((b: any) => b.type === 'image'))
              || (Array.isArray(parsed.result) && parsed.result.some((b: any) => b.type === 'image'));

            // Use the step order recorded at tool_use time (from the queue).
            // This is more reliable than currentStepOrder which may have advanced
            // while the screenshot tool was executing.
            const stepForScreenshot = hasImage && screenshotStepQueue.length > 0
              ? screenshotStepQueue.shift()!
              : currentStepOrder;

            // Extract text from various tool_result formats
            const texts: string[] = [];
            if (typeof parsed.output === 'string') texts.push(parsed.output);
            if (typeof parsed.content === 'string') texts.push(parsed.content);
            if (Array.isArray(parsed.content)) {
              for (const block of parsed.content) {
                if (block.type === 'text' && block.text) texts.push(block.text);
                // Handle base64 image content blocks from Playwright MCP
                if (block.type === 'image' && block.data) {
                  const saved = saveBase64Screenshot(block.data, stepForScreenshot);
                  if (saved && stepForScreenshot > 0) {
                    screenshotPaths.set(stepForScreenshot, saved);
                    sendQCEvent(getWindow, {
                      type: 'screenshot',
                      sessionId,
                      taskId,
                      testCaseId: testCase.id,
                      stepOrder: stepForScreenshot,
                      screenshot: saved,
                      message: `Step ${stepForScreenshot}: Screenshot saved`,
                    });
                  }
                }
              }
            }
            // Also check parsed.result for nested content
            if (parsed.result) {
              if (typeof parsed.result === 'string') texts.push(parsed.result);
              if (Array.isArray(parsed.result)) {
                for (const block of parsed.result) {
                  if (block.type === 'text' && block.text) texts.push(block.text);
                  if (block.type === 'image' && block.data) {
                    const saved = saveBase64Screenshot(block.data, stepForScreenshot);
                    if (saved && stepForScreenshot > 0) {
                      screenshotPaths.set(stepForScreenshot, saved);
                    }
                  }
                }
              }
            }

            const combinedText = texts.join(' ');
            const screenshotPath = extractScreenshotPath(combinedText);
            if (screenshotPath && stepForScreenshot > 0 && !screenshotPaths.has(stepForScreenshot)) {
              screenshotPaths.set(stepForScreenshot, screenshotPath);
              sendQCEvent(getWindow, {
                type: 'screenshot',
                sessionId,
                taskId,
                testCaseId: testCase.id,
                stepOrder: stepForScreenshot,
                screenshot: screenshotPath,
                message: `Step ${stepForScreenshot}: Screenshot captured`,
              });
            }

            // Also check for base64 data URI in text
            const base64Match = combinedText.match(/data:image\/(?:png|jpeg|jpg);base64,[A-Za-z0-9+/=]+/);
            if (base64Match && stepForScreenshot > 0 && !screenshotPaths.has(stepForScreenshot)) {
              const saved = saveBase64Screenshot(base64Match[0], stepForScreenshot);
              if (saved) {
                screenshotPaths.set(stepForScreenshot, saved);
              }
            }
          }
        } catch {
          // ignore
        }
      }
    });

    child.on('close', () => {
      activeProcesses.delete(`${sessionId}:${testCase.id}`);

      // Scan for Playwright MCP screenshots created during this test.
      // Playwright MCP saves screenshots to .playwright-mcp/ in the cwd.
      // We collect all image files created after testStartTime and assign them to steps.
      const collectScreenshotFiles = (): string[] => {
        const files: string[] = [];
        // Check common Playwright MCP screenshot locations
        const searchDirs = [
          path.join(process.cwd(), '.playwright-mcp'),
          path.join(process.env.HOME || process.env.USERPROFILE || '', '.playwright-mcp'),
          screenshotDir,
        ];
        for (const dir of searchDirs) {
          try {
            if (!fs.existsSync(dir)) continue;
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
              if (!/\.(png|jpe?g|webp)$/i.test(entry)) continue;
              const fullPath = path.join(dir, entry);
              try {
                const stat = fs.statSync(fullPath);
                if (stat.mtimeMs >= testStartTime) {
                  files.push(fullPath);
                }
              } catch { /* skip */ }
            }
          } catch { /* dir doesn't exist or not readable */ }
        }
        // Sort by modification time
        files.sort((a, b) => {
          try {
            return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
          } catch { return 0; }
        });
        return files;
      };

      // Collect screenshot files and assign to steps that don't have one yet
      const screenshotFiles = collectScreenshotFiles();
      if (screenshotFiles.length > 0) {
        let fileIdx = 0;
        for (let stepOrder = 1; stepOrder <= testCase.steps.length && fileIdx < screenshotFiles.length; stepOrder++) {
          if (!screenshotPaths.has(stepOrder)) {
            screenshotPaths.set(stepOrder, screenshotFiles[fileIdx]);
            fileIdx++;
          }
        }
      }

      try {
        // Try multiple sources for the JSON result, in order of reliability:
        // 1. The final 'result' payload from Claude CLI (most reliable)
        // 2. The full accumulated text (fallback)
        const candidates = [resultText, fullText].filter(Boolean);

        let result: {
          steps: Array<{ order: number; actual: string; status: string; screenshot?: string }>;
          overallStatus: string;
          summary: string;
          consoleErrors?: string[];
          networkErrors?: string[];
        } | null = null;

        for (const candidate of candidates) {
          if (result) break;
          const trimmed = candidate.trim();

          // Strategy 1: Try parsing the entire trimmed text as JSON
          try { result = JSON.parse(trimmed); } catch { /* not pure JSON */ }
          if (result?.steps && result?.overallStatus) break;
          result = null;

          // Strategy 2: Extract the last JSON object using brace matching
          // Walk backwards through the string to find balanced { ... }
          for (let end = trimmed.length - 1; end >= 0; end--) {
            if (trimmed[end] !== '}') continue;
            let depth = 0;
            let start = -1;
            for (let j = end; j >= 0; j--) {
              if (trimmed[j] === '}') depth++;
              if (trimmed[j] === '{') depth--;
              if (depth === 0) { start = j; break; }
            }
            if (start >= 0) {
              const fragment = trimmed.slice(start, end + 1);
              try {
                const parsed = JSON.parse(fragment);
                if (parsed.steps && parsed.overallStatus) { result = parsed; break; }
              } catch { /* try next closing brace */ }
            }
          }
          if (result) break;

          // Strategy 3: greedy regex first-to-last brace
          const greedyMatch = trimmed.match(/\{[\s\S]*\}/);
          if (greedyMatch) {
            try {
              const parsed = JSON.parse(greedyMatch[0]);
              if (parsed.steps && parsed.overallStatus) result = parsed;
            } catch { /* give up on this candidate */ }
          }
        }

        if (!result || !result.steps || !result.overallStatus) {
          throw new Error(`No valid test result JSON found in output (resultText length: ${resultText.length}, fullText length: ${fullText.length}, last 300 chars: ${(resultText || fullText).slice(-300)})`);
        }

        // Copy screenshots to persistent session directory so they survive cleanup
        for (const [stepOrder, srcPath] of screenshotPaths) {
          // Skip if already in the session screenshot dir
          if (srcPath.startsWith(screenshotDir)) continue;
          try {
            const destPath = path.join(screenshotDir, `step-${stepOrder}-${path.basename(srcPath)}`);
            fs.copyFileSync(srcPath, destPath);
            screenshotPaths.set(stepOrder, destPath);
          } catch { /* non-critical — keep original path */ }
        }

        // Merge results into test case
        const updatedSteps: QCTestStep[] = testCase.steps.map((step) => {
          const resultStep = result.steps.find((rs) => rs.order === step.order);
          if (resultStep) {
            // Prefer captured file path over AI description, fall back to description
            const screenshotFile = screenshotPaths.get(step.order);
            return {
              ...step,
              actual: resultStep.actual,
              status: resultStep.status === 'passed' ? 'passed' as const : 'failed' as const,
              screenshot: screenshotFile || resultStep.screenshot,
            };
          }
          return { ...step, status: 'skipped' as const };
        });

        const tcCompletedAt = new Date().toISOString();
        const updatedTestCase: QCTestCase = {
          ...testCase,
          steps: updatedSteps,
          status: result.overallStatus === 'passed' ? 'passed' : 'failed',
          completedAt: tcCompletedAt,
          durationMs: testCase.startedAt
            ? new Date(tcCompletedAt).getTime() - new Date(testCase.startedAt).getTime()
            : undefined,
          consoleErrors: Array.isArray(result.consoleErrors)
            ? result.consoleErrors.filter((s) => typeof s === 'string' && s.trim()).slice(0, 50)
            : undefined,
          networkErrors: Array.isArray(result.networkErrors)
            ? result.networkErrors.filter((s) => typeof s === 'string' && s.trim()).slice(0, 50)
            : undefined,
        };

        sendQCEvent(getWindow, {
          type: 'test-done',
          sessionId,
          taskId,
          testCaseId: testCase.id,
          status: updatedTestCase.status,
          testCase: updatedTestCase,
          message: result.summary,
        });

        resolve(updatedTestCase);
      } catch (parseErr) {
        console.error('[QC] JSON parse failed:', parseErr instanceof Error ? parseErr.message : parseErr);
        console.error('[QC] resultText length:', resultText.length, 'fullText length:', fullText.length);
        console.error('[QC] resultText last 500:', resultText.slice(-500));
        console.error('[QC] fullText last 500:', fullText.slice(-500));
        console.error('[QC] stderr:', stderrOutput.slice(0, 500));

        // Copy screenshots to persistent dir even on parse failure
        for (const [stepOrder, srcPath] of screenshotPaths) {
          if (srcPath.startsWith(screenshotDir)) continue;
          try {
            const destPath = path.join(screenshotDir, `step-${stepOrder}-${path.basename(srcPath)}`);
            fs.copyFileSync(srcPath, destPath);
            screenshotPaths.set(stepOrder, destPath);
          } catch { /* non-critical */ }
        }

        // If JSON parsing fails, try to extract per-step results from text patterns
        const textToScan = resultText || fullText;
        // Start with steps that have screenshots attached
        let inferredSteps: QCTestStep[] = testCase.steps.map(step => {
          const screenshotFile = screenshotPaths.get(step.order);
          return screenshotFile ? { ...step, screenshot: screenshotFile } : step;
        });
        let inferredStatus: 'passed' | 'failed' | 'error' = 'error';
        let inferredSummary = '';

        // Try to infer step results from text like "Step 1: passed", "Step 2: failed", etc.
        const passedSteps = new Set<number>();
        const failedSteps = new Set<number>();
        for (const m of textToScan.matchAll(/[Ss]tep\s+(\d+)[^]*?(?:status|result)[^:]*:\s*["']?(passed|failed)["']?/gi)) {
          const stepNum = parseInt(m[1], 10);
          if (m[2].toLowerCase() === 'passed') passedSteps.add(stepNum);
          else failedSteps.add(stepNum);
        }
        // Also match simpler patterns like "✅ Step 1" or "❌ Step 2"
        for (const m of textToScan.matchAll(/(?:✅|pass(?:ed)?)\s*[:\-]?\s*[Ss]tep\s+(\d+)/gi)) {
          passedSteps.add(parseInt(m[1], 10));
        }
        for (const m of textToScan.matchAll(/(?:❌|fail(?:ed)?)\s*[:\-]?\s*[Ss]tep\s+(\d+)/gi)) {
          failedSteps.add(parseInt(m[1], 10));
        }

        if (passedSteps.size > 0 || failedSteps.size > 0) {
          inferredSteps = testCase.steps.map((step) => {
            const screenshotFile = screenshotPaths.get(step.order);
            if (passedSteps.has(step.order)) return { ...step, status: 'passed' as const, screenshot: screenshotFile || step.screenshot };
            if (failedSteps.has(step.order)) return { ...step, status: 'failed' as const, screenshot: screenshotFile || step.screenshot };
            return { ...step, screenshot: screenshotFile || step.screenshot };
          });
          inferredStatus = failedSteps.size > 0 ? 'failed' : 'passed';
          inferredSummary = `Inferred: ${passedSteps.size} passed, ${failedSteps.size} failed (JSON parse failed, results extracted from text)`;
        }

        const tcErrCompletedAt = new Date().toISOString();
        const updatedTestCase: QCTestCase = {
          ...testCase,
          steps: inferredSteps,
          status: inferredStatus,
          errorMessage: inferredStatus === 'error'
            ? (fullText.slice(0, 500) || stderrOutput.slice(0, 500) || 'Failed to parse test results')
            : inferredSummary,
          completedAt: tcErrCompletedAt,
          durationMs: testCase.startedAt
            ? new Date(tcErrCompletedAt).getTime() - new Date(testCase.startedAt).getTime()
            : undefined,
        };

        sendQCEvent(getWindow, {
          type: 'test-done',
          sessionId,
          taskId,
          testCaseId: testCase.id,
          status: updatedTestCase.status,
          testCase: updatedTestCase,
          message: inferredStatus !== 'error'
            ? inferredSummary
            : 'Test execution completed but results could not be parsed',
        });

        resolve(updatedTestCase);
      }
    });

    child.on('error', (err) => {
      activeProcesses.delete(`${sessionId}:${testCase.id}`);
      reject(err);
    });

    // 5 minute timeout per test case
    setTimeout(() => {
      killProcessTree(child);
    }, 5 * 60_000);
  });
}

/**
 * Run all test cases in a QC task sequentially.
 */
export async function runAllTests(
  sessionId: string,
  task: QCTask,
  model: InsightsModel,
  getWindow: () => BrowserWindow | null,
): Promise<QCTask> {
  const updatedCases: QCTestCase[] = [];
  abortedSessions.delete(sessionId);

  for (const tc of task.testCases) {
    // Check if abort was requested — stop the loop and mark remaining as pending
    if (abortedSessions.has(sessionId)) {
      // Add remaining test cases as-is (still pending)
      const completedIds = new Set(updatedCases.map(c => c.id));
      for (const remaining of task.testCases) {
        if (!completedIds.has(remaining.id)) {
          updatedCases.push(remaining);
        }
      }
      abortedSessions.delete(sessionId);
      break;
    }

    try {
      const result = await runTestCase(sessionId, task.id, tc, task.targetUrl, task.credentials, model, getWindow);
      updatedCases.push(result);
    } catch (err) {
      // If aborted mid-test, mark as pending (not error) so it can be re-run
      if (abortedSessions.has(sessionId)) {
        updatedCases.push({ ...tc, status: 'pending' });
        const completedIds = new Set(updatedCases.map(c => c.id));
        for (const remaining of task.testCases) {
          if (!completedIds.has(remaining.id)) {
            updatedCases.push(remaining);
          }
        }
        abortedSessions.delete(sessionId);
        break;
      }
      const errAt = new Date().toISOString();
      updatedCases.push({
        ...tc,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
        completedAt: errAt,
        durationMs: tc.startedAt
          ? new Date(errAt).getTime() - new Date(tc.startedAt).getTime()
          : undefined,
      });
    }

    // Persist after each test case so results survive app close
    try {
      const session = await getSession(sessionId);
      if (session?.qcTask) {
        // Merge completed cases with remaining pending ones
        const completedIds = new Set(updatedCases.map(c => c.id));
        session.qcTask.testCases = session.qcTask.testCases.map(existing =>
          completedIds.has(existing.id)
            ? updatedCases.find(c => c.id === existing.id)!
            : existing,
        );
        session.qcTask.updatedAt = new Date().toISOString();
        await saveSession(session);
      }
    } catch {
      // Non-fatal — continue running tests
    }
  }

  const passed = updatedCases.filter((tc) => tc.status === 'passed').length;
  const failed = updatedCases.filter((tc) => tc.status === 'failed').length;
  const errors = updatedCases.filter((tc) => tc.status === 'error').length;

  const completedAt = new Date().toISOString();
  const durationMs = task.startedAt
    ? new Date(completedAt).getTime() - new Date(task.startedAt).getTime()
    : undefined;

  const summary = `Test Results: ${passed} passed, ${failed} failed, ${errors} errors out of ${updatedCases.length} total`;

  sendQCEvent(getWindow, {
    type: 'all-done',
    sessionId,
    taskId: task.id,
    summary,
    message: summary,
  });

  return {
    ...task,
    testCases: updatedCases,
    status: 'completed',
    summary,
    completedAt,
    durationMs,
    updatedAt: new Date().toISOString(),
  };
}

export function abortQC(sessionId: string): void {
  abortedSessions.add(sessionId);
  for (const [key, child] of activeProcesses) {
    if (key.startsWith(sessionId)) {
      killProcessTree(child);
      activeProcesses.delete(key);
    }
  }
}

/** Kill all active QC processes — call on app quit */
export function cleanupAllQC(): void {
  for (const [key, child] of activeProcesses) {
    killProcessTree(child);
    activeProcesses.delete(key);
  }
}
