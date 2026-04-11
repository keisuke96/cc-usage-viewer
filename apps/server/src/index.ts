import { healthResponseSchema } from '@ccuv/shared';
import Fastify from 'fastify';

import { analyzeRoutes } from './routes/analyze';
import { chatRoutes } from './routes/chat';
import { projectsRoutes } from './routes/projects';
import { sessionsRoutes } from './routes/sessions';

const server = Fastify({
  logger: true,
});

await server.register(projectsRoutes);
await server.register(sessionsRoutes);
await server.register(chatRoutes);
await server.register(analyzeRoutes);

server.get('/api/health', async () => {
  return healthResponseSchema.parse({
    ok: true,
    app: 'cc-usage-viewer',
  });
});

const port = Number(process.env.PORT ?? 3000);

try {
  await server.listen({
    host: '127.0.0.1',
    port,
  });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
