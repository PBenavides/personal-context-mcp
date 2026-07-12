import type { ConnectionsConfig } from '../config.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * Postgres connection SCAFFOLD.
 *
 * This file is the template for adding a NEW connection kind to the registry — it deliberately
 * carries no runtime dependency on `pg` so the repository stays lean until a real Postgres
 * consumer appears. To add a real dependency (Postgres, Redis, S3, ...):
 *
 *  1. Copy this file to `src/connections/<kind>.ts` and rename the factory.
 *  2. Add the new `ConnectionKind` literal to `src/connections/types.ts`.
 *  3. Add a config block in `src/config.ts` (`ConnectionsConfig`).
 *  4. Implement `get()` — build the client lazily, memoise it, throw a clear "not configured"
 *     error when required config is missing.
 *  5. Implement `healthCheck()` — never throw; return `ok: false, detail: <error message>` on
 *     failure and `ok: false, detail: 'not configured'` when unconfigured.
 *  6. Implement `close()` — release pools/sockets; leave as a no-op for stateless HTTP clients.
 *  7. Register the new connection in `src/connections/registry.ts` (`createConnections`) and,
 *     if callers need typed access, add a field to `ConnectionRegistry` in `types.ts`.
 *  8. Add unit tests using dependency injection (see `local-corpus.test.ts`) — do not use ESM
 *     module mocking.
 *
 * Until any of that happens this connection is inert: `get()` always throws, so the presence of
 * the field on the registry cannot be mistaken for a working client.
 */
export function createPostgresConnection(
  config: ConnectionsConfig['postgres'],
): Connection<unknown> {
  const name = 'postgres';
  const kind = 'postgres' as const;

  return {
    name,
    kind,
    get(): unknown {
      throw new Error(
        'Postgres connection is a scaffold and not implemented yet',
      );
    },
    async healthCheck(): Promise<ConnectionHealth> {
      return {
        name,
        kind,
        ok: false,
        detail: config.url
          ? 'configured but not implemented'
          : 'not configured (scaffold)',
      };
    },
    async close(): Promise<void> {
      // No client is ever built; nothing to release.
    },
  };
}
