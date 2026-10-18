import type { ConnectionsConfig } from '../config.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * The Doctolib connection: transport for the internal JSON API Doctolib's patient frontend
 * uses (there is no public API — the official one is partner-only), plus Nominatim geocoding,
 * which the search endpoint needs to build its bounding box. Consumed by the doctolib_* tools
 * in personal-tools; endpoint paths and response shaping live in
 * `src/mcps/personal-tools/doctolib-tools.ts`.
 *
 * Ported from esinecan/doctolib-mcp (Python), read path only. Its `docs/endpoints.md` is the
 * reference for the contract; the parts this transport depends on:
 *
 * - DataDome sits in front of the site. As of 2026-08 a Chrome User-Agent plus a Referer
 *   passes on the JSON endpoints; a default fetch UA draws a 403 challenge. That is observed
 *   behaviour, not a contract — a 403 is reported as such rather than retried with more
 *   header guessing.
 * - The search endpoint answers `206 Partial Content` on success, so 200 and 206 both count.
 * - Requests are throttled per host (min interval + jitter) to stay polite.
 *
 * No credentials: the reads are anonymous, so the connection is always configured.
 */

export const DOCTOLIB_HOSTS = {
  de: 'https://www.doctolib.de',
  fr: 'https://www.doctolib.fr',
  it: 'https://www.doctolib.it',
} as const;

export type DoctolibCountry = keyof typeof DOCTOLIB_HOSTS;

export const DOCTOLIB_COUNTRIES = Object.keys(DOCTOLIB_HOSTS) as DoctolibCountry[];

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/** One Nominatim hit; `boundingbox` is `[south, north, west, east]` as strings. */
export interface GeocodeHit {
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
  display_name?: string;
}

export interface DoctolibClient {
  /** Base URL for a country, e.g. `https://www.doctolib.de`. */
  baseUrl(country: DoctolibCountry): string;
  /** Request a Doctolib JSON endpoint; undefined params are dropped. */
  request(
    country: DoctolibCountry,
    method: 'GET' | 'POST',
    path: string,
    options?: { params?: Record<string, string | number | undefined>; body?: unknown },
  ): Promise<unknown>;
  /** First Nominatim hit for `query` within `country`, or undefined when nothing matched. */
  geocode(query: string, country: DoctolibCountry): Promise<GeocodeHit | undefined>;
}

export interface DoctolibConnection extends Connection<DoctolibClient> {
  readonly defaultCountry: DoctolibCountry;
}

export interface DoctolibDeps {
  /** Overrides fetch (tests inject a fake). */
  fetchFn?: typeof fetch;
  /** Overrides the throttle's sleep (tests skip the wait). */
  sleep?: (ms: number) => Promise<void>;
}

export function createDoctolibConnection(
  config: ConnectionsConfig['doctolib'],
  deps: DoctolibDeps = {},
): DoctolibConnection {
  const name = 'doctolib';
  const kind = 'doctolib' as const;
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const minIntervalMs = Number(config.minIntervalMs);
  const defaultCountry = (
    DOCTOLIB_COUNTRIES.includes(config.defaultCountry as DoctolibCountry) ? config.defaultCountry : 'de'
  ) as DoctolibCountry;

  // Per-host throttle. Each caller reserves the next free slot synchronously, so concurrent
  // fan-out (doctolib_search's availability probes) still spaces its requests out.
  const nextSlot = new Map<string, number>();
  async function throttle(host: string): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + minIntervalMs + Math.random() * (minIntervalMs * 0.6));
    if (slot > now) {
      await sleep(slot - now);
    }
  }

  function query(params: Record<string, string | number | undefined> = {}): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        qs.set(key, String(value));
      }
    }
    const s = qs.toString();
    return s ? `?${s}` : '';
  }

  const client: DoctolibClient = {
    baseUrl(country): string {
      return DOCTOLIB_HOSTS[country];
    },

    async request(country, method, path, options = {}): Promise<unknown> {
      const base = DOCTOLIB_HOSTS[country];
      const url = `${base}${path}${query(options.params)}`;
      await throttle(base);
      const res = await fetchFn(url, {
        method,
        headers: {
          'User-Agent': CHROME_UA,
          Accept: 'application/json',
          'Accept-Language': `${country}-${country.toUpperCase()},${country};q=0.9,en;q=0.8`,
          Referer: `${base}/`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (res.status === 403) {
        throw new Error(
          'Doctolib answered 403: DataDome is challenging this client. Header spoofing is no ' +
            'longer enough; these reads now need a real browser session.',
        );
      }
      // Search answers 206 Partial Content on success (paged results).
      if (res.status !== 200 && res.status !== 206) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`Doctolib ${method} ${path} failed: ${res.status} ${detail}`);
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Doctolib ${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
      }
    },

    async geocode(q, country): Promise<GeocodeHit | undefined> {
      const url =
        'https://nominatim.openstreetmap.org/search' +
        query({ q, countrycodes: country, format: 'json', limit: 1 });
      await throttle('nominatim');
      // Nominatim's usage policy asks for an identifying UA rather than a browser one.
      const res = await fetchFn(url, {
        headers: { 'User-Agent': 'personal-context-mcp/doctolib (personal appointment search)' },
      });
      if (!res.ok) {
        throw new Error(`Geocoding ${JSON.stringify(q)} failed: ${res.status}`);
      }
      const hits = (await res.json()) as GeocodeHit[];
      return hits[0];
    },
  };

  return {
    name,
    kind,
    defaultCountry,
    get(): DoctolibClient {
      return client;
    },
    async healthCheck(): Promise<ConnectionHealth> {
      return {
        name,
        kind,
        ok: true,
        detail: `anonymous reads, default country ${defaultCountry}`,
      };
    },
    async close(): Promise<void> {
      /* stateless HTTP; nothing to release */
    },
  };
}
