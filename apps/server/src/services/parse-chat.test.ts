import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseChat } from './parse-chat';

describe('parseChat', () => {
  let tempDir: string;
  let jsonlPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'ccuv-parse-chat-'));
    jsonlPath = path.join(tempDir, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('captures structured file metadata for Read results', async () => {
    await writeFile(
      jsonlPath,
      [
        JSON.stringify({
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-04-23T00:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_read',
                name: 'Read',
                input: {
                  file_path: '/tmp/example.ts',
                },
              },
            ],
          },
        }),
        JSON.stringify({
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-04-23T00:00:01.000Z',
          toolUseResult: {
            type: 'text',
            file: {
              filePath: '/tmp/example.ts',
              content: 'const value = 1;\nconsole.log(value);\n',
              numLines: 2,
              startLine: 5,
              totalLines: 20,
            },
          },
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_read',
                content: '     5→const value = 1;\n     6→console.log(value);',
              },
            ],
          },
        }),
      ].join('\n'),
    );

    const messages = await parseChat(jsonlPath);
    const result = messages[1]?.content[0];

    expect(result).toMatchObject({
      type: 'tool_result',
      is_error: false,
      file: {
        file_path: '/tmp/example.ts',
        content: 'const value = 1;\nconsole.log(value);\n',
        num_lines: 2,
        start_line: 5,
        total_lines: 20,
      },
    });
  });

  it('captures created or updated file content for write-like results', async () => {
    await writeFile(
      jsonlPath,
      [
        JSON.stringify({
          uuid: 'assistant-1',
          type: 'assistant',
          timestamp: '2026-04-23T00:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_write',
                name: 'Write',
                input: {
                  file_path: '/tmp/README.md',
                  content: '# Title\n',
                },
              },
            ],
          },
        }),
        JSON.stringify({
          uuid: 'user-1',
          type: 'user',
          timestamp: '2026-04-23T00:00:01.000Z',
          toolUseResult: {
            type: 'update',
            filePath: '/tmp/README.md',
            content: '# Title\n',
            structuredPatch: [],
            originalFile: '# Old title\n',
          },
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_write',
                content:
                  'The file /tmp/README.md has been updated successfully.',
              },
            ],
          },
        }),
      ].join('\n'),
    );

    const messages = await parseChat(jsonlPath);
    const result = messages[1]?.content[0];

    expect(result).toMatchObject({
      type: 'tool_result',
      is_error: false,
      file: {
        file_path: '/tmp/README.md',
        content: '# Title\n',
        num_lines: 1,
        start_line: 1,
        total_lines: 1,
      },
    });
  });
});
