import path from 'node:path';

import { getProjectsDir } from './projects-dir';

export function isSafeJsonlPath(filePath: string): boolean {
  const realPath = path.resolve(filePath);
  const realProjectsDir = path.resolve(getProjectsDir());

  return realPath.startsWith(realProjectsDir) && realPath.endsWith('.jsonl');
}
