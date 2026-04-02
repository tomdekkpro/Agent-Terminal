/**
 * System Monitor IPC Handlers
 *
 * Polls CPU, RAM, and GPU usage.
 * CPU/RAM via Node.js os module; GPU via nvidia-smi (NVIDIA) or
 * PowerShell Get-CimInstance (AMD/Intel on Windows).
 * Pushes updates to the renderer every 3 seconds.
 */

import type { IpcMain, BrowserWindow } from 'electron';
import * as os from 'os';
import { execFile } from 'child_process';
import { IPC_CHANNELS } from '../../shared/constants';
import type { SystemMonitorData, GpuInfo } from '../../shared/types';
import { debugError } from '../../shared/utils';

const POLL_INTERVAL = 3_000; // 3 seconds
const GPU_POLL_INTERVAL = 5_000; // GPU is more expensive to query

let pollingInterval: NodeJS.Timeout | null = null;
let previousCpuTimes: { idle: number; total: number }[] | null = null;
let cachedGpuInfo: GpuInfo[] | null = null;
let lastGpuPoll = 0;
let gpuAvailable: boolean | null = null; // null = not checked yet

/** Snapshot current CPU times per core */
function getCpuTimes(): { idle: number; total: number }[] {
  return os.cpus().map((cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    return { idle, total: user + nice + sys + idle + irq };
  });
}

/** Calculate per-core CPU percentages by comparing two snapshots */
function calculateCpuPercent(
  prev: { idle: number; total: number }[],
  curr: { idle: number; total: number }[]
): number[] {
  return curr.map((c, i) => {
    const p = prev[i];
    if (!p) return 0;
    const totalDiff = c.total - p.total;
    const idleDiff = c.idle - p.idle;
    if (totalDiff === 0) return 0;
    return Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
  });
}

/** Run a command and return stdout, or null on failure */
function execCommand(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) {
          resolve(null);
        } else {
          resolve(stdout);
        }
      });
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** Query NVIDIA GPU via nvidia-smi */
async function queryNvidiaGpu(): Promise<GpuInfo[] | null> {
  const output = await execCommand('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  if (!output) return null;

  const gpus: GpuInfo[] = [];
  for (const line of output.trim().split('\n')) {
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 5) continue;
    const memUsed = parseFloat(parts[2]) || 0;
    const memTotal = parseFloat(parts[3]) || 1;
    gpus.push({
      name: parts[0],
      utilization: parseInt(parts[1], 10) || 0,
      memoryUsed: memUsed,
      memoryTotal: memTotal,
      memoryPercent: Math.round((memUsed / memTotal) * 100),
      temperature: parseInt(parts[4], 10) || 0,
    });
  }
  return gpus.length > 0 ? gpus : null;
}

/** Query GPU info — tries nvidia-smi, caches result and availability */
async function getGpuInfo(): Promise<GpuInfo[] | null> {
  const now = Date.now();

  // If we already know GPU is not available, skip
  if (gpuAvailable === false) return cachedGpuInfo;

  // Throttle GPU queries
  if (now - lastGpuPoll < GPU_POLL_INTERVAL && cachedGpuInfo !== null) {
    return cachedGpuInfo;
  }

  lastGpuPoll = now;

  const result = await queryNvidiaGpu();
  if (result) {
    gpuAvailable = true;
    cachedGpuInfo = result;
    return result;
  }

  // Mark as unavailable after first failed check
  if (gpuAvailable === null) {
    gpuAvailable = false;
    debugError('[SystemMonitor] No GPU monitoring available (nvidia-smi not found)');
  }

  return null;
}

/** Collect current system stats */
async function collectStats(): Promise<SystemMonitorData> {
  const cpus = os.cpus();
  const currentTimes = getCpuTimes();

  let corePercents: number[];
  if (previousCpuTimes && previousCpuTimes.length === currentTimes.length) {
    corePercents = calculateCpuPercent(previousCpuTimes, currentTimes);
  } else {
    corePercents = cpus.map(() => 0);
  }
  previousCpuTimes = currentTimes;

  const avgCpu =
    corePercents.length > 0
      ? Math.round(corePercents.reduce((a, b) => a + b, 0) / corePercents.length)
      : 0;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const gpu = await getGpuInfo();

  return {
    cpu: {
      percent: avgCpu,
      cores: cpus.map((cpu, i) => ({
        model: cpu.model,
        speed: cpu.speed,
        percent: corePercents[i] ?? 0,
      })),
      count: cpus.length,
    },
    memory: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    gpu,
    uptime: os.uptime(),
    timestamp: Date.now(),
  };
}

/** Push stats to renderer window */
function pushToRenderer(
  getWindow: () => BrowserWindow | null,
  data: SystemMonitorData
): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.SYSTEM_MONITOR_UPDATED, data);
  }
}

export function registerSystemMonitorHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null
): void {
  // Take initial CPU snapshot so first poll has a diff baseline
  previousCpuTimes = getCpuTimes();

  // Handle on-demand request from renderer
  ipcMain.handle(IPC_CHANNELS.SYSTEM_MONITOR_REQUEST, async () => {
    const data = await collectStats();
    return { success: true, data };
  });

  // Start background polling
  startPolling(getWindow);
}

function startPolling(getWindow: () => BrowserWindow | null): void {
  if (pollingInterval) clearInterval(pollingInterval);

  pollingInterval = setInterval(async () => {
    const data = await collectStats();
    pushToRenderer(getWindow, data);
  }, POLL_INTERVAL);
}

export function stopSystemMonitorPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}
