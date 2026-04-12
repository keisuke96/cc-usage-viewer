import type { AnalyzeResponse, ChatMessage, Session } from '@ccuv/shared';

import { fetchAnalyze, fetchChat } from './api';

export type SessionDocumentSectionKind = 'session' | 'subagent' | 'team';

export type SessionDocumentSection = {
  filePath: string;
  kind: SessionDocumentSectionKind;
  title: string;
  subtitle: string;
};

export type SessionDocumentPlan = {
  filename: string;
  title: string;
  sections: SessionDocumentSection[];
};

export type LoadedSessionDocumentSection = SessionDocumentSection & {
  messages: ChatMessage[];
  analysis: AnalyzeResponse;
};

export type LoadedSessionDocument = {
  filename: string;
  title: string;
  sections: LoadedSessionDocumentSection[];
};

function basenameWithoutJsonl(filePath: string): string {
  return filePath.split('/').at(-1)?.replace(/\.jsonl$/, '') ?? 'session-export';
}

export function sessionDisplayLabel(session: Session): string {
  return session.first_message || session.session_id;
}

export function buildSessionDocumentSections(session: Session): SessionDocumentSection[] {
  return [
    {
      filePath: session.jsonl_path,
      kind: 'session',
      title: 'メインセッション',
      subtitle: session.timestamp ?? session.session_id,
    },
    ...session.subagents.map((subagent) => ({
      filePath: subagent.jsonl_path,
      kind: 'subagent' as const,
      title: subagent.description || subagent.agent_type,
      subtitle: subagent.agent_type,
    })),
    ...session.team_sessions.map((teamSession) => ({
      filePath: teamSession.jsonl_path,
      kind: 'team' as const,
      title: teamSession.description || teamSession.name || teamSession.session_id,
      subtitle: `team · ${teamSession.team_name || teamSession.session_id}`,
    })),
  ];
}

export function resolveSessionDocumentPlan(
  sessions: Session[],
  selectedSessionFile: string,
): SessionDocumentPlan {
  const parent = sessions.find((session) =>
    buildSessionDocumentSections(session).some(
      (section) => section.filePath === selectedSessionFile,
    ),
  );

  if (!parent) {
    const title = basenameWithoutJsonl(selectedSessionFile);
    return {
      filename: `${title}.html`,
      title,
      sections: [
        {
          filePath: selectedSessionFile,
          kind: 'session',
          title,
          subtitle: selectedSessionFile,
        },
      ],
    };
  }

  return {
    filename: `${parent.session_id}.html`,
    title: sessionDisplayLabel(parent),
    sections: buildSessionDocumentSections(parent),
  };
}

export function collectSessionDocumentFilePaths(sessions: Session[]): Set<string> {
  const filePaths = new Set<string>();

  for (const session of sessions) {
    for (const section of buildSessionDocumentSections(session)) {
      filePaths.add(section.filePath);
    }
  }

  return filePaths;
}

export function resolveSessionDocumentSectionLabel(
  sessions: Session[],
  selectedSessionFile: string | null,
): string | null {
  if (!selectedSessionFile) {
    return null;
  }

  for (const session of sessions) {
    const section = buildSessionDocumentSections(session).find(
      (item) => item.filePath === selectedSessionFile,
    );
    if (section) {
      return section.title;
    }
  }

  return null;
}

export async function loadSessionDocument(
  plan: SessionDocumentPlan,
): Promise<LoadedSessionDocument> {
  const sections = await Promise.all(
    plan.sections.map(async (section) => {
      const [messages, analysis] = await Promise.all([
        fetchChat(section.filePath),
        fetchAnalyze([section.filePath]),
      ]);

      return {
        ...section,
        messages,
        analysis,
      };
    }),
  );

  return {
    filename: plan.filename,
    title: plan.title,
    sections,
  };
}
