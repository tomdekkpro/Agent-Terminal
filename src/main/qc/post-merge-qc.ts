import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'fs';
import { dirname, join, resolve } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getSettings } from '../ipc/settings-handlers';
import { ClickUpProvider } from '../ipc/providers/clickup';
import { recordActivity } from '../activity/activity-store';
import { debugLog, debugError } from '../../shared/utils';

// ─── AI QC after a merge ─────────────────────────────────────
// Agent Terminal merges PRs outside any /dp:ship session, so /dp:ship's
// Step 10.6 (QC on demo with /dp:qc-demo-auto) never ran for them and the human
// tester was the first QC on demo. The merge is the trigger now, not the
// developer's session: once the demo deploy of the merge commit is green, set
// the Release version and "ready for testing", then run
// `/dp:qc-demo-auto <task> --unattended`, which posts one report and one round
// comment and hands the task back in "ready for testing" for the human tester.
//
// Always on for every merge Agent Terminal makes, the Merge button included —
// there is no setting to turn it off. A gate that stops it is reported on the
// task as "AI QC not run: <reason>" and leaves the status alone, the same
// contract as the skill's own gates.
//
// Spec: "Unattended" in dekkpro-docs plugins/dp/skills/qc-demo-auto/SKILL.md.

const clickUpProvider = new ClickUpProvider();

const STORE_FILE = join(app.getPath('userData'), 'store', 'post-merge-qc.json');
const LOG_DIR = join(app.getPath('userData'), 'logs', 'post-merge-qc');

const POLL_INTERVAL_MS = 2 * 60_000;
/** How long a merge may go without any demo run appearing before it counts as
 *  "started no demo deploy". GitHub queues push runs within seconds; this only
 *  covers a slow webhook. */
const RUNS_APPEAR_GRACE_MS = 15 * 60_000;
/** Give up on a demo deploy that is still running after this long. */
const MAX_DEPLOY_WAIT_MS = 3 * 60 * 60_000;
/** A whole unattended QC round, every case and the report. */
const QC_RUN_TIMEOUT_MS = 3 * 60 * 60_000;
const GH_TIMEOUT = 120_000;

/** `--unattended` first shipped in dp plugin 0.56.0. */
const MIN_DP_PLUGIN_VERSION = '0.56.0';
const DP_PLUGIN_ID = 'dp@dekkpro';

const STATUS_READY_FOR_TESTING = 'ready for testing';
const STATUS_IN_TESTING = 'in testing';

const FOOTER = '\n\n_Automated by Agent Terminal_';

/** A demo deploy is any workflow whose name ends in `-demo` (angular-demo,
 *  webhost-demo, jobservice-demo, ...). */
const DEMO_WORKFLOW = /-demo$/i;
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required', 'stale']);

type MergedPR = { repo: string | null; prNumber: number; baseBranch?: string; mergeSha?: string };

type PostMergeQcJob = {
  /** ClickUp task id (not the DP2- custom id). */
  taskId: string;
  projectPath: string;
  merges: MergedPR[];
  /** Epoch ms of the latest merge; the deploy clocks run from here. */
  mergedAt: number;
  state: 'waiting' | 'running';
};

let jobs: PostMergeQcJob[] | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let ticking = false;
/** One QC round at a time: they share the demo login and the browser. Set
 *  from the moment a round starts its gates, before the process exists. */
let qcBusy = false;
let activeRun: ChildProcess | null = null;

// ─── Store ───────────────────────────────────────────────────

function load(): PostMergeQcJob[] {
  if (jobs) return jobs;
  try {
    if (existsSync(STORE_FILE)) {
      const raw = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
      if (Array.isArray(raw)) {
        jobs = raw as PostMergeQcJob[];
        return jobs;
      }
    }
  } catch (err) {
    debugError('[PostMergeQC] Failed to load queue:', err);
  }
  jobs = [];
  return jobs;
}

