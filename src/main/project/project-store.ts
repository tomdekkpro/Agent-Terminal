import { app } from 'electron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { v4 as uuid } from 'uuid';
import type { Project, ProjectTabState } from '../../shared/types';
import { debugLog, debugError } from '../../shared/utils';

interface StoreData {
  projects: Project[];
  tabState: ProjectTabState;
}

const STORE_DIR = join(app.getPath('userData'), 'store');
const STORE_FILE = join(STORE_DIR, 'projects.json');

const DEFAULT_TAB_STATE: ProjectTabState = {
  openProjectIds: [],
  activeProjectId: null,
  tabOrder: [],
};

let storeCache: StoreData | null = null;

function loadStore(): StoreData {
  if (storeCache) return storeCache;

  try {
    if (existsSync(STORE_FILE)) {
      const data = JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
      storeCache = {
        projects: data.projects || [],
        tabState: data.tabState || { ...DEFAULT_TAB_STATE },
      };
    } else {
      storeCache = { projects: [], tabState: { ...DEFAULT_TAB_STATE } };
    }
  } catch (error) {
    debugError('[ProjectStore] Failed to load:', error);
    storeCache = { projects: [], tabState: { ...DEFAULT_TAB_STATE } };
  }

  return storeCache;
}

function saveStore(): void {
  try {
    if (!existsSync(STORE_DIR)) {
      mkdirSync(STORE_DIR, { recursive: true });
    }
    writeFileSync(STORE_FILE, JSON.stringify(storeCache, null, 2));
  } catch (error) {
    debugError('[ProjectStore] Failed to save:', error);
  }
}

export function getProjects(): Project[] {
  return loadStore().projects;
}

export function addProject(projectPath: string, name?: string): Project {
  const store = loadStore();

  // Check if project with this path already exists
  const existing = store.projects.find((p) => p.path === projectPath);
  if (existing) return existing;

  const now = new Date().toISOString();
  const project: Project = {
    id: uuid(),
    name: name || basename(projectPath),
    path: projectPath,
    createdAt: now,
    updatedAt: now,
  };

  store.projects.push(project);
  saveStore();
  debugLog('[ProjectStore] Added project:', project.name, project.path);
  return project;
}

export function removeProject(projectId: string): boolean {
  const store = loadStore();
  const idx = store.projects.findIndex((p) => p.id === projectId);
  if (idx === -1) return false;

  store.projects.splice(idx, 1);

  // Clean up tab state
  store.tabState.openProjectIds = store.tabState.openProjectIds.filter((id) => id !== projectId);
  store.tabState.tabOrder = store.tabState.tabOrder.filter((id) => id !== projectId);
  if (store.tabState.activeProjectId === projectId) {
    store.tabState.activeProjectId = store.tabState.openProjectIds[0] || null;
  }

  saveStore();
  return true;
}

export function updateProject(projectId: string, updates: Partial<Pick<Project, 'name' | 'agentProvider' | 'agentModel' | 'agentConfig' | 'skills' | 'devServer'>>): Project | null {
  const store = loadStore();
  const project = store.projects.find((p) => p.id === projectId);
  if (!project) return null;

  if (updates.name) project.name = updates.name;
  if (updates.agentProvider !== undefined) project.agentProvider = updates.agentProvider || undefined;
  if (updates.agentModel !== undefined) project.agentModel = updates.agentModel || undefined;
  if (updates.agentConfig !== undefined) project.agentConfig = updates.agentConfig;
  if (updates.skills !== undefined) project.skills = updates.skills;
  if (updates.devServer !== undefined) project.devServer = updates.devServer;
  project.updatedAt = new Date().toISOString();

  saveStore();
  return project;
}

export function getTabState(): ProjectTabState {
  return loadStore().tabState;
}

export function saveTabState(tabState: ProjectTabState): void {
  const store = loadStore();
  // Filter out IDs of deleted projects
  const validIds = new Set(store.projects.map((p) => p.id));
  store.tabState = {
    openProjectIds: tabState.openProjectIds.filter((id) => validIds.has(id)),
    activeProjectId: tabState.activeProjectId && validIds.has(tabState.activeProjectId) ? tabState.activeProjectId : null,
    tabOrder: tabState.tabOrder.filter((id) => validIds.has(id)),
  };
  saveStore();
}
