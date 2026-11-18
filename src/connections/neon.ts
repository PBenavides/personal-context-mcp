import type { ConnectionsConfig } from '../config.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * A read-only client for a Neon Postgres database over Neon's HTTP SQL endpoint — the protocol
 * behind `@neondatabase/serverless`, spoken with plain `fetch`, so no driver or socket pool:
 *
 *   POST https://api.<endpoint host>/sql
 *   header Neon-Connection-String: postgresql://user:pass@ep-….neon.tech/db
 *   body   { queries: [{ query, params }] }  ->  { results: [{ rows, … }] }, one transaction
 *
 * Today it carries the Web Time Tracker mirror (the Chrome extension in
 * `chrome-personal-plugins/web-time-tracker`, schema in its `db/schema.sql`), consumed by the
 * personal-tools webtime_* tools. SQL and response shaping live in
 * `src/mcps/personal-tools/webtime-tools.ts`.
 *
 * Every call is a batch sent with `Neon-Batch-Read-Only: true`, so Postgres itself refuses
 * writes whatever role the connection string names. The batch opens with a `set_config` that
 * bounds the statement time; being the first statement, it also takes the transaction's
 * snapshot, after which a caller's statement can no longer switch it to read-write.
 *
 * Unconfigured (no database URL) the connection stays inert and `maybe()` returns undefined —
 * the tools report themselves unconfigured, so credential-free dev/test runs keep working.
 */

export type SqlParam = string | number | boolean | null;
export type SqlRow = Record<string, unknown>;

export interface SqlStatement {
  query: string;
  params?: SqlParam[];
}

export interface NeonClient {
  /** Runs the statements in one read-only transaction; resolves to one rows array per statement. */
  read(statements: SqlStatement[]): Promise<SqlRow[][]>;
}

export interface NeonConnection extends Connection<NeonClient> {
  maybe(): NeonClient | undefined;
}

export interface NeonDeps {
  /** Overrides fetch (tests inject a fake). */
  fetchFn?: typeof fetch;
}

/** Upper bound on any one statement, so a runaway ad-hoc query cannot pin the compute. */
export const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Validates a Neon connection string and returns its HTTP SQL endpoint plus a credential-free
 * label (`role@ep-…/db`). Throws on anything that is not a Neon Postgres URL.
 */
export function parseNeonUrl(databaseUrl: string): { endpoint: string; label: string } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('not a connection string (expected postgresql://user:password@ep-….neon.tech/db)');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error('connection string must start with postgresql://');
  }
  if (!url.username || !url.password) {
    throw new Error('connection string is missing the user or password');
  }
  if (url.pathname.length < 2) {
    throw new Error('connection string is missing the database name');
  }
  if (!url.hostname.endsWith('.neon.tech')) {
    throw new Error('host must be a Neon endpoint (….neon.tech)');
  }
  return {
    endpoint: `https://${url.hostname.replace(/^[^.]+\./, 'api.')}/sql`,
    label: `${decodeURIComponent(url.username)}@${url.hostname.split('.')[0]}${url.pathname}`,
  };
}

export function createNeonConnection(
  name: string,
  config: ConnectionsConfig['webTimeTracker'],
  deps: NeonDeps = {},
): NeonConnection {
  const kind = 'neon' as const;
  const fetchFn = deps.fetchFn ?? fetch;
  const configured = Boolean(config.databaseUrl);

  // A malformed URL leaves the connection configured-but-broken: /ready reports why, and the
  // tools surface the same message, rather than the host refusing to boot over one integration.
  let endpoint = '';
  let label = '';
  let invalid: string | undefined;
  if (configured) {
    try {
      ({ endpoint, label } = parseNeonUrl(config.databaseUrl));
    } catch (error) {
      invalid = (error as Error).message;
    }
  }

  const client: NeonClient = {
    async read(statements): Promise<SqlRow[][]> {
      if (statements.length === 0) {
        return [];
      }
      const queries = [
        {
          query: "select set_config('statement_timeout', $1, true)",
          params: [String(STATEMENT_TIMEOUT_MS)],
        },
        ...statements.map(({ query, params = [] }) => ({
          query,
          // The endpoint takes text parameters; SQL casts them ($1::date, $2::int, …).
          params: params.map(value => (value === null ? null : String(value))),
        })),
      ];

      let res: Response;
      try {
        res = await fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'Neon-Connection-String': config.databaseUrl,
            'Neon-Batch-Read-Only': 'true',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ queries }),
        });
      } catch (error) {
        throw new Error(`Could not reach Neon: ${(error as Error).message}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let message = text.slice(0, 500);
        try {
          message = (JSON.parse(text) as { message?: string }).message ?? message;
        } catch {
          /* not JSON — keep the raw text */
        }
        throw new Error(`Neon ${res.status}: ${message}`);
      }
      const body = (await res.json()) as { results?: { rows?: SqlRow[] }[] };
      // Drop the leading set_config result.
      return (body.results ?? []).slice(1).map(result => result.rows ?? []);
    },
  };

  return {
    name,
    kind,
    get(): NeonClient {
      if (!configured) {
        throw new Error(`${name} is not configured (database URL unset)`);
      }
      if (invalid) {
        throw new Error(`${name} database URL is invalid: ${invalid}`);
      }
      return client;
    },
    maybe(): NeonClient | undefined {
      return configured && !invalid ? client : undefined;
    },
    // Reports configuration only. A live probe would wake the Neon compute on every /ready
    // poll and keep it from autosuspending, which is what Neon bills for.
    async healthCheck(): Promise<ConnectionHealth> {
      if (invalid) {
        return { name, kind, ok: false, detail: `invalid database URL: ${invalid}` };
      }
      return {
        name,
        kind,
        ok: true,
        detail: configured ? `${label} (read-only)` : `not configured — ${name} tools disabled`,
      };
    },
    async close(): Promise<void> {
      /* stateless HTTP; nothing to release */
    },
  };
}