function save(): void {
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(jobs ?? [], null, 2));
  } catch (err) {
    debugError('[PostMergeQC] Failed to persist queue:', err);
  }
}

function removeJob(job: PostMergeQcJob): void {
  jobs = load().filter((j) => j !== job);
  save();
}

// ─── Processes ───────────────────────────────────────────────

function run(cmd: string, args: string[], cwd: string, timeout = GH_TIMEOUT): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf-8', timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const err = error as any;
        err.stderr = stderr;
        reject(err);
      } else {
        resolvePromise(stdout.trim());
      }
    });
  });
}

function errorMessage(err: unknown): string {
  const stderr = (err as any)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().split('\n').slice(-3).join(' ');
  return err instanceof Error ? err.message : String(err);
}

function gh(args: string[], cwd: string): Promise<string> {
  return run('gh', args, cwd);
}

/** Git Bash on Windows, for dp-cu — a bash script. Claude Code needs Git Bash
 *  on Windows too, so it is there wherever this runs. */
function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';
  const candidates: string[] = [];
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  for (const dir of (process.env.PATH || '').split(';').filter(Boolean)) {
    if (existsSync(join(dir, 'git.exe'))) candidates.push(resolve(dir, '..', 'bin', 'bash.exe'));
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe');
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ─── dp plugin ───────────────────────────────────────────────

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The dp plugin Claude Code loads in `projectPath`: a project-scope install
 *  for that path (or one it is nested in) wins over the user-scope one. Asks
 *  `claude plugin list` rather than reading the registry, so it is the same
 *  answer the QC run will get. */
async function resolveDpPlugin(projectPath: string): Promise<{ version: string; installPath: string } | null> {
  const out = await new Promise<string>((resolvePromise, reject) => {
    execFile('claude', ['plugin', 'list', '--json'], {
      cwd: projectPath, encoding: 'utf-8', timeout: GH_TIMEOUT, windowsHide: true, shell: process.platform === 'win32',
    }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
  });
  const normalize = (p: string) => p.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
  const project = normalize(projectPath);
  const installs = (JSON.parse(out) as any[]).filter((p) => p?.id === DP_PLUGIN_ID && p.enabled !== false && p.projectEnabled !== false);
  const forProject = installs.find((p) => {
    if (p.scope !== 'project' || !p.projectPath) return false;
    const owner = normalize(String(p.projectPath));
    return project === owner || project.startsWith(`${owner}/`);
  });
  const chosen = forProject ?? installs.find((p) => p.scope === 'user');
  return chosen?.version && chosen?.installPath ? { version: String(chosen.version), installPath: String(chosen.installPath) } : null;
}

// ─── Demo deploy ─────────────────────────────────────────────

type DeployState =
  | { kind: 'deployed' }
  | { kind: 'pending'; running: string[] }
  | { kind: 'failed'; failed: string[] }
  | { kind: 'not-demo' }
  | { kind: 'none' };

type RunRow = { databaseId: number; workflowName: string; status: string; conclusion: string; headBranch: string; createdAt: string };

function short(sha: string): string {
  return sha.slice(0, 7);
}

function mergeLabel(m: MergedPR): string {
  return `${m.repo ? `${m.repo}` : ''}#${m.prNumber}`;
}

/** The squash commit a merged PR became. */
async function resolveMergeSha(m: MergedPR, cwd: string): Promise<void> {
  if (m.mergeSha) return;
  const repo = m.repo ? ['-R', m.repo] : [];
  const pr = JSON.parse(await gh(['pr', 'view', String(m.prNumber), ...repo, '--json', 'state,mergeCommit,baseRefName'], cwd));
  if (pr.state !== 'MERGED' || !pr.mergeCommit?.oid) {
    throw new Error(`${mergeLabel(m)} is ${String(pr.state).toLowerCase()}, not merged`);
  }
  m.mergeSha = pr.mergeCommit.oid;
  m.baseBranch = m.baseBranch || pr.baseRefName;
}

/**
 * Has the merge commit reached demo? Matched on the commit's own sha: the newest
 * run on the branch straight after a merge is the PREVIOUS one. A cancelled run
 * counts when a later run of the same workflow on the same branch — which
 * carries this commit too — succeeded.
 */
async function deployStateOf(m: MergedPR, cwd: string): Promise<DeployState> {
  const repo = m.repo ? ['-R', m.repo] : [];
  const fields = 'databaseId,workflowName,status,conclusion,headBranch,createdAt';
  const runs: RunRow[] = JSON.parse(await gh(['run', 'list', ...repo, '--commit', m.mergeSha!, '--limit', '50', '--json', fields], cwd));
  const demo = runs.filter((r) => DEMO_WORKFLOW.test(r.workflowName));
  if (demo.length === 0) return { kind: 'none' };

  // A workflow can run more than once on a commit (a re-run); its newest run decides.
  const latest = new Map<string, RunRow>();
  for (const r of demo) {
    const seen = latest.get(r.workflowName);
    if (!seen || Date.parse(r.createdAt) > Date.parse(seen.createdAt)) latest.set(r.workflowName, r);
  }

  const running: string[] = [];
  const failed: string[] = [];
  let succeeded = 0;
  for (const r of latest.values()) {
    const conclusion = String(r.conclusion || '').toLowerCase();
    if (String(r.status).toLowerCase() !== 'completed') {
      running.push(r.workflowName);
    } else if (conclusion === 'success') {
      succeeded++;
    } else if (conclusion === 'cancelled') {
      const later: RunRow[] = JSON.parse(await gh(
        ['run', 'list', ...repo, '--workflow', r.workflowName, '--branch', r.headBranch, '--limit', '10', '--json', fields],
        cwd,
      ));
      const newer = later.filter((x) => Date.parse(x.createdAt) > Date.parse(r.createdAt));
      if (newer.some((x) => String(x.conclusion).toLowerCase() === 'success')) succeeded++;
      else running.push(`${r.workflowName} (cancelled, waiting for a later run)`);
    } else if (FAILED_CONCLUSIONS.has(conclusion)) {
      failed.push(r.workflowName);
    }
    // 'skipped' / 'neutral': the job's DEMO_BRANCH gate said no.
  }
  if (failed.length > 0) return { kind: 'failed', failed };
  if (running.length > 0) return { kind: 'pending', running };
  return succeeded > 0 ? { kind: 'deployed' } : { kind: 'not-demo' };
}

type Decision = { go: true } | { go: false; wait: true } | { go: false; wait: false; reason: string };

async function decide(job: PostMergeQcJob): Promise<Decision> {
  const elapsed = Date.now() - job.mergedAt;
  const states: Array<{ m: MergedPR; state: DeployState }> = [];
  for (const m of job.merges) {
    await resolveMergeSha(m, job.projectPath);
    states.push({ m, state: await deployStateOf(m, job.projectPath) });
  }
  save(); // merge shas resolved

  const failed = states.flatMap(({ m, state }) => (state.kind === 'failed' ? [{ m, names: state.failed }] : []));
  if (failed.length > 0) {
    const what = failed.map(({ m, names }) => `${names.join(', ')} for ${mergeLabel(m)} (${short(m.mergeSha!)})`).join('; ');
    return { go: false, wait: false, reason: `the demo deploy failed — ${what}.` };
  }
  const pending = states.flatMap(({ m, state }) => (state.kind === 'pending' ? [{ m, names: state.running }] : []));
  if (pending.length > 0) {
    if (elapsed < MAX_DEPLOY_WAIT_MS) return { go: false, wait: true };
    const what = pending.map(({ m, names }) => `${names.join(', ')} for ${short(m.mergeSha!)}`).join('; ');
    return { go: false, wait: false, reason: `the demo deploy did not finish within ${MAX_DEPLOY_WAIT_MS / 3_600_000} hours — still running: ${what}.` };
  }
  if (states.some((s) => s.state.kind === 'none') && elapsed < RUNS_APPEAR_GRACE_MS) return { go: false, wait: true };
  // One repo on demo is enough to start: the skill checks every PR of the task
  // itself, and reports one that is not deployed as its own "AI QC not run" or
  // BLOCKED cases.
  if (states.some((s) => s.state.kind === 'deployed')) return { go: true };

  const notDemo = states.filter((s) => s.state.kind === 'not-demo');
  if (notDemo.length > 0) {
    const where = notDemo.map((s) => `${s.m.baseBranch ?? 'its branch'} (${short(s.m.mergeSha!)})`).join(', ');
    return { go: false, wait: false, reason: `the merge did not deploy to demo — the demo workflows on ${where} were skipped, so that branch is not DEMO_BRANCH.` };
  }
  const merges = states.map((s) => `${mergeLabel(s.m)} (${short(s.m.mergeSha!)})`).join(', ');
  return { go: false, wait: false, reason: `no demo deploy ran for ${merges} — nothing to QC on demo yet.` };
}

// ─── Reporting ───────────────────────────────────────────────

async function reportNotRun(job: PostMergeQcJob, reason: string, taskName?: string): Promise<void> {
  debugLog(`[PostMergeQC] Task ${job.taskId}: AI QC not run — ${reason}`);
  await clickUpProvider.postComment(getSettings(), job.taskId, `AI QC not run: ${reason}${FOOTER}`).catch(() => {});
  recordActivity({
    source: 'qc',
    kind: 'post-merge-qc-not-run',
    level: 'warn',
    title: `AI QC not run${taskName ? `: ${taskName}` : ''}`,
    message: reason,
    clickupTaskId: job.taskId,
    taskName,
    projectPath: job.projectPath,
  });
}

// ─── The run ─────────────────────────────────────────────────

async function startQc(job: PostMergeQcJob): Promise<void> {
  const settings = getSettings();
  const task = await clickUpProvider.getTask(settings, job.taskId);
  if (!task.success) {
    // Transient; the next tick tries again.
    debugError(`[PostMergeQC] Couldn't read task ${job.taskId}: ${task.error}`);
    return;
  }
  const taskLabel = task.data.customId || job.taskId;
  const taskName = task.data.name;

  // Gate 1: a dp plugin that knows --unattended. An older one would run the
  // interactive skill with nobody there to answer it.
  let plugin: { version: string; installPath: string } | null;
  try {
    plugin = await resolveDpPlugin(job.projectPath);
  } catch (err) {
    removeJob(job);
    await reportNotRun(job, `couldn't ask Claude Code which dp plugin is installed on the merging machine (${errorMessage(err)}).`, taskName);
    return;
  }
  if (!plugin) {
    removeJob(job);
    await reportNotRun(job, `the dp plugin is not installed for ${job.projectPath} on the merging machine. Install it (dekkpro-docs onboarding/setup.sh --apply).`, taskName);
    return;
  }
  if (compareVersions(plugin.version, MIN_DP_PLUGIN_VERSION) < 0) {
    removeJob(job);
    await reportNotRun(job, `the merging machine has dp plugin ${plugin.version}; --unattended needs ${MIN_DP_PLUGIN_VERSION} or newer. Run \`claude plugin update ${DP_PLUGIN_ID}\` there.`, taskName);
    return;
  }

  // Gate 2: the hand-off fields, as /dp:ship Step 10.6 sets them. The skill
  // refuses a task that is not in "ready for testing".
  const bash = findBash();
  if (!bash) {
    removeJob(job);
    await reportNotRun(job, 'Git Bash was not found on the merging machine, so dp-cu could not set the Release version.', taskName);
    return;
  }
  const dpCu = join(plugin.installPath, 'bin', 'dp-cu').split('\\').join('/');
  try {
    const out = await run(bash, ['-l', dpCu, 'release-version', taskLabel], job.projectPath);
    debugLog(`[PostMergeQC] ${taskLabel}: ${out.split('\n').pop()}`);
  } catch (err) {
    removeJob(job);
    await reportNotRun(job, `couldn't set the Release version with \`dp-cu release-version ${taskLabel}\` (${errorMessage(err)}).`, taskName);
    return;
  }
  const status = await clickUpProvider.updateStatus(settings, job.taskId, STATUS_READY_FOR_TESTING);
  if (!status.success) {
    removeJob(job);
    await reportNotRun(job, `couldn't set the status to "${STATUS_READY_FOR_TESTING}" (${status.error}).`, taskName);
    return;
  }

  // The round itself.
  job.state = 'running';
  save();
  const sessionId = uuidv4();
  const command = `/dp:qc-demo-auto ${taskLabel} --unattended`;
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${taskLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const log = createWriteStream(logPath);
  log.write(`${command}\nsession ${sessionId}\ncwd ${job.projectPath}\ndp plugin ${plugin.version}\n\n`);
  debugLog(`[PostMergeQC] ${taskLabel}: running ${command} (session ${sessionId}, log ${logPath})`);
  recordActivity({
    source: 'qc',
    kind: 'post-merge-qc-started',
    level: 'info',
    title: `AI QC started: ${taskName || taskLabel}`,
    message: `${command} — demo deploy is green.`,
    clickupTaskId: job.taskId,
    taskName,
    projectPath: job.projectPath,
  });

  const outcome = await new Promise<{ code: number | null; error?: string }>((resolvePromise) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn('claude', ['-p', '--output-format', 'text', '--session-id', sessionId, '--dangerously-skip-permissions'], {
      env,
      cwd: job.projectPath,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeRun = child;
    child.stdin?.write(command);
    child.stdin?.end();
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    let settled = false;
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeRun = null;
      resolvePromise({ code, error });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null, `timed out after ${QC_RUN_TIMEOUT_MS / 3_600_000} hours`);
    }, QC_RUN_TIMEOUT_MS);
    child.on('close', (code) => finish(code));
    child.on('error', (err) => finish(null, err.message));
  });
  log.end(`\n\nexit ${outcome.code ?? 'none'}${outcome.error ? ` — ${outcome.error}` : ''}\n`);
  removeJob(job);
  await afterRun(job, taskLabel, taskName, sessionId, outcome);
}

/**
 * The skill moves the task back to "ready for testing" itself. A run that died
 * half way can leave it in "in testing", where the tester's filter never finds
 * it — put it back and say so.
 */
async function afterRun(
  job: PostMergeQcJob,
  taskLabel: string,
  taskName: string | undefined,
  sessionId: string,
  outcome: { code: number | null; error?: string },
): Promise<void> {
  const settings = getSettings();
  const ok = outcome.code === 0 && !outcome.error;
  const after = await clickUpProvider.getTask(settings, job.taskId);
  const statusNow = after.success ? after.data?.status?.name?.toLowerCase() : undefined;
  const stuck = statusNow === STATUS_IN_TESTING;
  if (stuck) await clickUpProvider.updateStatus(settings, job.taskId, STATUS_READY_FOR_TESTING).catch(() => {});

  if (ok && !stuck) {
    recordActivity({
      source: 'qc',
      kind: 'post-merge-qc-done',
      level: 'success',
      title: `AI QC posted: ${taskName || taskLabel}`,
      message: `/dp:qc-demo-auto --unattended finished; the round is on the task, pending QC review.`,
      clickupTaskId: job.taskId,
      taskName,
      projectPath: job.projectPath,
    });
    return;
  }

  const why = outcome.error ?? (ok ? 'it ended with the task still in "in testing"' : `claude exited with code ${outcome.code}`);
  const moved = stuck ? ` The task was left in "${STATUS_IN_TESTING}" and has been moved back to "${STATUS_READY_FOR_TESTING}".` : '';
  await clickUpProvider.postComment(
    settings,
    job.taskId,
    `⚠️ The AI QC run (/dp:qc-demo-auto ${taskLabel} --unattended) did not finish cleanly: ${why}.${moved} Any round it posted above is incomplete; QC starts from the ticket as usual. Session ${sessionId} on the merging machine.${FOOTER}`,
  ).catch(() => {});
  recordActivity({
    source: 'qc',
    kind: 'post-merge-qc-failed',
    level: 'error',
    title: `AI QC run failed: ${taskName || taskLabel}`,
    message: `${why}. Session ${sessionId}.`,
    clickupTaskId: job.taskId,
    taskName,
    projectPath: job.projectPath,
  });
}

// ─── Scheduler ───────────────────────────────────────────────

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const job of [...load()]) {
      if (job.state !== 'waiting') continue;
      let decision: Decision;
      try {
        decision = await decide(job);
      } catch (err) {
        // gh hiccup — try again next tick, unless it has been going on all along.
        debugError(`[PostMergeQC] Deploy check for task ${job.taskId} failed:`, err);
        if (Date.now() - job.mergedAt > MAX_DEPLOY_WAIT_MS) {
          removeJob(job);
          await reportNotRun(job, `couldn't check the demo deploy (${errorMessage(err)}).`);
        }
        continue;
      }
      if (!decision.go) {
        if (!decision.wait) {
          removeJob(job);
          await reportNotRun(job, decision.reason);
        }
        continue;
      }
      if (qcBusy) continue; // deployed, waits its turn
      // Not awaited: a round takes as long as it takes, and the deploy checks
      // of the other jobs carry on meanwhile.
      qcBusy = true;
      void startQc(job)
        .catch((err) => debugError(`[PostMergeQC] QC run for task ${job.taskId} failed:`, err))
        .finally(() => { qcBusy = false; });
    }
  } finally {
    ticking = false;
  }
}

