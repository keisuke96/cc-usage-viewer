import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { sessionSectionRoutes } from './session-section';

describe('sessionSectionRoutes', () => {
  it('rejects unsafe file paths', async () => {
    const server = Fastify();
    await server.register(sessionSectionRoutes);

    const response = await server.inject({
      method: 'GET',
      url: '/api/session-section?file=/tmp/session.jsonl',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid file' });
  });
});
