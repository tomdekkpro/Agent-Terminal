import type { IpcMain } from 'electron';
import { readdir, stat, readFile, writeFile, mkdir, open } from 'fs/promises';
import { join, extname, basename } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { IPC_CHANNELS } from '../../shared/constants';
import type { ProjectSkill } from '../../shared/types';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: string;
  extension?: string;
  children?: FileEntry[];
}

async function listDir(dirPath: string, depth: number = 1): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  try {
    const items = await readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      // Skip hidden files/dirs
      if (item.name.startsWith('.')) continue;
      // Skip node_modules, dist, etc.
      if (item.name === 'node_modules' || item.name === 'dist' || item.name === '__pycache__') continue;

      const fullPath = join(dirPath, item.name);
      const isDir = item.isDirectory();

      const entry: FileEntry = {
        name: item.name,
        path: fullPath,
        isDirectory: isDir,
        extension: isDir ? undefined : extname(item.name).toLowerCase(),
      };

      if (!isDir) {
        try {
          const s = await stat(fullPath);
          entry.size = s.size;
          entry.modifiedAt = s.mtime.toISOString();
        } catch { /* non-critical */ }
      }

      // Pre-load first level of subdirectories for faster UI
      if (isDir && depth > 0) {
        try {
          entry.children = await listDir(fullPath, depth - 1);
        } catch { entry.children = []; }
      }

      entries.push(entry);
    }

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  } catch (error) {
    // Return empty for inaccessible dirs
  }
  return entries;
}

/** Parse frontmatter from a markdown string: --- name: x \n description: y --- */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key && value) result[key] = value;
    }
  }
  return result;
}

/** Read a JSON file, returning undefined rather than throwing. */
async function readJson(path: string): Promise<any | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Enough to hold any realistic frontmatter block. */
const FRONTMATTER_HEAD_BYTES = 16 * 1024;

/**
 * Read just enough of a skill file to parse its frontmatter.
 *
 * Only `name` and `description` are needed to list a skill, but some SKILL.md
 * files are large — the plugin set here totals half a megabyte, with a single
 * 72KB file — and the whole lot was being read on every panel open. Falls back
 * to the full file if the closing delimiter is not in the head, so an unusually
 * long frontmatter block still parses rather than silently losing its
 * description.
 */
async function readFrontmatterHead(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(FRONTMATTER_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_HEAD_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf-8');
    // A complete block needs the opening and closing `---`.
    if (/^---\s*\n[\s\S]*?\n---/.test(head)) return head;
    if (bytesRead < FRONTMATTER_HEAD_BYTES) return head; // whole file already
  } catch {
    /* fall through to the full read */
  } finally {
    await handle?.close().catch(() => {});
  }
  return readFile(path, 'utf-8');
}

/**
 * Scan one skills directory. Supports both layouts Claude Code accepts:
 *   {dir}/{name}.md          - flat file
 *   {dir}/{name}/SKILL.md    - folder with SKILL.md
 *
 * `namespace` prefixes the invoked name for plugin skills (`dp` -> `dp:ship`),
 * matching how Claude Code addresses them.
 */
async function scanSkillsDir(
  skillsDir: string,
  source: 'project' | 'user' | 'plugin',
  namespace?: string,
): Promise<ProjectSkill[]> {
  if (!existsSync(skillsDir)) return [];

  const skills: ProjectSkill[] = [];
  const items = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);

  for (const item of items) {
    try {
      let mdPath: string | null = null;
      let dirName: string;

      if (item.isDirectory()) {
        const candidate = join(skillsDir, item.name, 'SKILL.md');
        if (!existsSync(candidate)) continue; // an empty folder is not a skill
        mdPath = candidate;
        dirName = item.name;
      } else if (item.name.endsWith('.md')) {
        mdPath = join(skillsDir, item.name);
        dirName = basename(item.name, '.md');
      } else {
        continue;
      }

      const fm = parseFrontmatter(await readFrontmatterHead(mdPath));
      // Claude Code addresses a skill by its directory name, so that wins over
      // the frontmatter `name` when the two disagree.
      const bare = dirName || fm.name;
      const invoked = namespace ? `${namespace}:${bare}` : bare;

      skills.push({
        id: `claude-skill:${invoked}`,
        name: invoked,
        description: fm.description || undefined,
        prompt: `/${invoked} `,
        icon: 'FileText',
        color: source === 'plugin' ? '#0ea5e9' : '#8b5cf6',
        source,
        filePath: mdPath,
        ...(namespace ? { pluginName: namespace } : {}),
      });
    } catch { /* skip unreadable files */ }
  }
  return skills;
}

/**
 * Which plugins are enabled for this project.
 *
 * `enabledPlugins` is keyed `<plugin>@<marketplace>`. Project settings win over
 * user settings, and settings.local.json wins over settings.json, so a plugin
 * turned off for one project stays off there.
 */
