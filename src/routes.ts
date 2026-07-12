import type { FastifyInstance } from 'fastify';
import { getRegistry } from './registry/registry.js';

/**
 * Registers the management surface: liveness/readiness probes and MCP discovery. The MCP
 * JSON-RPC endpoints are mounted separately as raw routes (see `mountMcp`) and are intentionally
 * not part of this surface.
 */
export function registerManagementRoutes(server: FastifyInstance): void {
  server.get('/health', () => ({ status: 'ok' }));
  server.get('/ready', () => ({ status: 'ready' }));
  server.get('/', () => ({
    service: '@taxfix/mcp-server',
    mcps: getRegistry().map(def => ({
      name: def.name,
      version: def.version,
      path: `/${def.path}`,
    })),
  }));
}
