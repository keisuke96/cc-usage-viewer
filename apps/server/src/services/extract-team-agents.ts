import { access } from 'node:fs/promises';
import path from 'node:path';

import { readJsonl } from '../lib/jsonl';

type ExtractedAgent = {
  agent_id: string;
  description: string;
  name: string;
  team_name: string;
  jsonl_path: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractAgentId(text: string): string {
  const first = /agentId:\s*(\w+)/.exec(text);
  if (first) {
    return first[1];
  }

  const second = /agent_id:\s*([\w@-]+)/.exec(text);
  return second?.[1] ?? '';
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function buildPeerTeamSessionMap(
  projectDir: string,
  currentSessionPath: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const directory = await import('node:fs/promises').then((fs) =>
    fs.readdir(projectDir, { withFileTypes: true }),
  );

  for (const entry of directory) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const sessionPath = path.join(projectDir, entry.name);
    if (sessionPath === currentSessionPath) {
      continue;
    }

    const records = await readJsonl(sessionPath);
    const firstUser = records.find((record) => {
      const item = asRecord(record);
      return item?.type === 'user';
    });

    const firstUserRecord = asRecord(firstUser);
    const message = asRecord(firstUserRecord?.message);
    const content = message?.content;
    if (typeof content === 'string' && content.includes('<teammate-message')) {
      map.set(sessionPath, content);
    }
  }

  return map;
}

export async function extractTeamAgents(
  sessionFilePath: string,
): Promise<ExtractedAgent[]> {
  const records = await readJsonl(sessionFilePath);
  const toolUseById = new Map<
    string,
    {
      name: string;
      input: Record<string, unknown>;
    }
  >();

  for (const record of records) {
    const object = asRecord(record);
    const message = asRecord(object?.message);
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const item of content) {
      const contentItem = asRecord(item);
      if (contentItem?.type !== 'tool_use') {
        continue;
      }

      const id = asString(contentItem.id);
      if (!id) {
        continue;
      }

      toolUseById.set(id, {
        name: asString(contentItem.name),
        input: asRecord(contentItem.input) ?? {},
      });
    }
  }

  const projectDir = path.dirname(sessionFilePath);
  const sessionDir = sessionFilePath.replace(/\.jsonl$/, '');
  const subagentsDir = path.join(sessionDir, 'subagents');
  const peerTeamSessionMap = await buildPeerTeamSessionMap(
    projectDir,
    sessionFilePath,
  );
  const agents: ExtractedAgent[] = [];

  for (const record of records) {
    const object = asRecord(record);
    const message = asRecord(object?.message);
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const item of content) {
      const contentItem = asRecord(item);
      if (contentItem?.type !== 'tool_result') {
        continue;
      }

      const toolUseId = asString(contentItem.tool_use_id);
      const toolUse = toolUseById.get(toolUseId);
      if (!toolUse || toolUse.name !== 'Agent') {
        continue;
      }

      const input = toolUse.input;
      const rawContent = contentItem.content;
      const resultText = Array.isArray(rawContent)
        ? rawContent
            .map((entry) => {
              const resultItem = asRecord(entry);
              return typeof resultItem?.text === 'string'
                ? resultItem.text
                : '';
            })
            .join('\n')
        : String(rawContent ?? '');

      const agentId = extractAgentId(resultText);
      const teamName = asString(input.team_name);
      let jsonlPath = '';

      if (agentId.includes('@')) {
        const promptKey = asString(input.prompt).slice(0, 40).trim();
        if (promptKey) {
          for (const [peerPath, firstContent] of peerTeamSessionMap.entries()) {
            if (firstContent.includes(promptKey)) {
              jsonlPath = peerPath;
              peerTeamSessionMap.delete(peerPath);
              break;
            }
          }
        }
      } else if (agentId) {
        const candidatePath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
        if (await pathExists(candidatePath)) {
          jsonlPath = candidatePath;
        }
      }

      agents.push({
        agent_id: agentId,
        description: asString(input.description),
        name: asString(input.name),
        team_name: teamName,
        jsonl_path: jsonlPath,
      });
    }
  }

  return agents.filter((agent) => agent.team_name);
}
