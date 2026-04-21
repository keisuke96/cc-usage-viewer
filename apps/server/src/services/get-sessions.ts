import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Session, Subagent, TeamSession } from '@ccuv/shared';

import { getProjectsDir } from '../lib/projects-dir';
import { extractFirstUserMessage } from './extract-first-user-message';
import { extractTeamAgents } from './extract-team-agents';

type SessionIndexEntry = {
  sessionId?: unknown;
  summary?: unknown;
  firstPrompt?: unknown;
  created?: unknown;
  modified?: unknown;
};

function isValidProjectId(projectId: string): boolean {
  return (
    Boolean(projectId) && !projectId.includes('..') && !projectId.includes('/')
  );
}

async function readSessionIndex(
  projectPath: string,
): Promise<Map<string, SessionIndexEntry>> {
  const indexPath = path.join(projectPath, 'sessions-index.json');

  try {
    const content = await readFile(indexPath, 'utf8');
    const parsed = JSON.parse(content) as { entries?: unknown };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const map = new Map<string, SessionIndexEntry>();

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const sessionId =
        'sessionId' in entry && typeof entry.sessionId === 'string'
          ? entry.sessionId
          : '';
      if (sessionId) {
        map.set(sessionId, entry as SessionIndexEntry);
      }
    }

    return map;
  } catch {
    return new Map();
  }
}

async function readFirstTimestamp(jsonlPath: string): Promise<string> {
  try {
    const content = await readFile(jsonlPath, 'utf8');
    const firstLine = content.slice(0, content.indexOf('\n'));
    const obj = JSON.parse(firstLine) as { timestamp?: unknown };
    return typeof obj.timestamp === 'string' ? obj.timestamp : '';
  } catch {
    return '';
  }
}

async function readSubagents(sessionDir: string): Promise<Subagent[]> {
  const subagentsDir = path.join(sessionDir, 'subagents');

  try {
    const entries = await readdir(subagentsDir, { withFileTypes: true });
    const agentFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl'),
    );

    const subagents = await Promise.all(
      agentFiles.map(async (entry) => {
        const agentFilePath = path.join(subagentsDir, entry.name);
        const metaPath = agentFilePath.replace(/\.jsonl$/, '.meta.json');
        let agentType = 'general-purpose';
        let description = '';

        try {
          const content = await readFile(metaPath, 'utf8');
          const meta = JSON.parse(content) as {
            agentType?: unknown;
            description?: unknown;
          };
          agentType =
            typeof meta.agentType === 'string' ? meta.agentType : agentType;
          description =
            typeof meta.description === 'string'
              ? meta.description
              : description;
        } catch {
          // metadata は任意ファイルなので無視する
        }

        const timestamp = await readFirstTimestamp(agentFilePath);

        return {
          agent_id: entry.name.replace(/\.jsonl$/, ''),
          jsonl_path: agentFilePath,
          agent_type: agentType,
          description,
          timestamp,
        };
      }),
    );

    subagents.sort((left, right) => left.timestamp.localeCompare(right.timestamp));

    return subagents.map(({ timestamp: _timestamp, ...rest }) => rest);
  } catch {
    return [];
  }
}

