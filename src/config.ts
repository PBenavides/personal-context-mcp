import config from 'config';

/** Connection settings for the external dependencies wired through `src/connections/`. */
export interface ConnectionsConfig {
  /**
   * Local BM25 corpus (see `src/connections/local-corpus.ts`). `rootDir` resolves relative to
   * `resource-files/` (via `getResourcePath`) unless it's an absolute path, which is used as-is
   * (e.g. tests pointing at a temp fixture directory).
   */
  localCorpus: { rootDir: string };
  /** Postgres connection scaffold — inert until a `url` is configured. */
  postgres: { url: string };
}

export interface AppConfig {
  port: number;
  /** JWT verification options (see `src/auth.ts`). Empty `jwksUri` = unenforced (phase 1). */
  jwt: { jwksUri?: string };
  logger: {
    level: string;
  };
  connections: ConnectionsConfig;
  /**
   * DNS-rebinding protection for the MCP endpoints (see `src/registry/mount.ts`).
   * Default-off for the POC so local `inject()` and 127.0.0.1 clients keep working;
   * flip on and populate the allow-lists for production.
   */
  security: {
    /** DNS-rebinding protection on MCP endpoints. Default false for the POC. */
    dnsRebindingProtection: boolean;
    /** Allowed Host header values when protection is on, e.g. ['mcp-server.sdlc.taxfix.io']. */
    allowedHosts: string[];
    /** Allowed Origin header values when protection is on. */
    allowedOrigins: string[];
  };
  /** Options for the context-layer MCP (see `src/mcps/context-layer/`). */
  contextLayer: {
    /**
     * Optional denylist for the live local-corpus collection discovery. Each entry is matched
     * against collection (subdirectory) names (substring, or a full regex when the entry is a
     * valid pattern) and matching collections are hidden from `list_collections`, resources, and
     * search. Lets test/system collections be excluded without a code change. Empty = expose
     * everything.
     */
    excludeCollections: string[];
  };
}

/**
 * Normalizes the `contextLayer.excludeCollections` value into a string array. Accepts a native JSON
 * array (from `config/*.json`) or a comma-separated string (from the `CONTEXT_LAYER_EXCLUDE_COLLECTIONS`
 * env var), tolerating blanks and surrounding whitespace.
 */
export function normalizeExcludeCollections(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return values
    .map(value => String(value).trim())
    .filter(value => value.length > 0);
}

/**
 * Application configuration, sourced via the standard `config` package (`config/*.json` +
 * `config/custom-environment-variables.json`), matching the convention used across Taxfix services.
 */
export const appConfig: AppConfig = {
  port: Number(config.get<number | string>('port')),
  jwt: config.get<AppConfig['jwt']>('jwt'),
  logger: config.get<AppConfig['logger']>('logger'),
  connections: config.get<ConnectionsConfig>('connections'),
  security: config.get<AppConfig['security']>('security'),
  contextLayer: {
    excludeCollections: normalizeExcludeCollections(
      config.get<unknown>('contextLayer.excludeCollections'),
    ),
  },
};
