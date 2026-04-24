import type { SessionSectionResponse } from '@ccuv/shared';

import { readJsonl } from '../lib/jsonl';
import { analyzeRecords } from './analyze';
import { parseChatRecords } from './parse-chat';

export async function loadSessionSection(
  jsonlPath: string,
): Promise<SessionSectionResponse> {
  const records = await readJsonl(jsonlPath);

  return {
    messages: parseChatRecords(records),
    analysis: await analyzeRecords(records),
  };
}
