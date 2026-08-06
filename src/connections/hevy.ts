import type { ConnectionsConfig } from '../config.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * The Hevy connection: a thin authenticated HTTP client for the Hevy workout-tracking API
 * (https://api.hevyapp.com, `api-key` header), consumed by the personal-tools MCP. Endpoint
 * paths, pagination, and aggregation live in `src/mcps/personal-tools/tools.ts`.
 *
 * Unconfigured (no `HEVY_API_KEY`) the connection stays inert and `maybe()` returns
 * undefined — hevy_* tools report themselves unconfigured, so credential-free dev/test
 * runs keep working.
 */

export interface HevyClient {
  /** GET `endpoint` (e.g. `/v1/workouts`); undefined params are dropped. */
  get(endpoint: string, params?: Record<string, string | undefined>): Promise<unknown>;
  /** POST `endpoint` with a JSON body — creates a workout, routine, or folder. */
  post(endpoint: string, body: unknown): Promise<unknown>;
  /** PUT `endpoint` with a JSON body. Hevy has no PATCH: this replaces the whole object. */
  put(endpoint: string, body: unknown): Promise<unknown>;
}

export interface HevyConnection extends Connection<HevyClient> {
  maybe(): HevyClient | undefined;
}

export interface HevyDeps {
  /** Overrides fetch (tests inject a fake). */
  fetchFn?: typeof fetch;
}

export function createHevyConnection(
  config: ConnectionsConfig['hevy'],
  deps: HevyDeps = {},
): HevyConnection {
  const name = 'hevy';
  const kind = 'hevy' as const;
  const configured = Boolean(config.apiKey);
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  async function request(
    method: 'GET' | 'POST' | 'PUT',
    endpoint: string,
    params?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<unknown> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) {
        query.set(key, value);
      }
    }
    const qs = query.toString();
    const res = await fetchFn(`${baseUrl}${endpoint}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        'api-key': config.apiKey,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Hevy ${method} ${endpoint} failed: ${res.status} ${detail}`);
    }
    // Some write endpoints answer 200/201 with an empty body.
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  const client: HevyClient = {
    async get(endpoint, params): Promise<unknown> {
      return request('GET', endpoint, params);
    },
    async post(endpoint, body): Promise<unknown> {
      return request('POST', endpoint, undefined, body);
    },
    async put(endpoint, body): Promise<unknown> {
      return request('PUT', endpoint, undefined, body);
    },
  };

  return {
    name,
    kind,
    get(): HevyClient {
      if (!configured) {
        throw new Error('Hevy is not configured (HEVY_API_KEY unset)');
      }
      return client;
    },
    maybe(): HevyClient | undefined {
      return configured ? client : undefined;
    },
    async healthCheck(): Promise<ConnectionHealth> {
      return {
        name,
        kind,
        ok: true,
        detail: configured
          ? baseUrl
          : 'not configured — hevy_* tools disabled',
      };
    },
    async close(): Promise<void> {
      /* stateless HTTP; nothing to release */
    },
  };
}
