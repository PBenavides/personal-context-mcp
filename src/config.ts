import config from 'config';

/** Connection settings for the external dependencies wired through `src/connections/`. */
export interface ConnectionsConfig {
  /**
   * The enriched context corpus (see `src/connections/enriched-corpus.ts`). `source` picks the
   * backend: `file` reads `rootDir` (relative paths resolve against the process cwd — used for
   * fixtures and credential-free tests), `s3` reads `bucket`/`prefix` in `region` with the AWS
   * SDK v3 default credential chain (env keys, profile, or task role).
   */
  enrichedCorpus: {
    source: 'file' | 's3';
    rootDir: string;
    bucket: string;
    prefix: string;
    region: string;
    /** Manifest `run_id` re-check interval; `0` disables background refresh. */
    refreshSeconds: number;
  };
  /**
   * The S3 Vectors index behind semantic `search_context` (see
   * `src/connections/vector-search.ts`). Empty `bucket`/`index` disables it — search falls
   * back to BM25 — so file-source fixture runs stay credential-free.
   */
  vectorSearch: {
    bucket: string;
    index: string;
    region: string;
    /** Bedrock embedding model id; must match what the pipeline embedded documents with. */
    embedModelId: string;
  };
}

export interface AppConfig {
  port: number;
  /**
   * Static bearer token required on MCP routes (see `src/auth.ts`). Empty = unenforced (local
   * dev only — production sets `MCP_BEARER_TOKEN`; the network is Tailscale-gated anyway, this
   * is defense in depth). `/health` and `/ready` are always unauthenticated.
   */
  auth: { bearerToken: string };
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
    /** Allowed Host header values when protection is on. */
    allowedHosts: string[];
    /** Allowed Origin header values when protection is on. */
    allowedOrigins: string[];
  };
}

/**
 * Application configuration, sourced via the standard `config` package (`config/*.json` +
 * `config/custom-environment-variables.json` for env overrides).
 */
export const appConfig: AppConfig = {
  port: Number(config.get<number | string>('port')),
  auth: config.get<AppConfig['auth']>('auth'),
  logger: config.get<AppConfig['logger']>('logger'),
  connections: {
    enrichedCorpus: {
      ...config.get<ConnectionsConfig['enrichedCorpus']>('connections.enrichedCorpus'),
      refreshSeconds: Number(config.get<number | string>('connections.enrichedCorpus.refreshSeconds')),
    },
    vectorSearch: config.get<ConnectionsConfig['vectorSearch']>('connections.vectorSearch'),
  },
  security: config.get<AppConfig['security']>('security'),
};