async function resolveEnabledPlugins(projectPath: string): Promise<Record<string, boolean>> {
  const sources = [
    join(homedir(), '.claude', 'settings.json'),
    join(projectPath, '.claude', 'settings.json'),
    join(projectPath, '.claude', 'settings.local.json'),
  ];
  const merged: Record<string, boolean> = {};
  for (const path of sources) {
    const json = await readJson(path);
    if (json?.enabledPlugins && typeof json.enabledPlugins === 'object') {
      Object.assign(merged, json.enabledPlugins);
    }
  }
  return merged;
}

/**
 * Skills contributed by installed plugins, e.g. `dp:ship`.
 *
 * These are the ones the panel used to miss entirely: a plugin's skills do not
 * live under the project at all, but in the plugin cache
 * (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills), with
 * installed_plugins.json as the index. A plugin is included when it is enabled
 * for this project and installed either for the user or for this project path.
 */
async function loadPluginSkills(projectPath: string): Promise<ProjectSkill[]> {
  const registry = await readJson(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'));
  const plugins = registry?.plugins;
  if (!plugins || typeof plugins !== 'object') return [];

  const enabled = await resolveEnabledPlugins(projectPath);
  // Compare paths separator- and case-insensitively, ignoring trailing slashes.
  const normalize = (p: string) =>
    p.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
  const project = normalize(projectPath);

  const results: ProjectSkill[] = [];
  const seenDirs = new Set<string>();

  for (const [key, installs] of Object.entries(plugins)) {
    if (enabled[key] !== true) continue;              // not enabled here
    const pluginName = key.split('@')[0];
    if (!pluginName || !Array.isArray(installs)) continue;

    for (const install of installs as any[]) {
      const installPath = install?.installPath;
      if (!installPath) continue;

      // A user-scope install is available everywhere. A project-scope install
      // applies to its own path, and to worktrees nested under it.
      if (install.scope === 'project') {
        const owner = normalize(String(install.projectPath || ''));
        if (!owner || !(project === owner || project.startsWith(`${owner}/`) || owner.startsWith(`${project}/`))) {
          continue;
        }
      }

      const skillsDir = join(installPath, 'skills');
      const dedupeKey = normalize(skillsDir);
      if (seenDirs.has(dedupeKey)) continue;  // same version installed twice
      seenDirs.add(dedupeKey);

      results.push(...(await scanSkillsDir(skillsDir, 'plugin', pluginName)));
    }
  }
  return results;
}

/**
 * Every skill available to a project, matching what Claude Code itself would
 * offer: project skills, the user's own skills, and skills from enabled
 * plugins.
 *
 * Previously only `<projectPath>/.claude/skills` was scanned, so plugin skills
 * such as `dp:ship` never appeared even though they were installed and enabled.
 *
 * On a name clash the more specific definition wins - project over user over
 * plugin - which is the precedence Claude Code applies. Plugin skills are
 * namespaced, so they only ever collide with each other.
 */
async function loadClaudeSkills(projectPath: string): Promise<ProjectSkill[]> {
  const [project, user, plugin] = await Promise.all([
    scanSkillsDir(join(projectPath, '.claude', 'skills'), 'project'),
    scanSkillsDir(join(homedir(), '.claude', 'skills'), 'user'),
    loadPluginSkills(projectPath),
  ]);

  const byId = new Map<string, ProjectSkill>();
  // Reverse precedence order: later writes win, so add the weakest first.
  for (const skill of [...plugin, ...user, ...project]) {
    byId.set(skill.id, skill);
  }

  const skills = [...byId.values()];
  skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return skills;
}

export function registerFilesHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    IPC_CHANNELS.FILES_LIST_DIR,
    async (_event, dirPath: string, depth?: number) => {
      try {
        const entries = await listDir(dirPath, depth ?? 1);
        return { success: true, data: entries };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list directory',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_LOAD_CLAUDE_SKILLS,
    async (_event, projectPath: string) => {
      try {
        const skills = await loadClaudeSkills(projectPath);
        return { success: true, data: skills };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to load Claude skills',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_READ_FILE,
    async (_event, filePath: string) => {
      try {
        const content = await readFile(filePath, 'utf-8');
        return { success: true, data: content };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read file',
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_PATH_EXISTS,
    async (_event, targetPath: string) => {
      try {
        if (!targetPath) return { success: true, data: { exists: false, isDirectory: false } };
        const s = await stat(targetPath);
        return { success: true, data: { exists: true, isDirectory: s.isDirectory() } };
      } catch {
        // ENOENT and friends → path simply isn't there
        return { success: true, data: { exists: false, isDirectory: false } };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILES_SAVE_CLAUDE_SKILL,
    async (_event, projectPath: string, skillName: string, content: string) => {
      try {
        const skillsDir = join(projectPath, '.claude', 'skills');

        // Check if flat file layout exists: {name}.md — update in place
        const flatPath = join(skillsDir, `${skillName}.md`);
        if (existsSync(flatPath)) {
          await writeFile(flatPath, content, 'utf-8');
          return { success: true };
        }

        // Default to folder layout: {name}/SKILL.md
        const folderDir = join(skillsDir, skillName);
        await mkdir(folderDir, { recursive: true });
        await writeFile(join(folderDir, 'SKILL.md'), content, 'utf-8');
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save skill',
        };
      }
    },
  );
}