async function countRequests(jsonlPath: string): Promise<number> {
  try {
    const content = await readFile(jsonlPath, 'utf8');
    const seen = new Set<string>();
    let count = 0;
    for (const line of content.split('\n')) {
      if (!line.trim() || !line.includes('"type":"assistant"')) continue;
      try {
        const obj = JSON.parse(line) as {
          type?: unknown;
          requestId?: unknown;
          message?: { usage?: unknown };
        };
        if (obj.type !== 'assistant' || !obj.message?.usage) continue;
        const rid = typeof obj.requestId === 'string' ? obj.requestId : null;
        if (rid) {
          if (seen.has(rid)) continue;
          seen.add(rid);
        }
        count++;
      } catch {
        // ignore
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function checkTeamSession(jsonlPath: string): Promise<boolean> {
  try {
    const content = await readFile(jsonlPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.includes('"type":"user"')) continue;
      try {
        const obj = JSON.parse(line) as {
          type?: unknown;
          message?: { content?: unknown };
        };
        if (obj.type !== 'user') continue;
        const msgContent = obj.message?.content;
        return typeof msgContent === 'string' && msgContent.includes('<teammate-message');
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function hasTeamCreate(jsonlPath: string): Promise<boolean> {
  try {
    const content = await readFile(jsonlPath, 'utf8');
    return content.includes('"TeamCreate"');
  } catch {
    return false;
  }
}

function toNullableTimestamp(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export async function getSessions(projectId: string): Promise<Session[]> {
  if (!isValidProjectId(projectId)) {
    return [];
  }

  const projectPath = path.join(getProjectsDir(), projectId);
  const indexById = await readSessionIndex(projectPath);

  let entries: Dirent[];
  try {
    entries = await readdir(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const jsonlEntries = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .sort((left, right) => left.name.localeCompare(right.name));

  const sessions = await Promise.all(
    jsonlEntries.map(async (entry) => {
      const jsonlPath = path.join(projectPath, entry.name);
      const sessionId = entry.name.replace(/\.jsonl$/, '');
      const sessionDir = path.join(projectPath, sessionId);
      const [subagents, requestCount] = await Promise.all([
        readSubagents(sessionDir),
        countRequests(jsonlPath),
      ]);
      const indexEntry = indexById.get(sessionId);

      let firstMessage = '';
      let timestamp: string | null = null;

      if (indexEntry) {
        firstMessage =
          (typeof indexEntry.summary === 'string' && indexEntry.summary) ||
          (typeof indexEntry.firstPrompt === 'string' &&
            indexEntry.firstPrompt) ||
          '';
        timestamp =
          toNullableTimestamp(indexEntry.created) ??
          toNullableTimestamp(indexEntry.modified);
      } else {
        firstMessage = await extractFirstUserMessage(jsonlPath);
        try {
          const fileStat = await stat(jsonlPath);
          timestamp = fileStat.mtime.toISOString();
        } catch {
          timestamp = null;
        }
      }

      return {
        session_id: sessionId,
        jsonl_path: jsonlPath,
        timestamp,
        first_message: firstMessage,
        request_count: requestCount,
        subagents,
        team_sessions: [] as TeamSession[],
      } satisfies Session;
    }),
  );

  sessions.sort((left, right) =>
    (right.timestamp ?? '').localeCompare(left.timestamp ?? ''),
  );

  const teamSessionMap = new Map<string, string>();
  const teamSessionIds = new Set<string>();

  for (const session of sessions) {
    if (await checkTeamSession(session.jsonl_path)) {
      teamSessionMap.set(session.jsonl_path, session.session_id);
      teamSessionIds.add(session.session_id);
    }
  }

  for (const session of sessions) {
    if (!(await hasTeamCreate(session.jsonl_path))) {
      continue;
    }

    // TeamCreate を持つセッションは子ではなく親なので teamSessionIds から除外する
    // （<teammate-message も含む場合でも親として扱う）
    teamSessionIds.delete(session.session_id);

    const linkedTeamSessions: TeamSession[] = [];
    const agents = await extractTeamAgents(session.jsonl_path);

    for (const agent of agents) {
      if (!agent.jsonl_path) {
        continue;
      }

      const linkedSessionId = teamSessionMap.get(agent.jsonl_path);
      if (!linkedSessionId) {
        continue;
      }

      linkedTeamSessions.push({
        session_id: linkedSessionId,
        jsonl_path: agent.jsonl_path,
        description: agent.description,
        name: agent.name,
        team_name: agent.team_name,
      });
    }

    session.team_sessions = linkedTeamSessions;
  }

  return sessions.filter((session) => !teamSessionIds.has(session.session_id));
}
