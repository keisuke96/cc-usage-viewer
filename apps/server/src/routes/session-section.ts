import { sessionSectionResponseSchema } from '@ccuv/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { isSafeJsonlPath } from '../lib/safe-path';
import { loadSessionSection } from '../services/session-section';

const sessionSectionQuerySchema = z.object({
  file: z.string().min(1),
});

export const sessionSectionRoutes: FastifyPluginAsync = async (server) => {
  server.get('/api/session-section', async (request, reply) => {
    const query = sessionSectionQuerySchema.safeParse(request.query);
    if (!query.success || !isSafeJsonlPath(query.data.file)) {
      reply.code(400);
      return {
        error: 'invalid file',
      };
    }

    return sessionSectionResponseSchema.parse(
      await loadSessionSection(query.data.file),
    );
  });
};
