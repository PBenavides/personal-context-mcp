import { timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AuthOptions {
  /** The static bearer token MCP routes require. Empty = unenforced (local dev). */
  bearerToken: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

/** Constant-time comparison; length mismatch short-circuits but leaks nothing useful. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Decorates `authenticate`, the preHandler the MCP routes opt into (`src/registry/mount.ts`).
 *
 * Auth is a single static bearer token (`MCP_BEARER_TOKEN`, from SSM in production): the server
 * is only reachable over the tailnet, so this is defense in depth rather than user identity —
 * no JWT, no JWKS, no multi-user. When the token is unset, `authenticate` is a no-op so local
 * dev and fixtures work with zero setup; production must set it.
 */
export const registerAuth = fp<AuthOptions>(
  async (fastify, { bearerToken }) => {
    if (!bearerToken) {
      fastify.log.warn('MCP_BEARER_TOKEN is not set — MCP routes are UNAUTHENTICATED');
      fastify.decorate('authenticate', async () => {
        // Unenforced: no token configured.
      });
      return;
    }

    fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
      if (!presented || !tokenMatches(presented, bearerToken)) {
        request.log.warn('failed authentication');
        await reply.unauthorized('Missing or invalid bearer token');
      }
    });
  },
  { name: 'auth', dependencies: ['@fastify/sensible'] },
);
