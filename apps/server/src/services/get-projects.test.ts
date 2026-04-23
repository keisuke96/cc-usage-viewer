import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getProjects } from './get-projects';

const originalProjectsDir = process.env.CCUV_PROJECTS_DIR;

async function createProject(
  projectsDir: string,
  projectId: string,
  latestTimestamp: string,
): Promise<void> {
  const projectPath = path.join(projectsDir, projectId);

  await mkdir(projectPath, { recursive: true });
  await writeFile(
    path.join(projectPath, 'sessions-index.json'),
    JSON.stringify({
      entries: [{ modified: latestTimestamp }],
    }),
  );
  await writeFile(path.join(projectPath, 'session-1.jsonl'), '{}\n');
}

describe('getProjects', () => {
  let projectsDir: string;

  beforeEach(async () => {
    projectsDir = await mkdtemp(path.join(os.tmpdir(), 'ccuv-projects-'));
    process.env.CCUV_PROJECTS_DIR = projectsDir;
  });

  afterEach(async () => {
    if (originalProjectsDir === undefined) {
      delete process.env.CCUV_PROJECTS_DIR;
    } else {
      process.env.CCUV_PROJECTS_DIR = originalProjectsDir;
    }

    await rm(projectsDir, { recursive: true, force: true });
  });

  it('base project order uses the newest worktree timestamp', async () => {
    await createProject(projectsDir, 'project-a', '2026-04-01T00:00:00.000Z');
    await createProject(
      projectsDir,
      'project-a--claude-worktrees-feature-a',
      '2026-04-20T00:00:00.000Z',
    );
    await createProject(projectsDir, 'project-b', '2026-04-10T00:00:00.000Z');

    const projects = await getProjects();

    expect(projects.map((project) => project.id)).toEqual([
      'project-a',
      'project-b',
    ]);
    expect(projects[0]?.worktrees.map((worktree) => worktree.id)).toEqual([
      'project-a--claude-worktrees-feature-a',
    ]);
  });

  it('worktrees are sorted by newest timestamp first', async () => {
    await createProject(projectsDir, 'project-a', '2026-04-01T00:00:00.000Z');
    await createProject(
      projectsDir,
      'project-a--claude-worktrees-feature-old',
      '2026-04-11T00:00:00.000Z',
    );
    await createProject(
      projectsDir,
      'project-a--claude-worktrees-feature-new',
      '2026-04-21T00:00:00.000Z',
    );

    const projects = await getProjects();

    expect(projects[0]?.worktrees.map((worktree) => worktree.id)).toEqual([
      'project-a--claude-worktrees-feature-new',
      'project-a--claude-worktrees-feature-old',
    ]);
  });
});
