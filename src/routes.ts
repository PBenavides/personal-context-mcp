import type { FastifyInstance } from 'fastify';
import { getConnections } from './connections/registry.js';
import { getRegistry } from './registry/registry.js';
import { packageInfo } from './version.js';

/**
 * Registers the management surface: liveness/readiness probes and MCP discovery. The MCP
 * JSON-RPC endpoints are mounted separately as raw routes (see `mountMcp`) and are intentionally
 * not part of this surface. `/health` and `/ready` stay unauthenticated — infra probes them.
 */
export function registerManagementRoutes(server: FastifyInstance): void {
  server.get('/health', () => ({ status: 'ok' }));
  server.get('/ready', async (_request, reply) => {
    const checks = await getConnections().healthCheckAll();
    if (checks.every(check => check.ok)) {
      return { status: 'ready', connections: checks };
    }
    return reply.code(503).send({ status: 'not-ready', connections: checks });
  });
  server.get('/', () => ({
    service: packageInfo().name,
    mcps: getRegistry().map(def => ({
      name: def.name,
      version: def.version,
      path: `/${def.path}`,
    })),
  }));
}
