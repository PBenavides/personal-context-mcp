import type { ConnectionsConfig } from '../config.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * The Google Calendar connection: an OAuth-refresh-token-authenticated HTTP client for the
 * Google Calendar v3 REST API (https://www.googleapis.com/calendar/v3), consumed by the
 * personal-tools MCP. Endpoint paths and response shaping live in
 * `src/mcps/personal-tools/tools.ts`; this layer only owns auth (access-token refresh +
 * caching) and transport.
 *
 * Unlike YNAB/Hevy (static bearer tokens), Google uses a long-lived refresh token minted once
 * via an interactive browser flow (see `docs/personal-tools.md`) plus an OAuth client
 * id/secret. The connection exchanges the refresh token for a short-lived access token on
 * first use and re-exchanges it once the cached token is within `TOKEN_REFRESH_SKEW_MS` of
 * expiring — ported from the Python `_auth.py`'s "refresh if expired" behaviour.
 *
 * Unconfigured (missing refresh token / client id / client secret) the connection stays inert
 * and `maybe()` returns undefined — gcal_* tools report themselves unconfigured, so
 * credential-free dev/test runs keep working.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Refresh a bit before actual expiry to avoid racing a request against expiration. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface GoogleCalendarClient {
  /** GET `path` (e.g. `/calendars/primary/events`); undefined params are dropped. */
  get(path: string, params?: Record<string, string | undefined>): Promise<unknown>;
  /** POST `path` with a JSON body. */
  post(path: string, body: unknown, params?: Record<string, string | undefined>): Promise<unknown>;
  /** PATCH `path` with a JSON body. */
  patch(path: string, body: unknown, params?: Record<string, string | undefined>): Promise<unknown>;
  /** DELETE `path`. */
  delete(path: string, params?: Record<string, string | undefined>): Promise<unknown>;
}

export interface GoogleCalendarConnection extends Connection<GoogleCalendarClient> {
  maybe(): GoogleCalendarClient | undefined;
}

export interface GoogleCalendarDeps {
  /** Overrides fetch (tests inject a fake). */
  fetchFn?: typeof fetch;
  /** Overrides the wall clock (tests control token expiry). */
  now?: () => number;
}

function buildUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) {
      query.set(key, value);
    }
  }
  const qs = query.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export function createGoogleCalendarConnection(
  config: ConnectionsConfig['googleCalendar'],
  deps: GoogleCalendarDeps = {},
): GoogleCalendarConnection {
  const name = 'google-calendar';
  const kind = 'google-calendar' as const;
  const configured = Boolean(config.refreshToken && config.clientId && config.clientSecret);
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const baseUrl = config.baseUrl.replace(/\/$/, '');

  let cachedToken: CachedToken | undefined;

  async function getAccessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt - TOKEN_REFRESH_SKEW_MS > now()) {
      return cachedToken.accessToken;
    }
    const res = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: config.refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }).toString(),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Google token refresh failed: ${res.status} ${detail}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { accessToken: body.access_token, expiresAt: now() + body.expires_in * 1000 };
    return cachedToken.accessToken;
  }

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    params?: Record<string, string | undefined>,
    body?: unknown,
  ): Promise<unknown> {
    const accessToken = await getAccessToken();
    const res = await fetchFn(buildUrl(baseUrl, path, params), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new Error(`Google Calendar ${method} ${path} failed: ${res.status} ${detail}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  const client: GoogleCalendarClient = {
    get: (path, params) => request('GET', path, params),
    post: (path, body, params) => request('POST', path, params, body),
    patch: (path, body, params) => request('PATCH', path, params, body),
    delete: (path, params) => request('DELETE', path, params),
  };

  return {
    name,
    kind,
    get(): GoogleCalendarClient {
      if (!configured) {
        throw new Error(
          'Google Calendar is not configured (GOOGLE_CALENDAR_REFRESH_TOKEN / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET unset)',
        );
      }
      return client;
    },
    maybe(): GoogleCalendarClient | undefined {
      return configured ? client : undefined;
    },
    async healthCheck(): Promise<ConnectionHealth> {
      return {
        name,
        kind,
        ok: true,
        detail: configured ? baseUrl : 'not configured — gcal_* tools disabled',
      };
    },
    async close(): Promise<void> {
      /* stateless HTTP; nothing to release */
    },
  };
}
