import type { ChatContentItem, ChatMessage } from '@ccuv/shared';

import { readJsonl } from '../lib/jsonl';
import { shouldSkipPrefixedText } from '../lib/skip-prefixes';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countContentLines(text: string): number {
  if (!text) {
    return 0;
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines.length;
}

function parseToolResultFile(
  record: JsonRecord | undefined,
): Extract<ChatContentItem, { type: 'tool_result' }>['file'] {
  const toolUseResult = asRecord(record?.toolUseResult);
  const fileResult = asRecord(toolUseResult?.file);
  const readFilePath =
    typeof fileResult?.filePath === 'string' ? fileResult.filePath : null;
  const readFileContent =
    typeof fileResult?.content === 'string' ? fileResult.content : null;

  if (fileResult && readFilePath && readFileContent !== null) {
    const numLines =
      asNumber(fileResult.numLines) ?? countContentLines(readFileContent);
    const startLine = asNumber(fileResult.startLine) ?? 1;
    const totalLines = asNumber(fileResult.totalLines) ?? numLines;

    return {
      file_path: readFilePath,
      content: readFileContent,
      num_lines: numLines,
      start_line: startLine,
      total_lines: totalLines,
    };
  }

  const resultType =
    typeof toolUseResult?.type === 'string' ? toolUseResult.type : '';
  const writeFilePath =
    typeof toolUseResult?.filePath === 'string' ? toolUseResult.filePath : null;
  const writeFileContent =
    typeof toolUseResult?.content === 'string' ? toolUseResult.content : null;

  if (
    (resultType === 'create' || resultType === 'update') &&
    writeFilePath &&
    writeFileContent !== null
  ) {
    const lineCount = countContentLines(writeFileContent);

    return {
      file_path: writeFilePath,
      content: writeFileContent,
      num_lines: lineCount,
      start_line: 1,
      total_lines: lineCount,
    };
  }

  return undefined;
}

function parseContentItem(
  contentItem: JsonRecord,
  record?: JsonRecord,
): ChatContentItem | null {
  const contentType =
    typeof contentItem.type === 'string' ? contentItem.type : '';

  if (contentType === 'text') {
    const raw =
      typeof contentItem.text === 'string' ? contentItem.text.trim() : '';
    const text = transformBashTags(raw);
    return text ? { type: 'text', text } : null;
  }

  if (contentType === 'thinking') {
    const text =
      typeof contentItem.thinking === 'string'
        ? contentItem.thinking.trim()
        : '';
    return text ? { type: 'thinking', text } : null;
  }

  if (contentType === 'tool_use') {
    return {
      type: 'tool_use',
      tool_name: typeof contentItem.name === 'string' ? contentItem.name : '',
      input:
        contentItem.input && typeof contentItem.input === 'object'
          ? (contentItem.input as Record<string, unknown>)
          : {},
    };
  }

  if (contentType === 'tool_result') {
    const rawContent = contentItem.content;
    const content = Array.isArray(rawContent)
      ? rawContent
          .map((entry) => {
            const item = asRecord(entry);
            return typeof item?.text === 'string' ? item.text : '';
          })
          .join('\n')
      : String(rawContent ?? '');

    return {
      type: 'tool_result',
      content,
      is_error: Boolean(contentItem.is_error),
      file: parseToolResultFile(record),
    };
  }

  if (contentType === 'server_tool_use' && contentItem.name === 'advisor') {
    return { type: 'advisor_call' };
  }

  if (contentType === 'advisor_tool_result') {
    const inner = asRecord(contentItem.content);
    const innerType = typeof inner?.type === 'string' ? inner.type : '';
    const text =
      innerType === 'advisor_result' && typeof inner?.text === 'string'
        ? inner.text
        : null;
    return { type: 'advisor_result', text };
  }

  return null;
}

function transformBashTags(text: string): string {
  return text
    .replace(
      /<bash-input>(.*?)<\/bash-input>/gs,
      (_, cmd: string) => `\`! ${cmd.trim()}\``,
    )
    .replace(/<bash-stdout>(.*?)<\/bash-stdout>/gs, (_, out: string) => {
      const trimmed = out.trim();
      return trimmed ? `\`\`\`bash\n${trimmed}\n\`\`\`` : '';
    })
    .replace(/<bash-stderr>(.*?)<\/bash-stderr>/gs, (_, err: string) => {
      const trimmed = err.trim();
      return trimmed ? `\`\`\`bash\n${trimmed}\n\`\`\`` : '';
    });
}

function parseStringContent(content: string): ChatContentItem[] {
  const text = content.trim();
  if (!text || shouldSkipPrefixedText(text)) {
    return [];
  }

  const match = /<local-command-stdout>(.*?)<\/local-command-stdout>/s.exec(
    text,
  );
  if (match) {
    return [
      {
        type: 'tool_result',
        content: match[1].trim(),
        is_error: false,
      },
    ];
  }

  return [
    {
      type: 'text',
      text: transformBashTags(text),
    },
  ];
}

function compareMessages(left: ChatMessage, right: ChatMessage): number {
  return (left.timestamp ?? '').localeCompare(right.timestamp ?? '');
}

export async function parseChat(jsonlPath: string): Promise<ChatMessage[]> {
  return parseChatRecords(await readJsonl(jsonlPath));
}

export function parseChatRecords(records: unknown[]): ChatMessage[] {
  const byUuid = new Map<string, JsonRecord>();
  const uuidOrder: string[] = [];

  for (const record of records) {
    const item = asRecord(record);
    if (!item) {
      continue;
    }

    const uuid = typeof item?.uuid === 'string' ? item.uuid : '';
    if (!uuid) {
      continue;
    }

    if (!byUuid.has(uuid)) {
      uuidOrder.push(uuid);
    }

    byUuid.set(uuid, item);
  }

  const messages: ChatMessage[] = [];

  for (const uuid of uuidOrder) {
    const record = byUuid.get(uuid);
    if (!record) {
      continue;
    }

    const messageType = typeof record.type === 'string' ? record.type : '';
    const message = asRecord(record.message);
    if (!message) {
      continue;
    }

    const role = typeof message?.role === 'string' ? message.role : '';

    if (
      (messageType !== 'user' && messageType !== 'assistant') ||
      (role !== 'user' && role !== 'assistant')
    ) {
      continue;
    }

    const content = message.content;
    let parsedContent: ChatContentItem[] = [];

    if (typeof content === 'string') {
      parsedContent = parseStringContent(content);
    } else if (Array.isArray(content)) {
      parsedContent = content
        .map((entry) => {
          const item = asRecord(entry);
          return item ? parseContentItem(item, record) : null;
        })
        .filter((entry): entry is ChatContentItem => entry !== null);
    }

    if (!parsedContent.length) {
      continue;
    }

    messages.push({
      uuid,
      role,
      content: parsedContent,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
      model: typeof message.model === 'string' ? message.model : null,
    });
  }

  return messages.sort(compareMessages);
}
