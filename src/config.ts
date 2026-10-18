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
  /**
   * The ontology registry (see `src/connections/ontology-store.ts`): RDF/XML (OWL) graph built
   * from the enriched corpus by the injector, persisted versioned under `prefix` (S3) or
   * `rootDir` (local file mode — dev/tests, credential-free).
   */
  ontology: {
    source: 'file' | 's3';
    rootDir: string;
    bucket: string;
    prefix: string;
    region: string;
    /** Hourly top-of-hour injector sync (see `src/ontology/scheduler.ts`). */
    syncEnabled: boolean;
    /** Per-sync-run cap on documents routed through the LLM, bounds cost. */
    maxDocsPerRun: number;
  };
  /**
   * OpenRouter (LLM + embeddings) behind the ontology injector and `ontology_search`.
   * Empty `apiKey` disables it: search falls back to keyword scoring, sync reports itself
   * unconfigured. Key comes from `OPENROUTER_API_KEY` (SSM in production) — never from code.
   */
  openRouter: {
    apiKey: string;
    baseUrl: string;
    chatModel: string;
    embedModel: string;
  };
  /**
   * YNAB (You Need A Budget) REST API behind the personal-tools MCP (see
   * `src/connections/ynab.ts`). Empty `token` disables it — ynab_* tools report themselves
   * unconfigured. Token comes from `YNAB_TOKEN` (SSM in production) — never from code.
   */
  ynab: {
    token: string;
    baseUrl: string;
  };
  /**
   * Hevy workout-tracking API behind the personal-tools MCP (see `src/connections/hevy.ts`).
   * Empty `apiKey` disables it — hevy_* tools report themselves unconfigured. Key comes from
   * `HEVY_API_KEY` (SSM in production; requires Hevy Pro) — never from code.
   */
  hevy: {
    apiKey: string;
    baseUrl: string;
  };
  /**
   * Google Calendar v3 REST API behind the personal-tools MCP (see
   * `src/connections/google-calendar.ts`). Unlike YNAB/Hevy this is OAuth-refresh-token
   * based: a long-lived `refreshToken` (minted once via an interactive browser flow, see
   * `docs/personal-tools.md`) plus the OAuth client id/secret are exchanged for short-lived
   * access tokens. Any of the three empty ⇒ disabled — gcal_* tools report themselves
   * unconfigured. All three come from env (SSM in production) — never from code.
   */
  googleCalendar: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
    baseUrl: string;
  };
  /**
   * Doctolib's internal patient-frontend JSON API behind the personal-tools doctolib_* tools (see
   * `src/connections/doctolib.ts`). Anonymous reads only — no credentials, always on.
   * `defaultCountry` picks doctolib.de/.fr/.it when a tool omits `country`; `minIntervalMs`
   * is the per-host throttle between requests.
   */
  doctolib: {
    defaultCountry: string;
    minIntervalMs: number;
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
    ontology: {
      ...config.get<ConnectionsConfig['ontology']>('connections.ontology'),
      syncEnabled:
        String(config.get<boolean | string>('connections.ontology.syncEnabled')) === 'true',
      maxDocsPerRun: Number(config.get<number | string>('connections.ontology.maxDocsPerRun')),
    },
    openRouter: config.get<ConnectionsConfig['openRouter']>('connections.openRouter'),
    ynab: config.get<ConnectionsConfig['ynab']>('connections.ynab'),
    hevy: config.get<ConnectionsConfig['hevy']>('connections.hevy'),
    googleCalendar: config.get<ConnectionsConfig['googleCalendar']>('connections.googleCalendar'),
    doctolib: {
      ...config.get<ConnectionsConfig['doctolib']>('connections.doctolib'),
      minIntervalMs: Number(config.get<number | string>('connections.doctolib.minIntervalMs')),
    },
  },
  security: config.get<AppConfig['security']>('security'),
};
