import type { GoogleCalendarClient } from '../../connections/google-calendar.js';
import type { HevyClient } from '../../connections/hevy.js';
import type { YnabClient } from '../../connections/ynab.js';
import {
  gcalCreateEvent,
  gcalDeleteEvent,
  gcalFreeBusy,
  gcalGetEvent,
  gcalListCalendars,
  gcalListEvents,
  gcalUpdateEvent,
  hevyActivityByMuscle,
  hevyRecentActivity,
  ynabCategories,
  ynabCreateTransaction,
  ynabReport,
  ynabTransactions,
} from './tools.js';

/** Fake YNAB client: canned responses per endpoint, records calls for assertions. */
function fakeYnab(responses: Record<string, unknown>): YnabClient & {
  calls: { method: string; endpoint: string; params?: unknown; body?: unknown }[];
} {
  const calls: { method: string; endpoint: string; params?: unknown; body?: unknown }[] = [];
  const lookup = (endpoint: string): unknown => {
    if (!(endpoint in responses)) {
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    }
    return responses[endpoint];
  };
  return {
    calls,
    async get(endpoint, params) {
      calls.push({ method: 'GET', endpoint, params });
      return lookup(endpoint);
    },
    async post(endpoint, body) {
      calls.push({ method: 'POST', endpoint, body });
      return lookup(endpoint);
    },
  };
}

describe('ynabTransactions', () => {
  const transactions = [
    {
      id: 't1',
      date: '2026-07-01',
      amount: -12340,
      payee_name: 'Cafe',
      category_name: 'Dining',
      account_name: 'Checking',
      memo: null,
      approved: true,
      cleared: 'cleared',
      deleted: false,
      subtransactions: [{ id: 'sub1' }],
      import_id: 'abc',
    },
  ];

  it('requires since_date for budget-wide listings', async () => {
    const client = fakeYnab({});
    await expect(ynabTransactions(client, {})).rejects.toThrow('sinceDate is required');
    expect(client.calls).toHaveLength(0);
  });

  it('returns the compact view by default and passes filters through', async () => {
    const client = fakeYnab({
      '/budgets/last-used/transactions': { data: { transactions } },
    });
    const result = (await ynabTransactions(client, {
      sinceDate: '2026-07-01',
      type: 'unapproved',
    })) as Record<string, unknown>[];
    expect(client.calls[0].params).toEqual({ since_date: '2026-07-01', type: 'unapproved' });
    expect(result).toHaveLength(1);
    expect(result[0].payee_name).toBe('Cafe');
    expect(result[0]).not.toHaveProperty('subtransactions');
    expect(result[0]).not.toHaveProperty('import_id');
  });

  it('returns full objects when verbose', async () => {
    const client = fakeYnab({
      '/budgets/last-used/transactions': { data: { transactions } },
    });
    const result = (await ynabTransactions(client, {
      sinceDate: '2026-07-01',
      verbose: true,
    })) as Record<string, unknown>[];
    expect(result[0]).toHaveProperty('subtransactions');
  });

  it('scopes to an account without requiring since_date', async () => {
    const client = fakeYnab({
      '/budgets/b1/accounts/a1/transactions': { data: { transactions: [] } },
    });
    await ynabTransactions(client, { budgetId: 'b1', accountId: 'a1' });
    expect(client.calls[0].endpoint).toBe('/budgets/b1/accounts/a1/transactions');
  });

  it('fetches a single transaction by id', async () => {
    const client = fakeYnab({
      '/budgets/last-used/transactions/t1': { data: { transaction: transactions[0] } },
    });
    const result = (await ynabTransactions(client, { transactionId: 't1' })) as Record<
      string,
      unknown
    >;
    expect(result.id).toBe('t1');
  });
});

describe('ynabCreateTransaction', () => {
  it('posts the transaction envelope and unwraps the response', async () => {
    const client = fakeYnab({
      '/budgets/last-used/transactions': { data: { transaction: { id: 'new1' } } },
    });
    const result = (await ynabCreateTransaction(client, {
      accountId: 'a1',
      date: '2026-07-19',
      amount: -5000,
      payeeName: 'Store',
    })) as Record<string, unknown>;
    expect(client.calls[0]).toMatchObject({
      method: 'POST',
      body: {
        transaction: { account_id: 'a1', date: '2026-07-19', amount: -5000, payee_name: 'Store' },
      },
    });
    expect(result.id).toBe('new1');
  });
});

