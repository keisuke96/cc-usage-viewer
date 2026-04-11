import { projectsResponseSchema } from '@ccuv/shared';
import type { FastifyPluginAsync } from 'fastify';

import { getProjects } from '../services/get-projects';

export const projectsRoutes: FastifyPluginAsync = async (server) => {
  server.get('/api/projects', async () => {
    return projectsResponseSchema.parse(await getProjects());
  });
};
