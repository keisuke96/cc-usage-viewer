import {
  type AnalyzeResponse,
  analyzeResponseSchema,
  type ChatMessage,
  chatMessagesResponseSchema,
  type Project,
  projectsResponseSchema,
  type Session,
  sessionsResponseSchema,
} from '@ccuv/shared';

async function requestJson<T>(
  input: string,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const response = await fetch(input);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  return schema.parse(await response.json());
}

export async function fetchProjects(): Promise<Project[]> {
  return requestJson('/api/projects', projectsResponseSchema);
}

export async function fetchSessions(projectId: string): Promise<Session[]> {
  const params = new URLSearchParams({
    project: projectId,
  });

  return requestJson(
    `/api/sessions?${params.toString()}`,
    sessionsResponseSchema,
  );
}

export async function fetchChat(filePath: string): Promise<ChatMessage[]> {
  const params = new URLSearchParams({
    file: filePath,
  });

  return requestJson(
    `/api/chat?${params.toString()}`,
    chatMessagesResponseSchema,
  );
}

export async function fetchAnalyze(
  filePaths: string[],
): Promise<AnalyzeResponse> {
  const params = new URLSearchParams({
    files: filePaths.join(','),
  });

  return requestJson(
    `/api/analyze?${params.toString()}`,
    analyzeResponseSchema,
  );
}
