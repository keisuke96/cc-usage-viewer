import { sessionsResponseSchema } from '@ccuv/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getSessions } from '../services/get-sessions';

const sessionsQuerySchema = z.object({
  project: z
    .string()
    .min(1)
    .refine((value) => !value.includes('..') && !value.includes('/')),
});

export const sessionsRoutes: FastifyPluginAsync = async (server) => {
  server.get('/api/sessions', async (request, reply) => {
    const query = sessionsQuerySchema.safeParse(request.query);
    if (!query.success) {
      reply.code(400);
      return {
        error: 'invalid project',
      };
    }

    return sessionsResponseSchema.parse(await getSessions(query.data.project));
  });
};