describe('ynabCategories', () => {
  it('lists category groups by default', async () => {
    const client = fakeYnab({
      '/budgets/last-used/categories': { data: { category_groups: [{ name: 'Bills' }] } },
    });
    expect(await ynabCategories(client, {})).toEqual([{ name: 'Bills' }]);
  });

  it('scopes one category to a month', async () => {
    const client = fakeYnab({
      '/budgets/last-used/months/2026-07-01/categories/c1': {
        data: { category: { id: 'c1', goal_percentage_complete: 40 } },
      },
    });
    const result = (await ynabCategories(client, {
      categoryId: 'c1',
      month: '2026-07-01',
    })) as Record<string, unknown>;
    expect(result.goal_percentage_complete).toBe(40);
  });
});

describe('ynabReport', () => {
  const accounts = [
    { name: 'Checking', type: 'checking', balance: 1_500_000, closed: false },
    { name: 'Visa', type: 'creditCard', balance: -250_000, closed: false },
    { name: 'Old', type: 'checking', balance: 999_000, closed: true },
  ];

  it('computes net worth in currency units, skipping closed accounts', async () => {
    const client = fakeYnab({ '/budgets/last-used/accounts': { data: { accounts } } });
    const result = (await ynabReport(client, { kind: 'net_worth' })) as Record<string, unknown>;
    expect(result.total_assets).toBe(1500);
    expect(result.total_liabilities).toBe(-250);
    expect(result.net_worth).toBe(1250);
    expect((result.account_breakdown as unknown[]).length).toBe(2);
  });

  it('computes a monthly summary with savings rate and top categories', async () => {
    const client = fakeYnab({
      '/budgets/last-used/months/current': {
        data: {
          month: {
            income: 4_000_000,
            activity: -3_000_000,
            budgeted: 3_500_000,
            categories: [
              { name: 'Rent', activity: -2_000_000, budgeted: 2_000_000, balance: 0 },
              { name: 'Dining', activity: -1_000_000, budgeted: 500_000, balance: -500_000 },
              { name: 'Refund', activity: 50_000 },
              { name: 'Gone', activity: -10_000, deleted: true },
            ],
          },
        },
      },
    });
    const result = (await ynabReport(client, { kind: 'monthly_summary' })) as Record<
      string,
      unknown
    >;
    expect(result.income).toBe(4000);
    expect(result.spending).toBe(3000);
    expect(result.savings_rate).toBe(25);
    const top = result.top_categories as { name: string }[];
    expect(top.map(category => category.name)).toEqual(['Rent', 'Dining']);
  });

  it('builds the full report with newest-first history', async () => {
    const client = fakeYnab({
      '/budgets/last-used/accounts': { data: { accounts } },
      '/budgets/last-used/months/current': { data: { month: { income: 0, activity: 0 } } },
      '/budgets/last-used/months': {
        data: {
          months: [
            { month: '2026-05-01', income: 1_000_000, activity: -800_000 },
            { month: '2026-07-01', income: 1_000_000, activity: -500_000 },
            { month: '2026-06-01', income: 1_000_000, activity: -900_000 },
            { month: '2026-04-01', income: 1_000_000, activity: -100_000 },
          ],
        },
      },
    });
    const result = (await ynabReport(client, { kind: 'full', monthsBack: 2 })) as Record<
      string,
      unknown
    >;
    const history = result.monthly_history as { month: string; net_savings: number }[];
    expect(history.map(entry => entry.month)).toEqual(['2026-07', '2026-06']);
    expect(history[0].net_savings).toBe(500);
    expect(result.net_worth).toMatchObject({ net_worth: 1250 });
  });
});

