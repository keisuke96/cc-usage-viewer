import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getSessions } from './get-sessions';

const originalProjectsDir = process.env.CCUV_PROJECTS_DIR;

function assistantUsageLine(requestId: string) {
  return JSON.stringify({
    uuid: `assistant-${requestId}`,
    type: 'assistant',
    requestId,
    timestamp: '2026-04-23T00:00:01.000Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: 1,
        output_tokens: 2,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

function userLine(uuid: string, content: string) {
  return JSON.stringify({
    uuid,
    type: 'user',
    timestamp: '2026-04-23T00:00:00.000Z',
    message: {
      role: 'user',
      content,
    },
  });
}

describe('getSessions', () => {
  let projectsDir: string;
  let projectPath: string;

  beforeEach(async () => {
    projectsDir = await mkdtemp(path.join(os.tmpdir(), 'ccuv-sessions-'));
    process.env.CCUV_PROJECTS_DIR = projectsDir;
    projectPath = path.join(projectsDir, 'project-a');
    await mkdir(projectPath, { recursive: true });
  });

  afterEach(async () => {
    if (originalProjectsDir === undefined) {
      delete process.env.CCUV_PROJECTS_DIR;
    } else {
      process.env.CCUV_PROJECTS_DIR = originalProjectsDir;
    }

    await rm(projectsDir, { recursive: true, force: true });
  });

  it('scans request count and fallback first message in one session summary', async () => {
    await writeFile(
      path.join(projectPath, 'session-1.jsonl'),
      [
        userLine('user-1', '最初の依頼です\n詳細'),
        assistantUsageLine('req-1'),
        assistantUsageLine('req-1'),
        assistantUsageLine('req-2'),
      ].join('\n'),
    );

    const sessions = await getSessions('project-a');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: 'session-1',
      first_message: '最初の依頼です 詳細',
      request_count: 2,
    });
  });

  it('invalidates the in-memory scan cache when file size changes', async () => {
    const jsonlPath = path.join(projectPath, 'session-1.jsonl');
    await writeFile(
      jsonlPath,
      [userLine('user-1', 'cache test'), assistantUsageLine('req-1')].join(
        '\n',
      ),
    );

    expect((await getSessions('project-a'))[0]?.request_count).toBe(1);

    await writeFile(
      jsonlPath,
      [
        userLine('user-1', 'cache test'),
        assistantUsageLine('req-1'),
        assistantUsageLine('req-2'),
      ].join('\n'),
    );

    expect((await getSessions('project-a'))[0]?.request_count).toBe(2);
  });

  it('filters team child sessions when a parent session has TeamCreate', async () => {
    await writeFile(
      path.join(projectPath, 'parent.jsonl'),
      [
        userLine('parent-user', 'parent'),
        JSON.stringify({
          uuid: 'parent-assistant',
          type: 'assistant',
          timestamp: '2026-04-23T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-team',
                name: 'TeamCreate',
                input: {},
              },
            ],
          },
        }),
      ].join('\n'),
    );
    await writeFile(
      path.join(projectPath, 'child.jsonl'),
      [
        userLine('child-user', '<teammate-message>child</teammate-message>'),
      ].join('\n'),
    );

    const sessions = await getSessions('project-a');

    expect(sessions.map((session) => session.session_id)).toEqual(['parent']);
  });
});
