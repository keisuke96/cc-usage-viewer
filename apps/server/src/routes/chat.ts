import { chatMessagesResponseSchema } from '@ccuv/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { isSafeJsonlPath } from '../lib/safe-path';
import { parseChat } from '../services/parse-chat';

const chatQuerySchema = z.object({
  file: z.string().min(1),
});

export const chatRoutes: FastifyPluginAsync = async (server) => {
  server.get('/api/chat', async (request, reply) => {
    const query = chatQuerySchema.safeParse(request.query);
    if (!query.success || !isSafeJsonlPath(query.data.file)) {
      reply.code(400);
      return {
        error: 'invalid file',
      };
    }

    return chatMessagesResponseSchema.parse(await parseChat(query.data.file));
  });
};
