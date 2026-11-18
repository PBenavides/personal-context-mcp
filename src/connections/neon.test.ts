import { jest } from '@jest/globals';
import { createNeonConnection, parseNeonUrl, STATEMENT_TIMEOUT_MS } from './neon.js';

const URL_OK = 'postgresql://tracker_sync:s3cret@ep-cool-river-123.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const CONFIG = { databaseUrl: URL_OK };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('parseNeonUrl', () => {
  it('derives the HTTP SQL endpoint and a credential-free label', () => {
    expect(parseNeonUrl(URL_OK)).toEqual({
      endpoint: 'https://api.eu-central-1.aws.neon.tech/sql',
      label: 'tracker_sync@ep-cool-river-123/neondb',
    });
  });

  it.each([
    ['not a url', /not a connection string/],
    ['mysql://u:p@ep-x.neon.tech/db', /postgresql:\/\//],
    ['postgresql://u@ep-x.neon.tech/db', /user or password/],
    ['postgresql://u:p@ep-x.neon.tech', /database name/],
    ['postgresql://u:p@localhost/db', /Neon endpoint/],
  ])('rejects %s', (url, message) => {
    expect(() => parseNeonUrl(url)).toThrow(message);
  });
});

describe('createNeonConnection', () => {
  it('is inert when unconfigured', async () => {
    const conn = createNeonConnection('web-time-tracker', { databaseUrl: '' });
    expect(conn.maybe()).toBeUndefined();
    expect(() => conn.get()).toThrow(/not configured/);
    expect(await conn.healthCheck()).toMatchObject({ ok: true, detail: expect.stringMatching(/not configured/) });
  });

  it('reports a malformed URL in the health check and on use, without crashing', async () => {
    const conn = createNeonConnection('web-time-tracker', { databaseUrl: 'postgresql://u:p@localhost/db' });
    expect(conn.maybe()).toBeUndefined();
    expect(() => conn.get()).toThrow(/invalid: host must be a Neon endpoint/);
    expect(await conn.healthCheck()).toMatchObject({ ok: false });
  });

  it('never exposes the password in the health check', async () => {
    const health = await createNeonConnection('web-time-tracker', CONFIG).healthCheck();
    expect(health).toEqual({
      name: 'web-time-tracker',
      kind: 'neon',
      ok: true,
      detail: 'tracker_sync@ep-cool-river-123/neondb (read-only)',
    });
    expect(JSON.stringify(health)).not.toContain('s3cret');
  });

  it('sends one read-only batch, led by the statement timeout, with text params', async () => {
    const fetchFn = jest.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ results: [{ rows: [{ set_config: '15000' }] }, { rows: [{ n: 1 }] }, { rows: [] }] }),
    );
    const conn = createNeonConnection('web-time-tracker', CONFIG, { fetchFn: fetchFn as unknown as typeof fetch });

    const result = await conn.get().read([
      { query: 'select $1::int as n, $2::date, $3::text', params: [1, '2026-11-18', null] },
      { query: 'select 2' },
    ]);
    expect(result).toEqual([[{ n: 1 }], []]);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.eu-central-1.aws.neon.tech/sql');
    expect(init?.headers).toMatchObject({
      'Neon-Connection-String': URL_OK,
      'Neon-Batch-Read-Only': 'true',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      queries: [
        { query: "select set_config('statement_timeout', $1, true)", params: [String(STATEMENT_TIMEOUT_MS)] },
        { query: 'select $1::int as n, $2::date, $3::text', params: ['1', '2026-11-18', null] },
        { query: 'select 2', params: [] },
      ],
    });
  });

  it('skips the network for an empty batch', async () => {
    const fetchFn = jest.fn();
    const conn = createNeonConnection('web-time-tracker', CONFIG, { fetchFn: fetchFn as unknown as typeof fetch });
    expect(await conn.get().read([])).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('surfaces the Postgres error message', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse({ message: 'cannot execute INSERT in a read-only transaction', code: '25006' }, false, 400),
    );
    const conn = createNeonConnection('web-time-tracker', CONFIG, { fetchFn: fetchFn as unknown as typeof fetch });
    await expect(conn.get().read([{ query: 'insert into devices default values' }])).rejects.toThrow(
      'Neon 400: cannot execute INSERT in a read-only transaction',
    );
  });

  it('wraps network failures', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const conn = createNeonConnection('web-time-tracker', CONFIG, { fetchFn: fetchFn as unknown as typeof fetch });
    await expect(conn.get().read([{ query: 'select 1' }])).rejects.toThrow('Could not reach Neon: ECONNREFUSED');
  });
});
