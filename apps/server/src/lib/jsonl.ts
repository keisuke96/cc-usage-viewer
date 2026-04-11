import { createReadStream } from 'node:fs';
import readline from 'node:readline';

export async function readJsonl(path: string): Promise<unknown[]> {
  const records: unknown[] = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  try {
    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // 壊れた行はスキップする。
      }
    }
  } finally {
    reader.close();
  }

  return records;
}
