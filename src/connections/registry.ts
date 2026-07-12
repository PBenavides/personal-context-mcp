import { appConfig, type AppConfig } from '../config.js';
import { createLocalCorpusConnection } from './local-corpus.js';
import { createPostgresConnection } from './postgres.js';
import type {
  Connection,
  ConnectionHealth,
  ConnectionRegistry,
} from './types.js';

/**
 * Throws if any connection has an empty `name` or two share a `name` — mirroring the MCP registry
 * so misconfigurations fail fast at startup instead of surfacing as confusing runtime bugs.
 */
export function validateConnections(
  connections: ReadonlyArray<Connection<unknown>>,
): void {
  const seen = new Set<string>();
  for (const conn of connections) {
    if (!conn.name) {
      throw new Error(`Connection of kind "${conn.kind}" has an empty name`);
    }
    if (seen.has(conn.name)) {
      throw new Error(`Duplicate connection name: ${conn.name}`);
    }
    seen.add(conn.name);
  }
}

/**
 * Builds a {@link ConnectionRegistry} from the given config slice. Each field wraps the concrete
 * connection factory.
 */
export function createConnections(
  config: AppConfig['connections'],
): ConnectionRegistry {
  const localCorpus = createLocalCorpusConnection(config.localCorpus);
  const postgres = createPostgresConnection(config.postgres);

  const all: ReadonlyArray<Connection<unknown>> = [localCorpus, postgres];
  validateConnections(all);

  return {
    localCorpus,
    postgres,
    all(): ReadonlyArray<Connection<unknown>> {
      return all;
    },
    async healthCheckAll(): Promise<ConnectionHealth[]> {
      return Promise.all(all.map(conn => conn.healthCheck()));
    },
  };
}

let cached: ConnectionRegistry | undefined;

/**
 * Lazily builds a process-wide {@link ConnectionRegistry} from {@link appConfig} and caches it.
 *
 * All callers (MCP builders, health routes) share the returned instance so the underlying clients
 * are memoised across the per-request MCP servers. Kept module-scoped rather than passed through
 * DI for the same reason the MCP registry is module-scoped: there is exactly one per process.
 */
export function getConnections(): ConnectionRegistry {
  cached ??= createConnections(appConfig.connections);
  return cached;
}

/**
 * Clears the cached registry. Test-only — production code should never call this, because
 * discarding the cache also discards the memoised clients (and any pools they may hold).
 */
export function resetConnections(): void {
  cached = undefined;
}
