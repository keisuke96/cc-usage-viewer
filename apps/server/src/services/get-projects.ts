import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Project } from '@ccuv/shared';

import { getProjectsDir } from '../lib/projects-dir';

function projectDisplayName(projectId: string): string {
  const name = projectId.replace(/^-Users-[^-]+-/, '');
  return `~/${name.replace(/^-+/, '') || projectId}`;
}

async function getOriginalPath(indexPath: string): Promise<string | null> {
  try {
    const content = await readFile(indexPath, 'utf8');
    const parsed = JSON.parse(content) as { originalPath?: unknown };
    return typeof parsed.originalPath === 'string' ? parsed.originalPath : null;
  } catch {
    return null;
  }
}

async function countSessionFiles(projectPath: string): Promise<number> {
  const entries = await readdir(projectPath, { withFileTypes: true });
  return entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith('.jsonl'),
  ).length;
}

export async function getProjects(): Promise<Project[]> {
  const projectsDir = getProjectsDir();

  let entries: Dirent[];
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'memory')
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const projectPath = path.join(projectsDir, entry.name);
        const indexPath = path.join(projectPath, 'sessions-index.json');
        const originalPath = await getOriginalPath(indexPath);
        const sessionCount = await countSessionFiles(projectPath);

        return {
          id: entry.name,
          display_name: originalPath ?? projectDisplayName(entry.name),
          path: projectPath,
          session_count: sessionCount,
        } satisfies Project;
      }),
  );

  return projects;
}
