import { analyzeResponseSchema } from '@ccuv/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { isSafeJsonlPath } from '../lib/safe-path';
import { analyzeFiles } from '../services/analyze';

// files はカンマ区切りで複数パスを受け付ける
const analyzeQuerySchema = z.object({
  files: z.string().min(1),
});

export const analyzeRoutes: FastifyPluginAsync = async (server) => {
  server.get('/api/analyze', async (request, reply) => {
    const query = analyzeQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400);
      return { error: 'files required' };
    }

    const paths = query.data.files
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!paths.length || paths.some((p) => !isSafeJsonlPath(p))) {
      reply.code(400);
      return { error: 'invalid file' };
    }

    return analyzeResponseSchema.parse(await analyzeFiles(paths));
  });
};
