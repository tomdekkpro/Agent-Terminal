import { join, relative, dirname, basename } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { debugLog } from '../../shared/utils';
import type { DetectedServer, DetectResult } from '../../shared/types';

/**
 * Recursively find files matching a predicate, up to maxDepth.
 */
function findFiles(
  dir: string,
  predicate: (name: string, fullPath: string) => boolean,
  maxDepth: number,
  currentDepth = 0,
): string[] {
  if (currentDepth > maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip common junk directories
      if (entry.isDirectory() && ['node_modules', 'bin', 'obj', 'dist', '.git', '.vs', 'packages'].includes(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isFile() && predicate(entry.name, fullPath)) {
        results.push(fullPath);
      } else if (entry.isDirectory()) {
        results.push(...findFiles(fullPath, predicate, maxDepth, currentDepth + 1));
      }
    }
  } catch {
    // permission errors, etc
  }
  return results;
}

/** Score a .sln file for likelihood of being the main backend solution */
function scoreSolution(slnPath: string): number {
  const name = basename(slnPath, '.sln').toLowerCase();
  let score = 50;

  // Strong indicators in solution name
  if (name.includes('.host') || name.endsWith('host')) score += 40;
  if (name.includes('.api') || name.endsWith('api')) score += 35;
  if (name.includes('.web') && !name.includes('.web.')) score += 25;
  if (name.includes('.server')) score += 25;
  if (name.includes('.be') || name.endsWith('be')) score += 20;

  // Negative — too broad or unrelated
  if (name.includes('.all') || name.endsWith('all')) score -= 15;
  if (name.includes('.test') || name.includes('.tests')) score -= 30;
  if (name.includes('.mobile')) score -= 25;
  if (name.includes('.ui') || name.includes('.angular') || name.includes('.react')) score -= 30;

  return Math.max(0, Math.min(100, score));
}

/**
 * Parse a .sln file and return relative .csproj paths it references.
 */
function parseSolutionProjects(slnPath: string): string[] {
  try {
    const content = readFileSync(slnPath, 'utf-8');
    const projectRegex = /Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]*\.csproj)"/g;
    const results: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = projectRegex.exec(content)) !== null) {
      // .sln uses backslashes on Windows — normalize
      results.push(match[1].replace(/\\/g, '/'));
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Among a list of .csproj paths, find the one most likely to be the runnable web host.
 * Returns the relative csproj path or null.
 */
function findHostProject(slnDir: string, csprojRelPaths: string[]): string | null {
  // Filter to Web SDK projects only
  const webProjects: { rel: string; score: number }[] = [];
  for (const rel of csprojRelPaths) {
    const fullPath = join(slnDir, rel);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      if (!content.includes('Microsoft.NET.Sdk.Web')) continue;

      const name = basename(rel, '.csproj').toLowerCase();
      let score = 50;
      if (name.includes('.web.host') || name.includes('.webhost')) score += 40;
      if (name.includes('.host') && !name.includes('.webhost')) score += 30;
      if (name.includes('.api') || name.endsWith('api')) score += 30;
      if (name.includes('.server')) score += 25;

      // Check for launchSettings.json — strong signal
      const launchSettings = join(dirname(fullPath), 'Properties', 'launchSettings.json');
      if (existsSync(launchSettings)) score += 15;

      webProjects.push({ rel, score });
    } catch { /* skip unreadable */ }
  }

  if (webProjects.length === 0) return null;
  webProjects.sort((a, b) => b.score - a.score);
  return webProjects[0].rel;
}

export function detectDevServers(projectPath: string): DetectResult {
  debugLog('[DevServerDetect] Scanning:', projectPath);
  const result: DetectResult = { frontend: [], backend: [] };

  // ── Frontend detection ───────────────────────────────────────
  // Look for angular.json
  const angularJsonFiles = findFiles(projectPath, (name) => name === 'angular.json', 4);
  for (const ajPath of angularJsonFiles) {
    const dir = dirname(ajPath);
    const rel = relative(projectPath, dir) || '.';
    const hasPkg = existsSync(join(dir, 'package.json'));
    result.frontend.push({
      cmd: hasPkg ? 'npm start' : 'ng serve',
      cwd: rel === '.' ? '' : rel,
      label: `Angular — ${rel || 'root'}`,
      confidence: 85,
    });
  }

  // Fallback: package.json with dev/start script (React/Vue/Vite)
  if (result.frontend.length === 0) {
    const pkgFiles = findFiles(projectPath, (name) => name === 'package.json', 3);
    for (const pkgPath of pkgFiles) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const scripts = pkg.scripts || {};
        if (scripts.dev || scripts.start) {
          const dir = dirname(pkgPath);
          const rel = relative(projectPath, dir) || '.';
          if (rel === '.' && !scripts.start && !scripts.dev) continue;
          result.frontend.push({
            cmd: scripts.dev ? 'npm run dev' : 'npm start',
            cwd: rel === '.' ? '' : rel,
            label: `${pkg.name || 'Node'} — ${rel || 'root'}`,
            confidence: scripts.dev ? 60 : 55,
          });
        }
      } catch { /* ignore */ }
    }
  }

  // ── Backend detection (.sln-driven) ──────────────────────────
  // List ALL .sln files so the user can choose which one to run
  const slnFiles = findFiles(projectPath, (name) => name.endsWith('.sln'), 4);

  const scoredSlns = slnFiles
    .map((slnPath) => ({ path: slnPath, score: scoreSolution(slnPath) }))
    .sort((a, b) => b.score - a.score);

  for (const sln of scoredSlns) {
    const slnDir = dirname(sln.path);
    const slnName = basename(sln.path);
    const csprojRels = parseSolutionProjects(sln.path);

    // Try to find the best web host project inside this solution for the cwd
    const hostRel = findHostProject(slnDir, csprojRels);
    const cwd = hostRel
      ? relative(projectPath, join(slnDir, dirname(hostRel)))
      : relative(projectPath, slnDir);

    result.backend.push({
      cmd: 'dotnet run',
      cwd,
      label: slnName,
      confidence: sln.score,
    });
  }

  debugLog(`[DevServerDetect] Found ${result.frontend.length} frontend, ${result.backend.length} backend candidates`);
  return result;
}
