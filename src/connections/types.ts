import type { EnrichedCorpusConnection } from './enriched-corpus.js';
import type { GoogleCalendarConnection } from './google-calendar.js';
import type { HevyConnection } from './hevy.js';
import type { OntologyStoreConnection } from './ontology-store.js';
import type { OpenRouterConnection } from './openrouter.js';
import type { VectorSearchConnection } from './vector-search.js';
import type { YnabConnection } from './ynab.js';

/**
 * The generalizable connection layer contract.
 *
 * A {@link Connection} is a lazily-initialised, memoised handle to an external dependency. New
 * dependency types are added by implementing this interface and registering a factory in
 * `src/connections/registry.ts` — nothing else in the app needs to change. This mirrors the MCP
 * {@link import('../registry/types.js').McpDefinition} pattern: one small contract, a single
 * registry, fail-fast validation.
 */

/** Discriminator for the kinds of external dependency this service can connect to. */
export type ConnectionKind =
  | 'enriched-corpus'
  | 'vector-search'
  | 'ontology-store'
  | 'openrouter'
  | 'ynab'
  | 'hevy'
  | 'google-calendar';

/** Result of a lightweight liveness probe against a single connection. */
export interface ConnectionHealth {
  name: string;
  kind: ConnectionKind;
  ok: boolean;
  /** Human-readable status, e.g. an error message or `"42 documents"`. */
  detail?: string;
}

/**
 * A lazily-initialised, shared external dependency.
 *
 * The underlying client is built once and cached for the process lifetime — safe to share across
 * the stateless per-request MCP servers. `get()` throws a clear error when the connection is not
 * ready (e.g. corpus not loaded), rather than returning a half-initialised client.
 */
export interface Connection<TClient> {
  /** Unique registry key, e.g. `enriched-corpus`. */
  readonly name: string;
  readonly kind: ConnectionKind;
  /** Return the underlying client. Throws if not ready/configured. */
  get(): TClient;
  /** Cheap liveness probe for diagnostics/readiness. Never throws — reports `ok: false` instead. */
  healthCheck(): Promise<ConnectionHealth>;
  /** Release any held resources (timers, pools, sockets). */
  close(): Promise<void>;
}

/**
 * The set of connections available to MCPs and routes. Typed accessors for the concrete
 * connections plus generic helpers over all of them. Obtain it via `getConnections()` in
 * `src/connections/registry.ts` (module-scoped, lazily built from `appConfig`).
 */
export interface ConnectionRegistry {
  readonly enrichedCorpus: EnrichedCorpusConnection;
  readonly vectorSearch: VectorSearchConnection;
  readonly ontologyStore: OntologyStoreConnection;
  readonly openRouter: OpenRouterConnection;
  readonly ynab: YnabConnection;
  readonly hevy: HevyConnection;
  readonly googleCalendar: GoogleCalendarConnection;
  /** All registered connections, for generic operations like health checks. */
  all(): ReadonlyArray<Connection<unknown>>;
  /** Probe every connection concurrently. */
  healthCheckAll(): Promise<ConnectionHealth[]>;
}
