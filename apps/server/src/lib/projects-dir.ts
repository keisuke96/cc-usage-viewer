import { homedir } from 'node:os';
import path from 'node:path';

export function getProjectsDir(): string {
  return (
    process.env.CCUV_PROJECTS_DIR ?? path.join(homedir(), '.claude', 'projects')
  );
}
