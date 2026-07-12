import type { FastifyInstance } from 'fastify';
import { appConfig } from './config.js';
import { createContext } from './context.js';
import { buildServer } from './server.js';

describe('buildServer', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = await buildServer(createContext(appConfig));
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves liveness and readiness probes', async () => {
    const health = await server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const ready = await server.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
  });

  it('lists every mounted MCP at the discovery root', async () => {
    const res = await server.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mcps: { path: string }[] };
    expect(body.mcps.map(mcp => mcp.path)).toContain('/context-layer');
  });

  it('exposes each registered MCP route (POST mounted, GET → 405)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/context-layer',
    });
    expect(res.statusCode).toBe(405);
  });
});
