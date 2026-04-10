import type { IpcMain } from 'electron';
import { readdir, stat, readFile, writeFile, mkdir } from 'fs/promises';
import { join, extname, basename } from 'path';
import { existsSync } from 'fs';
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

/**
 * Scan .claude/skills directory for Claude Code skill files.
 * Supports two layouts:
 *   .claude/skills/{name}.md          — flat file
 *   .claude/skills/{name}/SKILL.md    — folder with SKILL.md
 */
async function loadClaudeSkills(projectPath: string): Promise<ProjectSkill[]> {
  const skillsDir = join(projectPath, '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];

  const skills: ProjectSkill[] = [];
  const items = await readdir(skillsDir, { withFileTypes: true });

  for (const item of items) {
    try {
      let mdPath: string | null = null;
      let skillId: string;

      if (item.isDirectory()) {
        // Folder layout: {name}/SKILL.md
        const candidate = join(skillsDir, item.name, 'SKILL.md');
        if (existsSync(candidate)) {
          mdPath = candidate;
          skillId = `claude-skill:${item.name}`;
        } else {
          continue;
        }
      } else if (item.name.endsWith('.md')) {
        // Flat file layout: {name}.md
        mdPath = join(skillsDir, item.name);
        skillId = `claude-skill:${basename(item.name, '.md')}`;
      } else {
        continue;
      }

      const content = await readFile(mdPath, 'utf-8');
      const fm = parseFrontmatter(content);
      const name = fm.name || basename(item.name, '.md');

      skills.push({
        id: skillId,
        name,
        description: fm.description || undefined,
        prompt: `/${name} `,
        icon: 'FileText',
        color: '#8b5cf6',
      });
    } catch { /* skip unreadable files */ }
  }

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
