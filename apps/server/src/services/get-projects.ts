import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Project, WorktreeProject } from '@ccuv/shared';

import { getProjectsDir } from '../lib/projects-dir';

const WORKTREE_MARKER = '--claude-worktrees-';

function isWorktreeProject(projectId: string): boolean {
  return projectId.includes(WORKTREE_MARKER);
}

function getWorktreeBaseId(projectId: string): string {
  return projectId.slice(0, projectId.indexOf(WORKTREE_MARKER));
}

function getWorktreeBranch(projectId: string): string {
  return projectId.slice(projectId.indexOf(WORKTREE_MARKER) + WORKTREE_MARKER.length);
}

function projectDisplayName(projectId: string): string {
  const name = projectId.replace(/^-Users-[^-]+-/, '');
  return `~/${name.replace(/^-+/, '') || projectId}`;
}

type IndexInfo = { originalPath: string | null; latestTimestamp: string | null };

async function readIndexInfo(indexPath: string): Promise<IndexInfo> {
  try {
    const content = await readFile(indexPath, 'utf8');
    const parsed = JSON.parse(content) as { originalPath?: unknown; entries?: unknown };
    const originalPath = typeof parsed.originalPath === 'string' ? parsed.originalPath : null;

    let latestTimestamp: string | null = null;
    if (Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries) {
        if (!entry || typeof entry !== 'object') continue;
        const ts =
          (typeof entry.modified === 'string' && entry.modified) ||
          (typeof entry.created === 'string' && entry.created) ||
          null;
        if (ts && (!latestTimestamp || ts > latestTimestamp)) {
          latestTimestamp = ts;
        }
      }
    }

    return { originalPath, latestTimestamp };
  } catch {
    return { originalPath: null, latestTimestamp: null };
  }
}

async function getLatestJsonlMtime(projectPath: string, entries: Dirent[]): Promise<string | null> {
  const jsonlEntries = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  if (jsonlEntries.length === 0) return null;

  const mtimes = await Promise.all(
    jsonlEntries.map(async (e) => {
      try {
        const s = await stat(path.join(projectPath, e.name));
        return s.mtime.toISOString();
      } catch {
        return null;
      }
    }),
  );

  return mtimes.reduce<string | null>(
    (max, t) => (t && (!max || t > max) ? t : max),
    null,
  );
}

async function countSessionFiles(entries: Dirent[]): Promise<number> {
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).length;
}

export async function getProjects(): Promise<Project[]> {
  const projectsDir = getProjectsDir();

  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const rawProjects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'memory')
      .map(async (entry) => {
        const projectPath = path.join(projectsDir, entry.name);
        const indexPath = path.join(projectPath, 'sessions-index.json');
        const dirEntries = await readdir(projectPath, { withFileTypes: true });
        const [{ originalPath, latestTimestamp: indexTimestamp }, sessionCount] =
          await Promise.all([readIndexInfo(indexPath), countSessionFiles(dirEntries)]);

        const latestTimestamp =
          indexTimestamp ?? (await getLatestJsonlMtime(projectPath, dirEntries));

        return {
          id: entry.name,
          display_name: originalPath ?? projectDisplayName(entry.name),
          path: projectPath,
          session_count: sessionCount,
          latestTimestamp,
        };
      }),
  );

  rawProjects.sort((left, right) => {
    const l = left.latestTimestamp ?? '';
    const r = right.latestTimestamp ?? '';
    if (r !== l) return r.localeCompare(l);
    return left.id.localeCompare(right.id);
  });

  // Separate worktrees from base projects
  const worktreeRaws = rawProjects.filter((p) => isWorktreeProject(p.id));
  const baseRaws = rawProjects.filter((p) => !isWorktreeProject(p.id));

  // Build a map for quick lookup
  const baseMap = new Map(baseRaws.map((p) => [p.id, p]));

  // Attach worktrees to their base projects
  const worktreesByBase = new Map<string, WorktreeProject[]>();
  const orphanWorktrees: WorktreeProject[] = [];

  for (const wt of worktreeRaws) {
    const baseId = getWorktreeBaseId(wt.id);
    const branch = getWorktreeBranch(wt.id);
    const worktree: WorktreeProject = {
      id: wt.id,
      display_name: branch,
      path: wt.path,
      session_count: wt.session_count,
    };

    if (baseMap.has(baseId)) {
      const list = worktreesByBase.get(baseId) ?? [];
      list.push(worktree);
      worktreesByBase.set(baseId, list);
    } else {
      // Base project not found — show as orphan worktree at top level
      orphanWorktrees.push(worktree);
    }
  }

  // Build final project list
  const projects: Project[] = baseRaws.map(({ latestTimestamp: _lt, ...p }) => ({
    ...p,
    worktrees: worktreesByBase.get(p.id) ?? [],
  }));

  // Append orphan worktrees as standalone projects (no further nesting)
  for (const orphan of orphanWorktrees) {
    projects.push({
      id: orphan.id,
      display_name: orphan.display_name,
      path: orphan.path,
      session_count: orphan.session_count,
      worktrees: [],
    });
  }

  return projects;
}