/** Fake Hevy client serving paginated workouts and templates. */
function fakeHevy(opts: {
  workoutPages: unknown[][];
  templates?: unknown[];
}): HevyClient {
  return {
    async get(endpoint, params) {
      const page = Number(params?.page ?? '1');
      if (endpoint === '/v1/workouts') {
        return {
          workouts: opts.workoutPages[page - 1] ?? [],
          page_count: opts.workoutPages.length,
        };
      }
      if (endpoint === '/v1/exercise_templates') {
        return { exercise_templates: page === 1 ? (opts.templates ?? []) : [], page_count: 1 };
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
  };
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe('hevyRecentActivity', () => {
  it('aggregates working sets and volume, excluding warmups and old workouts', async () => {
    const client = fakeHevy({
      workoutPages: [
        [
          {
            title: 'Push',
            start_time: daysAgo(2),
            end_time: daysAgo(2),
            exercises: [
              {
                title: 'Bench Press',
                sets: [
                  { type: 'warmup', weight_kg: 40, reps: 10 },
                  { type: 'normal', weight_kg: 80, reps: 5 },
                  { type: 'normal', weight_kg: 80, reps: 5 },
                ],
              },
            ],
          },
        ],
        // Second page is older than the window; pagination must stop there.
        [{ title: 'Ancient', start_time: daysAgo(400), exercises: [] }],
      ],
    });
    const result = (await hevyRecentActivity(client, { days: 14 })) as Record<string, unknown>;
    expect(result.total_workouts).toBe(1);
    expect(result.total_working_sets).toBe(2);
    expect(result.total_volume_kg).toBe(800);
    const sessions = result.sessions as { exercises: string[] }[];
    expect(sessions[0].exercises).toEqual(['Bench Press']);
  });
});

describe('hevyActivityByMuscle', () => {
  it('maps exercises to primary and secondary muscle groups via templates', async () => {
    const client = fakeHevy({
      workoutPages: [
        [
          {
            title: 'Push',
            start_time: daysAgo(1),
            exercises: [
              {
                title: 'Bench Press',
                exercise_template_id: 'tmpl-bench',
                sets: [{ type: 'normal', weight_kg: 100, reps: 5 }],
              },
            ],
          },
        ],
      ],
      templates: [
        {
          id: 'tmpl-bench',
          title: 'Bench Press',
          primary_muscle_group: 'chest',
          secondary_muscle_groups: ['triceps', 'shoulders'],
        },
      ],
    });
    const result = (await hevyActivityByMuscle(client, { days: 7 })) as Record<string, unknown>;
    const groups = result.muscle_groups as {
      muscle_group: string;
      as_primary: number;
      as_secondary: number;
      total_volume_kg: number;
    }[];
    expect(groups.map(group => group.muscle_group)).toEqual(['chest', 'triceps', 'shoulders']);
    expect(groups[0]).toMatchObject({ as_primary: 1, as_secondary: 0, total_volume_kg: 500 });
    expect(groups[1]).toMatchObject({ as_primary: 0, as_secondary: 1 });
  });

  it('falls back to the "other" group for unknown templates', async () => {
    const client = fakeHevy({
      workoutPages: [
        [
          {
            title: 'Mystery',
            start_time: daysAgo(1),
            exercises: [
              {
                title: 'Unknown Movement',
                exercise_template_id: 'missing',
                sets: [{ type: 'normal', weight_kg: 10, reps: 10 }],
              },
            ],
          },
        ],
      ],
    });
    const result = (await hevyActivityByMuscle(client, {})) as Record<string, unknown>;
    const groups = result.muscle_groups as { muscle_group: string }[];
    expect(groups.map(group => group.muscle_group)).toEqual(['other']);
  });
});

/** Fake Google Calendar client: canned responses per (method, path), records calls for assertions. */
function fakeGcal(responses: Record<string, unknown>): GoogleCalendarClient & {
  calls: { method: string; path: string; params?: unknown; body?: unknown }[];
} {
  const calls: { method: string; path: string; params?: unknown; body?: unknown }[] = [];
  const lookup = (path: string): unknown => {
    if (!(path in responses)) {
      throw new Error(`Unexpected path: ${path}`);
    }
    return responses[path];
  };
  return {
    calls,
    async get(path, params) {
      calls.push({ method: 'GET', path, params });
      return lookup(path);
    },
    async post(path, body, params) {
      calls.push({ method: 'POST', path, params, body });
      return lookup(path);
    },
    async patch(path, body, params) {
      calls.push({ method: 'PATCH', path, params, body });
      return lookup(path);
    },
    async delete(path, params) {
      calls.push({ method: 'DELETE', path, params });
      return lookup(path);
    },
  };
}

describe('gcalListCalendars', () => {
  it('paginates and normalizes calendar list entries', async () => {
    const client = fakeGcal({
      '/users/me/calendarList': {
        items: [{ id: 'primary', summary: 'Home', primary: true, accessRole: 'owner' }],
      },
    });
    const result = (await gcalListCalendars(client, {})) as { calendars: Record<string, unknown>[] };
    expect(result.calendars).toEqual([
      {
        id: 'primary',
        summary: 'Home',
        description: undefined,
        time_zone: undefined,
        access_role: 'owner',
        primary: true,
        background_color: undefined,
      },
    ]);
  });
});

describe('gcalListEvents', () => {
  it('defaults to the primary calendar and formats events', async () => {
    const client = fakeGcal({
      '/calendars/primary/events': {
        items: [
          {
            id: 'e1',
            summary: 'Standup',
            start: { dateTime: '2026-07-22T10:00:00Z' },
            end: { dateTime: '2026-07-22T10:30:00Z' },
          },
        ],
      },
    });
    const result = (await gcalListEvents(client, {})) as { calendar_id: string; events: Record<string, unknown>[] };
    expect(result.calendar_id).toBe('primary');
    expect(result.events[0]).toMatchObject({
      id: 'e1',
      summary: 'Standup',
      start: '2026-07-22T10:00:00Z',
      all_day: false,
    });
  });

  it('URL-encodes calendar ids like email addresses', async () => {
    const client = fakeGcal({ '/calendars/me%40example.com/events': { items: [] } });
    await gcalListEvents(client, { calendarId: 'me@example.com' });
    expect(client.calls[0].path).toBe('/calendars/me%40example.com/events');
  });

  it('marks all-day events from a date-only start', async () => {
    const client = fakeGcal({
      '/calendars/primary/events': {
        items: [{ id: 'e2', summary: 'Holiday', start: { date: '2026-07-22' }, end: { date: '2026-07-23' } }],
      },
    });
    const result = (await gcalListEvents(client, {})) as { events: Record<string, unknown>[] };
    expect(result.events[0]).toMatchObject({ all_day: true, start: '2026-07-22' });
  });
});

describe('gcalGetEvent', () => {
  it('fetches and formats a single event', async () => {
    const client = fakeGcal({
      '/calendars/primary/events/e1': { id: 'e1', summary: 'Standup', start: {}, end: {} },
    });
    const result = (await gcalGetEvent(client, { eventId: 'e1' })) as Record<string, unknown>;
    expect(result.id).toBe('e1');
  });
});

describe('gcalCreateEvent', () => {
  it('builds a timed event body with the given timezone', async () => {
    const client = fakeGcal({
      '/calendars/primary/events': { id: 'new1', summary: 'Sync', start: {}, end: {} },
    });
    await gcalCreateEvent(client, {
      summary: 'Sync',
      start: '2026-07-22T10:00:00',
      end: '2026-07-22T10:30:00',
      timezone: 'America/New_York',
      attendees: ['a@example.com'],
    });
    expect(client.calls[0]).toMatchObject({
      method: 'POST',
      body: {
        summary: 'Sync',
        start: { dateTime: '2026-07-22T10:00:00', timeZone: 'America/New_York' },
        end: { dateTime: '2026-07-22T10:30:00', timeZone: 'America/New_York' },
        attendees: [{ email: 'a@example.com' }],
      },
    });
  });

  it('builds an all-day event body without timeZone', async () => {
    const client = fakeGcal({
      '/calendars/primary/events': { id: 'new2', summary: 'Vacation', start: {}, end: {} },
    });
    await gcalCreateEvent(client, {
      summary: 'Vacation',
      start: '2026-07-22',
      end: '2026-07-23',
      allDay: true,
    });
    expect(client.calls[0]).toMatchObject({
      body: { start: { date: '2026-07-22' }, end: { date: '2026-07-23' } },
    });
  });

  it('passes sendUpdates=all only when send_notifications is set', async () => {
    const client = fakeGcal({
      '/calendars/primary/events': { id: 'new3', summary: 'Sync', start: {}, end: {} },
    });
    await gcalCreateEvent(client, {
      summary: 'Sync',
      start: '2026-07-22T10:00:00',
      end: '2026-07-22T10:30:00',
      sendNotifications: true,
    });
    expect(client.calls[0].params).toEqual({ sendUpdates: 'all' });
  });
});

describe('gcalUpdateEvent', () => {
  it('only includes provided fields, inferring dateTime vs date from "T"', async () => {
    const client = fakeGcal({
      '/calendars/primary/events/e1': { id: 'e1', summary: 'New title', start: {}, end: {} },
    });
    await gcalUpdateEvent(client, { eventId: 'e1', summary: 'New title', start: '2026-07-23' });
    expect(client.calls[0]).toMatchObject({
      method: 'PATCH',
      body: { summary: 'New title', start: { date: '2026-07-23' } },
    });
    expect(client.calls[0].body).not.toHaveProperty('end');
  });
});

describe('gcalDeleteEvent', () => {
  it('deletes and returns a confirmation', async () => {
    const client = fakeGcal({ '/calendars/primary/events/e1': {} });
    const result = await gcalDeleteEvent(client, { eventId: 'e1' });
    expect(result).toEqual({ deleted: true, event_id: 'e1' });
    expect(client.calls[0]).toMatchObject({ method: 'DELETE' });
  });
});

describe('gcalFreeBusy', () => {
  it('defaults to the primary calendar and normalizes busy blocks', async () => {
    const client = fakeGcal({
      '/freeBusy': {
        calendars: { primary: { busy: [{ start: '2026-07-22T09:00:00Z', end: '2026-07-22T10:00:00Z' }] } },
      },
    });
    const result = (await gcalFreeBusy(client, {
      timeMin: '2026-07-22T00:00:00Z',
      timeMax: '2026-07-23T00:00:00Z',
    })) as { calendars: Record<string, { busy: unknown[] }> };
    expect(client.calls[0].body).toMatchObject({ items: [{ id: 'primary' }] });
    expect(result.calendars.primary.busy).toHaveLength(1);
  });
});