/**
 * Queue the AI QC round for a task whose PRs Agent Terminal just merged. A task
 * already waiting for its deploy takes the new merge into the same round, so a
 * fix merged as wp + customerweb is QC'd once.
 */
export function queuePostMergeQc(taskId: string, projectPath: string, merged: Array<{ repo: string | null; prNumber: number; baseBranch?: string }>): void {
  if (merged.length === 0) return;
  const queue = load();
  let job = queue.find((j) => j.taskId === taskId && j.state === 'waiting');
  if (!job) {
    job = { taskId, projectPath, merges: [], mergedAt: Date.now(), state: 'waiting' };
    queue.push(job);
  }
  for (const m of merged) {
    const known = job.merges.some((x) => x.prNumber === m.prNumber && (x.repo ?? '').toLowerCase() === (m.repo ?? '').toLowerCase());
    if (!known) job.merges.push({ repo: m.repo, prNumber: m.prNumber, baseBranch: m.baseBranch });
  }
  job.mergedAt = Date.now();
  save();
  debugLog(`[PostMergeQC] Task ${taskId}: queued AI QC after merging ${merged.map(mergeLabel).join(', ')}`);
}

/** Load the queue and start polling. A round that was running when Agent
 *  Terminal last closed is reported and its task put back where QC finds it. */
export function startPostMergeQc(): void {
  if (pollTimer) return;
  const queue = load();
  for (const job of queue.filter((j) => j.state === 'running')) {
    removeJob(job);
    void afterRun(job, job.taskId, undefined, 'unknown', { code: null, error: 'Agent Terminal closed while it ran' });
  }
  pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick();
}

export function stopPostMergeQc(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  activeRun?.kill('SIGTERM');
  activeRun = null;
}
