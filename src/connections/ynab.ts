import type { ConnectionsConfig } from '../config.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * The YNAB connection: a thin authenticated HTTP client for the YNAB v1 REST API
 * (https://api.ynab.com/v1), consumed by the personal-tools MCP. Endpoint paths and
 * response shaping live in `src/mcps/personal-tools/tools.ts`; this layer only owns
 * auth, transport, and error surfacing.
 *
 * Unconfigured (no `YNAB_TOKEN`) the connection stays inert and `maybe()` returns
 * undefined — ynab_* tools report themselves unconfigured, so credential-free dev/test
 * runs keep working.
 */

export interface YnabClient {
  /** GET `endpoint` (e.g. `/budgets/last-used/accounts`); undefined params are dropped. */
  get(endpoint: string, params?: Record<string, string | undefined>): Promise<unknown>;
  /** POST `endpoint` with a JSON body. */
  post(endpoint: string, body: unknown): Promise<unknown>;
}

export interface YnabConnection extends Connection<YnabClient> {
  maybe(): YnabClient | undefined;
}

export interface YnabDeps {
  /** Overrides fetch (tests inject a fake). */
  fetchFn?: typeof fetch;
}

function buildUrl(
  baseUrl: string,
  endpoint: string,
  params?: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) {
      query.set(key, value);
    }
  }
  const qs = query.toString();
  return `${baseUrl}${endpoint}${qs ? `?${qs}` : ''}`;
}

export function createYnabConnection(
  config: ConnectionsConfig['ynab'],
  deps: YnabDeps = {},
): YnabConnection {
  const name = 'ynab';
  const kind = 'ynab' as const;
  const configured = Boolean(config.token);
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  async function request(
    method: 'GET' | 'POST',
    endpoint: string,
    params?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetchFn(buildUrl(baseUrl, endpoint, params), {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`YNAB ${method} ${endpoint} failed: ${res.status} ${detail}`);
    }
    return res.json();
  }

  const client: YnabClient = {
    get: (endpoint, params) => request('GET', endpoint, params),
    post: (endpoint, body) => request('POST', endpoint, undefined, body),
  };

  return {
    name,
    kind,
    get(): YnabClient {
      if (!configured) {
        throw new Error('YNAB is not configured (YNAB_TOKEN unset)');
      }
      return client;
    },
    maybe(): YnabClient | undefined {
      return configured ? client : undefined;
    },
    async healthCheck(): Promise<ConnectionHealth> {
      return {
        name,
        kind,
        ok: true,
        detail: configured
          ? baseUrl
          : 'not configured — ynab_* tools disabled',
      };
    },
    async close(): Promise<void> {
      /* stateless HTTP; nothing to release */
    },
  };
}
