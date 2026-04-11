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

function parseContentItem(contentItem: JsonRecord): ChatContentItem | null {
  const contentType =
    typeof contentItem.type === 'string' ? contentItem.type : '';

  if (contentType === 'text') {
    const text =
      typeof contentItem.text === 'string' ? contentItem.text.trim() : '';
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
    };
  }

  return null;
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
      text,
    },
  ];
}

function compareMessages(left: ChatMessage, right: ChatMessage): number {
  return (left.timestamp ?? '').localeCompare(right.timestamp ?? '');
}

export async function parseChat(jsonlPath: string): Promise<ChatMessage[]> {
  const records = await readJsonl(jsonlPath);
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
          return item ? parseContentItem(item) : null;
        })
        .filter((entry): entry is ChatContentItem => entry !== null);
    }

    if (!parsedContent.length) {
      continue;
    }

    messages.push({
      role,
      content: parsedContent,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
      model: typeof message.model === 'string' ? message.model : null,
    });
  }

  return messages.sort(compareMessages);
}
