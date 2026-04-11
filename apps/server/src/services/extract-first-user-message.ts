import { readJsonl } from '../lib/jsonl';
import { shouldSkipPrefixedText } from '../lib/skip-prefixes';

export async function extractFirstUserMessage(
  jsonlPath: string,
): Promise<string> {
  const records = await readJsonl(jsonlPath);

  for (const record of records) {
    if (
      !record ||
      typeof record !== 'object' ||
      !('type' in record) ||
      record.type !== 'user'
    ) {
      continue;
    }

    const message = 'message' in record ? record.message : undefined;
    if (!message || typeof message !== 'object') {
      continue;
    }

    const content = 'content' in message ? message.content : '';
    let text = '';

    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (
          item &&
          typeof item === 'object' &&
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string'
        ) {
          text = item.text;
          break;
        }
      }
    }

    const stripped = text.trim();
    if (!stripped || shouldSkipPrefixedText(stripped)) {
      continue;
    }

    const displayLines: string[] = [];
    for (const line of stripped.split('\n')) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        continue;
      }

      // `/commit` のような単独スラッシュコマンドは除外する。
      if (
        trimmedLine.startsWith('/') &&
        !trimmedLine.includes(' ') &&
        !trimmedLine.slice(1).includes('/')
      ) {
        continue;
      }

      displayLines.push(trimmedLine);
    }

    const result = displayLines.join(' ');
    if (result) {
      return result.slice(0, 120);
    }
  }

  return '';
}
