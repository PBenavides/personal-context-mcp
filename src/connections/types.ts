import type { LocalCorpusIndex } from './local-corpus.js';

/**
 * The generalizable connection layer contract.
 *
 * A {@link Connection} is a lazily-initialised, memoised handle to an external dependency (local
 * corpus, relational DB). New dependency types are added by implementing this interface and
 * registering a factory in `src/connections/registry.ts` — nothing else in the app needs to
 * change. This mirrors the MCP {@link import('../registry/types.js').McpDefinition} pattern: one
 * small contract, a single registry, fail-fast validation.
 */

/** Discriminator for the kinds of external dependency this service can connect to. */
export type ConnectionKind = 'local-corpus' | 'postgres';

/** Result of a lightweight liveness probe against a single connection. */
export interface ConnectionHealth {
  name: string;
  kind: ConnectionKind;
  ok: boolean;
  /** Human-readable status, e.g. an error message or `"4 collections"`. */
  detail?: string;
}

/**
 * A lazily-initialised, shared external dependency.
 *
 * The underlying client is built once, on first {@link get}, and cached for the process lifetime —
 * safe to share across the stateless per-request MCP servers (the clients are themselves either
 * stateless HTTP or manage their own pools). `get()` throws a clear error when the connection is
 * not configured (e.g. missing credentials), rather than returning a half-initialised client.
 */
export interface Connection<TClient> {
  /** Unique registry key, e.g. `local-corpus`. */
  readonly name: string;
  readonly kind: ConnectionKind;
  /** Build (once, memoised) and return the underlying client. Throws if unconfigured. */
  get(): TClient;
  /** Cheap liveness probe for diagnostics/readiness. Never throws — reports `ok: false` instead. */
  healthCheck(): Promise<ConnectionHealth>;
  /** Release any held resources (pools, sockets). No-op for stateless HTTP clients. */
  close(): Promise<void>;
}

/**
 * The set of connections available to MCPs and routes. Typed accessors for the concrete
 * connections plus generic helpers over all of them. Obtain it via `getConnections()` in
 * `src/connections/registry.ts` (module-scoped, lazily built from `appConfig`).
 */
export interface ConnectionRegistry {
  readonly localCorpus: Connection<LocalCorpusIndex>;
  /** Scaffold connection — proves the registry generalises; inert until configured. */
  readonly postgres: Connection<unknown>;
  /** All registered connections, for generic operations like health checks. */
  all(): ReadonlyArray<Connection<unknown>>;
  /** Probe every connection concurrently. */
  healthCheckAll(): Promise<ConnectionHealth[]>;
}
