import { jest } from '@jest/globals';
import { createGoogleCalendarConnection } from './google-calendar.js';

const CONFIG = {
  refreshToken: 'refresh-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  baseUrl: 'https://www.googleapis.com/calendar/v3',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('createGoogleCalendarConnection', () => {
  it('is inert when unconfigured', () => {
    const conn = createGoogleCalendarConnection({ ...CONFIG, refreshToken: '' });
    expect(conn.maybe()).toBeUndefined();
    expect(() => conn.get()).toThrow(/not configured/);
  });

  it('exchanges the refresh token for an access token, then calls the API with it', async () => {
    const fetchFn = jest.fn(async (url: string, _init?: RequestInit) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'tok-1', expires_in: 3600 });
      }
      return jsonResponse({ items: [{ id: 'primary', summary: 'Home' }] });
    });
    const conn = createGoogleCalendarConnection(CONFIG, { fetchFn: fetchFn as unknown as typeof fetch });

    const result = (await conn.get().get('/users/me/calendarList')) as { items: unknown[] };
    expect(result.items).toHaveLength(1);

    const [, apiCallArgs] = fetchFn.mock.calls[1];
    expect(apiCallArgs?.headers).toMatchObject({ Authorization: 'Bearer tok-1' });
  });

  it('caches the access token across calls until it nears expiry', async () => {
    let now = 0;
    const fetchFn = jest.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: `tok-${now}`, expires_in: 3600 });
      }
      return jsonResponse({});
    });
    const conn = createGoogleCalendarConnection(CONFIG, {
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => now,
    });

    await conn.get().get('/users/me/calendarList');
    await conn.get().get('/users/me/calendarList');
    expect(fetchFn.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token')).toHaveLength(1);

    now = 3600_000; // past expiry
    await conn.get().get('/users/me/calendarList');
    expect(fetchFn.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token')).toHaveLength(2);
  });

  it('throws with status and body detail on a failed API call', async () => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'tok-1', expires_in: 3600 });
      }
      return jsonResponse({ error: 'not found' }, false, 404);
    });
    const conn = createGoogleCalendarConnection(CONFIG, { fetchFn: fetchFn as unknown as typeof fetch });

    await expect(conn.get().get('/calendars/primary/events/missing')).rejects.toThrow(/404/);
  });

  it('healthCheck reports not configured when disabled', async () => {
    const conn = createGoogleCalendarConnection({ ...CONFIG, clientId: '' });
    const health = await conn.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toMatch(/not configured/);
  });
});
