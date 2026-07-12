import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { McpDefinition } from './types.js';

const METHOD_NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
} as const;

/**
 * Optional DNS-rebinding protection wired through to `StreamableHTTPServerTransport`.
 * Defaults are all-off so local `inject()` and 127.0.0.1 callers keep working; enable in
 * production and populate the allow-lists via config (`security.*`).
 */
export interface MountOptions {
  enableDnsRebindingProtection?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

/**
 * Mounts one MCP at `/<def.path>` on the Fastify instance using a stateless Streamable HTTP
 * transport. A fresh McpServer + transport is created per request (no session affinity), and the
 * SDK writes directly to the raw Node response — so `reply.hijack()` hands it response control and
 * Fastify does not also reply. GET/DELETE are 405 (stateless mode has no SSE or session teardown).
 *
 * Every MCP route runs behind the `authenticate` preHandler (static bearer, see `src/auth.ts`);
 * only the management surface (`/health`, `/ready`) stays open.
 */
export function mountMcp(
  server: FastifyInstance,
  def: McpDefinition,
  options: MountOptions = {},
): void {
  const url = `/${def.path}`;
  const routeOptions = { preHandler: server.authenticate };

  server.post(url, routeOptions, async (request: FastifyRequest, reply: FastifyReply) => {
    // Hand the response to the SDK transport; Fastify must not also reply.
    reply.hijack();
    let teardown: (() => void) | undefined;
    try {
      const mcp = def.build();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection:
          options.enableDnsRebindingProtection ?? false,
        allowedHosts: options.allowedHosts,
        allowedOrigins: options.allowedOrigins,
      });
      let closed = false;
      teardown = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        void Promise.allSettled([transport.close(), mcp.close()]);
      };
      await mcp.connect(transport);
      // Register cleanup only after a successful connect; idempotent via `closed`.
      reply.raw.on('close', teardown);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      teardown?.();
      request.log.error({ err: error, mcp: def.name }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error.' },
            id: null,
          }),
        );
      }
    }
  });

  const methodNotAllowed = (
    _request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply => reply.code(405).send(METHOD_NOT_ALLOWED);
  server.get(url, routeOptions, methodNotAllowed);
  server.delete(url, routeOptions, methodNotAllowed);
}
