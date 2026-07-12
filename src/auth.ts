import fastifyJwt from '@fastify/jwt';
import buildGetJwks from 'get-jwks';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AuthOptions {
  jwksUri?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

/**
 * Decorates `authenticate`, a preHandler MCP/management routes can opt into.
 *
 * Phase 1: `jwksUri` is unset by default, so verification is unenforced — `authenticate` is a
 * no-op and every route stays reachable. Once a `jwksUri` is configured, `@fastify/jwt` verifies
 * bearer tokens against that JWKS endpoint (via `get-jwks`) and `authenticate` rejects requests
 * with a missing/invalid token.
 */
export const registerAuth = fp<AuthOptions>(
  async (fastify, { jwksUri }) => {
    if (!jwksUri) {
      fastify.decorate('authenticate', async () => {
        // Unenforced: no jwksUri configured.
      });
      return;
    }

    const domain = new URL(jwksUri).origin;
    const getJwks = buildGetJwks({ providerDiscovery: true, jwksPath: new URL(jwksUri).pathname });
    await fastify.register(fastifyJwt, {
      secret: (_request: FastifyRequest, tokenOrHeader: fastifyJwt.TokenOrHeader) => {
        const header = 'header' in tokenOrHeader ? tokenOrHeader.header : tokenOrHeader;
        return getJwks.getPublicKey({ kid: header.kid, alg: header.alg, domain });
      },
    });

    fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (error) {
        request.log.warn({ err: error }, 'failed authentication');
        await reply.unauthorized();
      }
    });
  },
  { name: 'auth', dependencies: ['@fastify/sensible'] },
);
