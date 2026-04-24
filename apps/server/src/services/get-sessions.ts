import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Session, Subagent, TeamSession } from '@ccuv/shared';

import { readJsonl } from '../lib/jsonl';
import { getProjectsDir } from '../lib/projects-dir';
import { shouldSkipPrefixedText } from '../lib/skip-prefixes';
import { extractTeamAgents } from './extract-team-agents';

type SessionIndexEntry = {
  sessionId?: unknown;
  summary?: unknown;
  firstPrompt?: unknown;
  created?: unknown;
  modified?: unknown;
};

type JsonRecord = Record<string, unknown>;

type SessionScanSummary = {
  firstMessage: string;
  requestCount: number;
  isTeamSession: boolean;
  hasTeamCreate: boolean;
};

type CachedSessionScanSummary = SessionScanSummary & {
  mtimeMs: number;
  size: number;
};

const sessionScanCache = new Map<string, CachedSessionScanSummary>();
const teamAgentsCache = new Map<
  string,
  {
    agents: Awaited<ReturnType<typeof extractTeamAgents>>;
    mtimeMs: number;
    size: number;
  }
>();
const BUILTIN_COMMANDS = new Set(['/clear', '/new', '/exit', '/help']);

function isValidProjectId(projectId: string): boolean {
  return (
    Boolean(projectId) && !projectId.includes('..') && !projectId.includes('/')
  );
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  for (const item of content) {
    const contentItem = asRecord(item);
    if (contentItem?.type === 'text' && typeof contentItem.text === 'string') {
      return contentItem.text;
    }
  }

  return '';
}

function formatFirstUserMessage(text: string): string {
  const stripped = text.trim();
  if (!stripped || shouldSkipPrefixedText(stripped)) {
    return '';
  }

  const displayLines: string[] = [];
  for (const line of stripped.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine || BUILTIN_COMMANDS.has(trimmedLine)) {
      continue;
    }

    displayLines.push(trimmedLine);
  }

  return displayLines.join(' ').slice(0, 120);
}

async function scanSessionJsonl(
  jsonlPath: string,
): Promise<SessionScanSummary> {
  const fileStat = await stat(jsonlPath);
  const cached = sessionScanCache.get(jsonlPath);
  if (
    cached &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.size === fileStat.size
  ) {
    const { mtimeMs: _mtimeMs, size: _size, ...summary } = cached;
    return summary;
  }

  const records = await readJsonl(jsonlPath);
  const seenRequestIds = new Set<string>();
  let firstMessage = '';
  let requestCount = 0;
  let isTeamSession = false;
  let hasTeamCreate = false;

  for (const record of records) {
    const object = asRecord(record);
    if (!object) {
      continue;
    }

    const message = asRecord(object.message);
    const content = message?.content;

    if (object.type === 'user') {
      const text = extractTextContent(content);
      if (!firstMessage) {
        firstMessage = formatFirstUserMessage(text);
      }
      if (
        typeof content === 'string' &&
        content.includes('<teammate-message')
      ) {
        isTeamSession = true;
      }
    }

    if (object.type === 'assistant' && message?.usage) {
      const requestId =
        typeof object.requestId === 'string' ? object.requestId : null;
      if (requestId) {
        if (!seenRequestIds.has(requestId)) {
          seenRequestIds.add(requestId);
          requestCount += 1;
        }
      } else {
        requestCount += 1;
      }
    }

    if (!hasTeamCreate && JSON.stringify(record).includes('"TeamCreate"')) {
      hasTeamCreate = true;
    }
  }

  const summary = {
    firstMessage,
    requestCount,
    isTeamSession,
    hasTeamCreate,
  };
  sessionScanCache.set(jsonlPath, {
    ...summary,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  });

  return summary;
}

async function extractTeamAgentsCached(
  jsonlPath: string,
): ReturnType<typeof extractTeamAgents> {
  const fileStat = await stat(jsonlPath);
  const cached = teamAgentsCache.get(jsonlPath);
  if (
    cached &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.size === fileStat.size
  ) {
    return cached.agents;
  }

  const agents = await extractTeamAgents(jsonlPath);
  teamAgentsCache.set(jsonlPath, {
    agents,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  });
  return agents;
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

    subagents.sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );

    return subagents.map(({ timestamp: _timestamp, ...rest }) => rest);
  } catch {
    return [];
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
      const [subagents, scanSummary] = await Promise.all([
        readSubagents(sessionDir),
        scanSessionJsonl(jsonlPath),
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
        firstMessage = scanSummary.firstMessage;
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
        request_count: scanSummary.requestCount,
        subagents,
        team_sessions: [] as TeamSession[],
      } satisfies Session;
    }),
  );

  sessions.sort((left, right) =>
    (right.timestamp ?? '').localeCompare(left.timestamp ?? ''),
  );

  const teamSessionMap = new Map<string, string>();
  const sessionByPath = new Map(
    sessions.map((session) => [session.jsonl_path, session] as const),
  );
  const teamSessionIds = new Set<string>();

  for (const session of sessions) {
    if ((await scanSessionJsonl(session.jsonl_path)).isTeamSession) {
      teamSessionMap.set(session.jsonl_path, session.session_id);
      teamSessionIds.add(session.session_id);
    }
  }

  for (const session of sessions) {
    if (!(await scanSessionJsonl(session.jsonl_path)).hasTeamCreate) {
      continue;
    }

    // TeamCreate を持つセッションは子ではなく親なので teamSessionIds から除外する
    // （<teammate-message も含む場合でも親として扱う）
    teamSessionIds.delete(session.session_id);

    const linkedTeamSessions: TeamSession[] = [];
    const agents = await extractTeamAgentsCached(session.jsonl_path);

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
        subagents: sessionByPath.get(agent.jsonl_path)?.subagents ?? [],
      });
    }

    session.team_sessions = linkedTeamSessions;
  }

  return sessions.filter((session) => !teamSessionIds.has(session.session_id));
}
