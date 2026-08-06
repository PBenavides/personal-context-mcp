import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { createServer } from './fastify-factory.js';
import { mountMcp } from './registry/mount.js';
import { getRegistry } from './registry/registry.js';
import { registerManagementRoutes } from './routes.js';
import { registerVisualOntologies } from './visual-ontologies/routes.js';

/**
 * Builds the MCP host server: the local `createServer()` (see `fastify-factory.ts`) provides
 * logging, request-id, helmet, OpenTelemetry, and the static-bearer `authenticate` decorator.
 *
 * The management surface (health, readiness, discovery) is registered directly by
 * {@link registerManagementRoutes}. Each registered MCP is then mounted at its own URL path as a
 * raw JSON-RPC route behind `authenticate`.
 *
 * Returns the instance WITHOUT calling `listen`, so tests can drive it via `server.inject()`.
 */
export async function buildServer(
  context: AppContext,
): Promise<FastifyInstance> {
  const server = await createServer({
    loggerInstance: context.logger,
    auth: context.config.auth,
  });

  registerManagementRoutes(server);
  registerVisualOntologies(server);

  const mountOptions = {
    enableDnsRebindingProtection: context.config.security.dnsRebindingProtection,
    allowedHosts: context.config.security.allowedHosts,
    allowedOrigins: context.config.security.allowedOrigins,
  };
  for (const def of getRegistry()) {
    mountMcp(server, def, mountOptions);
  }

  await server.ready();
  return server;
}
