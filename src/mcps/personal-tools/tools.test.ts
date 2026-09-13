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
  hevyBodyMeasurements,
  hevyGetWorkout,
  hevyRecentActivity,
  hevyRoutines,
  hevySearchExerciseCatalog,
  hevyWriteRoutine,
  ynabAssign,
  ynabCategories,
  ynabLookup,
  ynabOverview,
  ynabReport,
  ynabTransactions,
  ynabWriteCategory,
  ynabWriteTransaction,
} from './tools.js';
import { followingMonth, monthIso } from './ynab-payloads.js';

/**
 * Fake YNAB client: canned responses per endpoint, records calls for assertions.
 * GETs are strict (an unlisted endpoint throws); writes fall back to an empty
 * envelope so tests can focus on the recorded method/endpoint/body.
 */
function fakeYnab(responses: Record<string, unknown> = {}): YnabClient & {
  calls: { method: string; endpoint: string; params?: unknown; body?: unknown }[];
} {
  const calls: { method: string; endpoint: string; params?: unknown; body?: unknown }[] = [];
  const lookup = (endpoint: string, fallback?: unknown): unknown => {
    if (endpoint in responses) {
      return responses[endpoint];
    }
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
  return {
    calls,
    async get(endpoint, params) {
      calls.push({ method: 'GET', endpoint, params });
      return lookup(endpoint);
    },
    async post(endpoint, body) {
      calls.push({ method: 'POST', endpoint, body });
      return lookup(endpoint, { data: {} });
    },
    async put(endpoint, body) {
      calls.push({ method: 'PUT', endpoint, body });
      return lookup(endpoint, { data: {} });
    },
    async patch(endpoint, body) {
      calls.push({ method: 'PATCH', endpoint, body });
      return lookup(endpoint, { data: {} });
    },
    async delete(endpoint) {
      calls.push({ method: 'DELETE', endpoint });
      return lookup(endpoint, { data: {} });
    },
  };
}

/** Category groups as `GET /plans/{id}/categories` returns them (current-month numbers). */
const CATEGORY_GROUPS = {
  data: {
    category_groups: [
      {
        id: 'g1',
        name: 'Essentials',
        hidden: false,
        deleted: false,
        categories: [
          {
            id: 'c1',
            name: 'Groceries',
            category_group_id: 'g1',
            budgeted: 300000,
            activity: -180000,
            balance: 120000,
            hidden: false,
            deleted: false,
            goal_type: 'NEED',
            goal_target: 400000,
            goal_under_funded: 100000,
            goal_percentage_complete: 75,
          },
          {
            id: 'c2',
            name: 'Dining Out',
            category_group_id: 'g1',
            budgeted: 100000,
            activity: -145250,
            balance: -45250,
            hidden: false,
            deleted: false,
          },
        ],
      },
      {
        id: 'g2',
        name: 'Internal Master Category',
        hidden: false,
        deleted: false,
        categories: [
          {
            id: 'c9',
            name: 'Inflow: Ready to Assign',
            category_group_id: 'g2',
            budgeted: 0,
            activity: 0,
            balance: 0,
            hidden: false,
            deleted: false,
          },
        ],
      },
      {
        id: 'g3',
        name: 'Someday',
        hidden: true,
        deleted: false,
        categories: [
          {
            id: 'c8',
            name: 'Sabbatical',
            category_group_id: 'g3',
            budgeted: 0,
            activity: 0,
            balance: 0,
            hidden: true,
            deleted: false,
          },
        ],
      },
    ],
  },
};

function monthResponse(month: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      month: {
        month,
        income: 3200000,
        budgeted: 3100000,
        activity: -1850000,
        to_be_budgeted: 0,
        age_of_money: 34,
        categories: [
          {
            id: 'c1',
            name: 'Groceries',
            category_group_id: 'g1',
            budgeted: 300000,
            activity: -180000,
            balance: 120000,
            hidden: false,
            deleted: false,
          },
          {
            id: 'c2',
            name: 'Dining Out',
            category_group_id: 'g1',
            budgeted: 100000,
            activity: -145250,
            balance: -45250,
            hidden: false,
            deleted: false,
          },
        ],
        ...overrides,
      },
    },
  };
}

const ACCOUNTS = {
  data: {
    accounts: [
      {
        id: 'a1',
        name: 'Checking',
        type: 'checking',
        balance: 1500000,
        on_budget: true,
        transfer_payee_id: 'tp1',
        closed: false,
        deleted: false,
      },
      {
        id: 'a2',
        name: 'Visa',
        type: 'creditCard',
        balance: -250000,
        on_budget: true,
        transfer_payee_id: 'tp2',
        closed: false,
        deleted: false,
      },
      {
        id: 'a3',
        name: 'Old savings',
        type: 'savings',
        balance: 99000,
        on_budget: false,
        closed: true,
        deleted: false,
      },
    ],
  },
};

describe('ynabOverview', () => {
  const nextIso = followingMonth(monthIso(undefined));

  it('answers budget health in one shot: RTA, month-ahead, overspending, upcoming bills', async () => {
    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const client = fakeYnab({
      '/plans/last-used/months/current': monthResponse('2026-09-01'),
      [`/plans/last-used/months/${nextIso}`]: monthResponse(nextIso, {
        to_be_budgeted: 420500,
        budgeted: 2980500,
        categories: [
          {
            id: 'c1',
            name: 'Groceries',
            category_group_id: 'g1',
            budgeted: 280000,
            activity: 0,
            balance: 280000,
            hidden: false,
            deleted: false,
            goal_type: 'NEED',
            goal_under_funded: 120000,
          },
          {
            id: 'c2',
            name: 'Dining Out',
            category_group_id: 'g1',
            budgeted: 100000,
            activity: 0,
            balance: 100000,
            hidden: false,
            deleted: false,
            goal_type: 'NEED',
            goal_under_funded: 0,
          },
        ],
      }),
      '/plans/last-used/scheduled_transactions': {
        data: {
          scheduled_transactions: [
            {
              id: 's1',
              date_next: soon,
              frequency: 'monthly',
              amount: -1200000,
              payee_name: 'Landlord',
              category_name: 'Rent',
              deleted: false,
            },
            {
              id: 's2',
              date_next: '2099-01-01',
              frequency: 'yearly',
              amount: -50000,
              payee_name: 'Domain registrar',
              deleted: false,
            },
          ],
        },
      },
    });

    const result = (await ynabOverview(client, {})) as Record<string, unknown>;
    expect(result).toMatchObject({
      month: '2026-09',
      ready_to_assign: { this_month: 0, next_month: 420.5 },
      age_of_money: 34,
      income: 3200,
      assigned: 3100,
      activity: -1850,
      month_ahead: {
        fully_funded: false,
        underfunded_total: 120,
        underfunded: [{ category: 'Groceries', needed: 120 }],
      },
      overspent: [{ category: 'Dining Out', overspent_by: 45.25 }],
    });
    const upcoming = result.upcoming_scheduled as { payee_name: string }[];
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].payee_name).toBe('Landlord');
    expect((result.alerts as string[]).length).toBeGreaterThan(0);
  });

  it('degrades when the following month is not materialized yet', async () => {
    const client = fakeYnab({
      '/plans/last-used/months/current': monthResponse('2026-09-01'),
    });
    const result = (await ynabOverview(client, {})) as Record<string, unknown>;
    expect(result.month).toBe('2026-09');
    expect(result.month_ahead).toBeUndefined();
    expect(result.ready_to_assign).toEqual({ this_month: 0 });
  });
});

describe('ynabTransactions', () => {
  const transactions = {
    data: {
      transactions: [
        {
          id: 't1',
          date: '2026-07-01',
          amount: -12340,
          payee_name: 'Cafe',
          category_name: 'Dining Out',
          account_name: 'Checking',
          memo: null,
          approved: true,
          cleared: 'cleared',
          deleted: false,
          import_id: 'YNAB:-12340:2026-07-01:1',
          subtransactions: [],
        },
        {
          id: 't2',
          date: '2026-07-03',
          amount: 500000,
          payee_name: 'Employer',
          category_name: 'Inflow: Ready to Assign',
          account_name: 'Checking',
          approved: true,
          cleared: 'cleared',
          deleted: false,
        },
      ],
    },
  };

  it('requires since_date for budget-wide listings, before any request', async () => {
    const client = fakeYnab();
    await expect(ynabTransactions(client, {})).rejects.toThrow(/since_date is required/);
    expect(client.calls).toHaveLength(0);
  });

  it('returns a compact currency-unit view, newest first', async () => {
    const client = fakeYnab({ '/plans/last-used/transactions': transactions });
    const result = (await ynabTransactions(client, { sinceDate: '2026-07-01' })) as Record<
      string,
      unknown
    >[];
    expect(result.map(txn => txn.id)).toEqual(['t2', 't1']);
    expect(result[1]).toEqual({
      id: 't1',
      date: '2026-07-01',
      amount: -12.34,
      payee_name: 'Cafe',
      category_name: 'Dining Out',
      account_name: 'Checking',
      approved: true,
      cleared: 'cleared',
    });
    expect(client.calls[0].params).toMatchObject({ since_date: '2026-07-01' });
  });

  it('scopes to an account by name, resolving the id first', async () => {
    const client = fakeYnab({
      '/plans/last-used/accounts': ACCOUNTS,
      '/plans/last-used/accounts/a1/transactions': transactions,
    });
    await ynabTransactions(client, { account: 'checking' });
    expect(client.calls.map(call => call.endpoint)).toEqual([
      '/plans/last-used/accounts',
      '/plans/last-used/accounts/a1/transactions',
    ]);
  });

  it('applies limit and honours verbose', async () => {
    const client = fakeYnab({ '/plans/last-used/transactions': transactions });
    const result = (await ynabTransactions(client, {
      sinceDate: '2026-07-01',
      limit: 1,
      verbose: true,
    })) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t2');
    expect(result[0].import_id).toBeUndefined(); // t2 has none; raw objects pass through
    expect(result[0].cleared).toBe('cleared');
  });
});

describe('ynabCategories', () => {
  it('lists groups compactly, skipping hidden and housekeeping groups', async () => {
    const client = fakeYnab({ '/plans/last-used/categories': CATEGORY_GROUPS });
    const result = (await ynabCategories(client, {})) as Record<string, unknown>[];
    expect(result).toHaveLength(1);
    expect(result[0].group).toBe('Essentials');
    const categories = result[0].categories as Record<string, unknown>[];
    expect(categories[0]).toEqual({
      id: 'c1',
      name: 'Groceries',
      assigned: 300,
      activity: -180,
      available: 120,
      target: { type: 'NEED', target: 400, under_funded: 100, pct: 75 },
    });
  });

  it('fetches one category by name, month-scoped', async () => {
    const client = fakeYnab({
      '/plans/last-used/categories': CATEGORY_GROUPS,
      '/plans/last-used/months/current/categories/c1': {
        data: {
          category: {
            id: 'c1',
            name: 'Groceries',
            category_group_name: 'Essentials',
            budgeted: 300000,
            activity: -180000,
            balance: 120000,
            goal_type: 'NEED',
            goal_target: 400000,
            goal_under_funded: 100000,
            goal_overall_funded: 300000,
          },
        },
      },
    });
    const result = (await ynabCategories(client, { category: 'grocer' })) as Record<
      string,
      unknown
    >;
    expect(result.name).toBe('Groceries');
    expect(result.category_group_name).toBe('Essentials');
    expect(result.target).toMatchObject({ type: 'NEED', target: 400, overall_funded: 300 });
  });
});

describe('ynabLookup', () => {
  it('lists budgets compactly', async () => {
    const client = fakeYnab({
      '/plans': {
        data: {
          plans: [{ id: 'b1', name: 'Main', last_modified_on: '2026-09-01T00:00:00Z', extra: 1 }],
        },
      },
    });
    expect(await ynabLookup(client, { entity: 'budgets' })).toEqual([
      { id: 'b1', name: 'Main', last_modified_on: '2026-09-01T00:00:00Z' },
    ]);
  });

  it('lists open accounts with transfer payees, hiding closed ones', async () => {
    const client = fakeYnab({ '/plans/last-used/accounts': ACCOUNTS });
    const result = (await ynabLookup(client, { entity: 'accounts' })) as Record<
      string,
      unknown
    >[];
    expect(result.map(account => account.name)).toEqual(['Checking', 'Visa']);
    expect(result[0]).toMatchObject({ balance: 1500, transfer_payee_id: 'tp1' });
  });

  it('sorts scheduled transactions by next date', async () => {
    const client = fakeYnab({
      '/plans/last-used/scheduled_transactions': {
        data: {
          scheduled_transactions: [
            { id: 's2', date_next: '2026-10-01', frequency: 'monthly', amount: -50000, deleted: false },
            { id: 's1', date_next: '2026-09-15', frequency: 'monthly', amount: -1200000, deleted: false },
          ],
        },
      },
    });
    const result = (await ynabLookup(client, { entity: 'scheduled' })) as Record<
      string,
      unknown
    >[];
    expect(result.map(txn => txn.id)).toEqual(['s1', 's2']);
    expect(result[0].amount).toBe(-1200);
  });
});

describe('ynabAssign', () => {
  const month = monthResponse('2026-09-01', { to_be_budgeted: 500000 });

  it('sets and adjusts in one call, PATCHing absolute milliunit amounts', async () => {
    const client = fakeYnab({ '/plans/last-used/months/current': month });
    const result = await ynabAssign(client, {
      assignments: [
        { category: 'Groceries', set: '$400' },
        { category: 'Dining', adjust: -50 },
      ],
    });
    const patches = client.calls.filter(call => call.method === 'PATCH');
    expect(patches).toEqual([
      {
        method: 'PATCH',
        endpoint: '/plans/last-used/months/current/categories/c1',
        body: { category: { budgeted: 400000 } },
      },
      {
        method: 'PATCH',
        endpoint: '/plans/last-used/months/current/categories/c2',
        body: { category: { budgeted: 50000 } },
      },
    ]);
    expect(result).toEqual({
      month: '2026-09',
      changes: [
        { category: 'Groceries', before: 300, after: 400 },
        { category: 'Dining Out', before: 100, after: 50 },
      ],
      ready_to_assign_projected: 450,
    });
  });

  it('dry_run previews the requests without writing', async () => {
    const client = fakeYnab({ '/plans/last-used/months/current': month });
    const result = (await ynabAssign(client, {
      assignments: [{ category: 'Groceries', set: 400 }],
      dryRun: true,
    })) as Record<string, unknown>;
    expect(result.dry_run).toBe(true);
    expect(result.requests).toHaveLength(1);
    expect(client.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('refuses ambiguous names with the candidates listed', async () => {
    const client = fakeYnab({ '/plans/last-used/months/current': month });
    await expect(
      ynabAssign(client, { assignments: [{ category: 'o', set: 1 }] }),
    ).rejects.toThrow(/ambiguous.*Groceries.*Dining Out/s);
    expect(client.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('targets next month for the one-month-ahead move', async () => {
    const nextIso = followingMonth(monthIso(undefined));
    const client = fakeYnab({ [`/plans/last-used/months/${nextIso}`]: month });
    await ynabAssign(client, {
      month: 'next',
      assignments: [{ category: 'Groceries', set: 400 }],
    });
    expect(client.calls[1].endpoint).toBe(`/plans/last-used/months/${nextIso}/categories/c1`);
  });
});

describe('ynabWriteTransaction', () => {
  it('creates with names resolved and a human amount parsed', async () => {
    const client = fakeYnab({
      '/plans/last-used/accounts': ACCOUNTS,
      '/plans/last-used/categories': CATEGORY_GROUPS,
      '/plans/last-used/transactions': {
        data: {
          transaction: {
            id: 't9',
            date: '2026-09-10',
            amount: -45000,
            payee_name: 'Cafe',
            category_name: 'Dining Out',
            account_name: 'Checking',
            approved: false,
            cleared: 'uncleared',
          },
        },
      },
    });
    const result = await ynabWriteTransaction(client, {
      account: 'Checking',
      date: '2026-09-10',
      amount: '-$45',
      payee: 'Cafe',
      category: 'Dining',
    });
    const post = client.calls.find(call => call.method === 'POST');
    expect(post?.endpoint).toBe('/plans/last-used/transactions');
    expect(post?.body).toEqual({
      transaction: {
        account_id: 'a1',
        date: '2026-09-10',
        amount: -45000,
        payee_name: 'Cafe',
        category_id: 'c2',
      },
    });
    expect(result).toMatchObject({ record_type: 'transaction' });
  });

  it('routes a future date to the scheduled endpoints', async () => {
    const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const client = fakeYnab({
      '/plans/last-used/accounts': ACCOUNTS,
      '/plans/last-used/scheduled_transactions': {
        data: { scheduled_transaction: { id: 's9', date_next: future, amount: -45000, deleted: false } },
      },
    });
    const result = await ynabWriteTransaction(client, {
      account: 'Checking',
      date: future,
      amount: -45,
    });
    const post = client.calls.find(call => call.method === 'POST');
    expect(post?.endpoint).toBe('/plans/last-used/scheduled_transactions');
    expect(result).toMatchObject({ record_type: 'scheduled_transaction' });
  });

  it('updates only the supplied fields', async () => {
    const client = fakeYnab({
      '/plans/last-used/transactions/t1': {
        data: { transaction: { id: 't1', date: '2026-09-01', amount: -1000, memo: 'lunch' } },
      },
    });
    await ynabWriteTransaction(client, { transactionId: 't1', memo: 'lunch' });
    const put = client.calls.find(call => call.method === 'PUT');
    expect(put?.endpoint).toBe('/plans/last-used/transactions/t1');
    expect(put?.body).toEqual({ transaction: { memo: 'lunch' } });
  });

  it('dry_run previews a delete without calling', async () => {
    const client = fakeYnab();
    const result = await ynabWriteTransaction(client, {
      transactionId: 't1',
      delete: true,
      dryRun: true,
    });
    expect(result).toMatchObject({
      dry_run: true,
      method: 'DELETE',
      endpoint: '/plans/last-used/transactions/t1',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('refuses split edits — an API impossibility', async () => {
    const client = fakeYnab();
    await expect(
      ynabWriteTransaction(client, {
        transactionId: 't1',
        splits: [{ amount: 1 }, { amount: 2 }],
      }),
    ).rejects.toThrow(/cannot edit splits/);
    expect(client.calls).toHaveLength(0);
  });
});

describe('ynabWriteCategory', () => {
  it('creates a category with a target in a group resolved by name', async () => {
    const client = fakeYnab({
      '/plans/last-used/categories': CATEGORY_GROUPS,
      // POST target falls back to an empty envelope
    });
    await ynabWriteCategory(client, {
      name: 'Travel',
      group: 'Essentials',
      targetAmount: '$400',
    });
    const post = client.calls.find(call => call.method === 'POST');
    expect(post?.endpoint).toBe('/plans/last-used/categories');
    expect(post?.body).toEqual({
      category: { name: 'Travel', category_group_id: 'g1', goal_target: 400000 },
    });
  });

  it('removes a target with goal_target: null', async () => {
    const client = fakeYnab({ '/plans/last-used/categories': CATEGORY_GROUPS });
    await ynabWriteCategory(client, { category: 'Groceries', removeTarget: true });
    const patch = client.calls.find(call => call.method === 'PATCH');
    expect(patch?.endpoint).toBe('/plans/last-used/categories/c1');
    expect(patch?.body).toEqual({ category: { goal_target: null } });
  });

  it('keeps new_group a single-purpose operation', async () => {
    const client = fakeYnab();
    await expect(
      ynabWriteCategory(client, { newGroup: 'Wellness', name: 'Gym' }),
    ).rejects.toThrow(/combines with nothing else/);
    expect(client.calls).toHaveLength(0);
  });
});

describe('ynabReport', () => {
  it('computes net worth in currency units, skipping closed accounts', async () => {
    const client = fakeYnab({ '/plans/last-used/accounts': ACCOUNTS });
    const result = (await ynabReport(client, { kind: 'net_worth' })) as {
      total_assets: number;
      total_liabilities: number;
      net_worth: number;
      account_breakdown: unknown[];
    };
    expect(result.total_assets).toBe(1500);
    expect(result.total_liabilities).toBe(-250);
    expect(result.net_worth).toBe(1250);
    expect(result.account_breakdown).toHaveLength(2);
  });

  it('summarises a month with savings rate and top categories', async () => {
    const client = fakeYnab({
      '/plans/last-used/months/current': monthResponse('2026-09-01', {
        income: 2000000,
        activity: -1500000,
      }),
    });
    const result = (await ynabReport(client, { kind: 'monthly_summary' })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ income: 2000, spending: 1500, net_savings: 500, savings_rate: 25 });
    const top = result.top_categories as { name: string }[];
    expect(top.map(category => category.name)).toEqual(['Groceries', 'Dining Out']);
  });

  it('builds the full report with newest-first history', async () => {
    const client = fakeYnab({
      '/plans/last-used/accounts': ACCOUNTS,
      '/plans/last-used/months/current': monthResponse('2026-09-01'),
      '/plans/last-used/months': {
        data: {
          months: [
            { month: '2026-08-01', income: 2000000, activity: -1500000 },
            { month: '2026-09-01', income: 3200000, activity: -1850000 },
          ],
        },
      },
    });
    const result = (await ynabReport(client, { kind: 'full', monthsBack: 2 })) as Record<
      string,
      unknown
    >;
    const history = result.monthly_history as { month: string; net_savings: number }[];
    expect(history.map(entry => entry.month)).toEqual(['2026-09', '2026-08']);
    expect(history[1].net_savings).toBe(500);
    expect(result.net_worth).toMatchObject({ net_worth: 1250 });
  });
});

interface HevyCall {
  method: string;
  endpoint: string;
  body?: unknown;
}

/**
 * Fake Hevy client serving paginated workouts, templates, routines and folders, plus exact
 * endpoint lookups via `byId`. Records every call so write tests can assert on method, endpoint
 * and body — no request should reach it at all when payload validation fails.
 */
function fakeHevy(opts: {
  workoutPages?: unknown[][];
  templates?: unknown[];
  routinePages?: unknown[][];
  folderPages?: unknown[][];
  byId?: Record<string, unknown>;
  writeResult?: unknown;
}): HevyClient & { calls: HevyCall[] } {
  const calls: HevyCall[] = [];
  const paged = (pages: unknown[][] | undefined, key: string, page: number): unknown => ({
    [key]: pages?.[page - 1] ?? [],
    page_count: Math.max(pages?.length ?? 1, 1),
  });

  return {
    calls,
    async get(endpoint, params) {
      calls.push({ method: 'GET', endpoint });
      const page = Number(params?.page ?? '1');
      if (endpoint === '/v1/workouts') {
        return paged(opts.workoutPages, 'workouts', page);
      }
      if (endpoint === '/v1/exercise_templates') {
        return { exercise_templates: page === 1 ? (opts.templates ?? []) : [], page_count: 1 };
      }
      if (endpoint === '/v1/routines') {
        return paged(opts.routinePages, 'routines', page);
      }
      if (endpoint === '/v1/routine_folders') {
        return paged(opts.folderPages, 'routine_folders', page);
      }
      if (opts.byId && endpoint in opts.byId) {
        return opts.byId[endpoint];
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
    async post(endpoint, body) {
      calls.push({ method: 'POST', endpoint, body });
      return opts.writeResult ?? { ok: true };
    },
    async put(endpoint, body) {
      calls.push({ method: 'PUT', endpoint, body });
      return opts.writeResult ?? { ok: true };
    },
  };
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

/** Same UTC day key `hevyRecentActivity` groups on. */
const dayOf = (isoDate: string): string => isoDate.slice(0, 10);

const ACTIVITY_TEMPLATES = [
  {
    id: 'tmpl-bench',
    title: 'Bench Press',
    primary_muscle_group: 'chest',
    secondary_muscle_groups: ['triceps', 'shoulders'],
  },
  { id: 'tmpl-curl', title: 'Bicep Curl', primary_muscle_group: 'biceps' },
  { id: 'tmpl-run', title: 'Running', primary_muscle_group: 'cardio' },
];

/** A push session two days ago, a cardio session one day ago, plus an out-of-window page. */
function activityClient(): ReturnType<typeof fakeHevy> {
  return fakeHevy({
    templates: ACTIVITY_TEMPLATES,
    workoutPages: [
      [
        {
          id: 'w-cardio',
          title: 'Easy run',
          start_time: daysAgo(1),
          end_time: daysAgo(1),
          exercises: [
            {
              title: 'Running',
              exercise_template_id: 'tmpl-run',
              sets: [{ type: 'normal', duration_seconds: 1800, distance_meters: 5000 }],
            },
          ],
        },
        {
          id: 'w-push',
          title: 'Push',
          start_time: daysAgo(2),
          end_time: new Date(Date.parse(daysAgo(2)) + 3_600_000).toISOString(),
          exercises: [
            {
              title: 'Bench Press',
              exercise_template_id: 'tmpl-bench',
              sets: [
                { type: 'warmup', weight_kg: 40, reps: 10 },
                { type: 'normal', weight_kg: 80, reps: 5 },
                { type: 'normal', weight_kg: 100, reps: 5 },
              ],
            },
          ],
        },
      ],
      // Second page is older than the window; pagination must stop before it.
      [{ id: 'w-old', title: 'Ancient', start_time: daysAgo(400), exercises: [] }],
    ],
  });
}

describe('hevyRecentActivity', () => {
  it('groups by muscle group then day, excluding warmups and out-of-window workouts', async () => {
    const result = (await hevyRecentActivity(activityClient(), { days: 4 })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      period_days: 4,
      type: 'all',
      depth: 0,
      total_workouts: 2,
      total_working_sets: 3,
      total_volume_kg: 900,
    });

    const groups = result.muscle_groups as Record<string, Record<string, Record<string, unknown>>>;
    // Ordered by volume: chest and its secondaries carry 900kg, cardio carries none.
    expect(Object.keys(groups)).toEqual(['chest', 'triceps', 'shoulders', 'cardio']);
    expect(groups.chest[dayOf(daysAgo(2))]).toEqual({
      total_sets: 2,
      total_volume_kg: 900,
      as_primary: 2,
      as_secondary: 0,
      exercises_ids: { 'Bench Press': 'tmpl-bench' },
    });
    expect(groups.triceps[dayOf(daysAgo(2))]).toMatchObject({ as_primary: 0, as_secondary: 2 });
    expect(Object.keys(groups.cardio)).toEqual([dayOf(daysAgo(1))]);
  });

  it('exposes the workout id and duration of every session in the window', async () => {
    const result = (await hevyRecentActivity(activityClient(), {})) as Record<string, unknown>;
    const sessions = result.sessions as Record<string, unknown>[];
    expect(sessions.map(session => session.workout_id)).toEqual(['w-cardio', 'w-push']);
    expect(sessions[1]).toMatchObject({
      title: 'Push',
      date: dayOf(daysAgo(2)),
      duration_minutes: 60,
      working_sets: 2,
      volume_kg: 900,
    });
  });

  it('defaults to a 4-day window', async () => {
    const client = fakeHevy({
      workoutPages: [
        [
          { id: 'recent', title: 'In', start_time: daysAgo(3), exercises: [] },
          { id: 'stale', title: 'Out', start_time: daysAgo(5), exercises: [] },
        ],
      ],
    });
    const result = (await hevyRecentActivity(client, {})) as Record<string, unknown>;
    expect(result).toMatchObject({ period_days: 4, total_workouts: 1 });
  });

  it('describes each exercise in words at depth 1', async () => {
    const result = (await hevyRecentActivity(activityClient(), {
      type: 'muscles',
      depth: 1,
    })) as Record<string, unknown>;
    const groups = result.muscle_groups as Record<string, Record<string, Record<string, unknown>>>;
    expect(groups.chest[dayOf(daysAgo(2))].exercises_text).toEqual({
      'Bench Press': '2 sets of 5 repetitions each with min of 80kg, max of 100kg.',
    });
    expect(groups.chest[dayOf(daysAgo(2))]).not.toHaveProperty('exercises_ids');
  });

  it('describes cardio sets by duration and distance', async () => {
    const result = (await hevyRecentActivity(activityClient(), {
      type: 'cardio',
      depth: 1,
    })) as Record<string, unknown>;
    const groups = result.muscle_groups as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(groups)).toEqual(['cardio']);
    expect(groups.cardio[dayOf(daysAgo(1))].exercises_text).toEqual({
      Running: '1 set totalling 30 min over 5 km.',
    });
  });

  it('excludes cardio from type "muscles" and everything else from type "cardio"', async () => {
    const muscles = (await hevyRecentActivity(activityClient(), { type: 'muscles' })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(muscles.muscle_groups as object)).not.toContain('cardio');

    const cardio = (await hevyRecentActivity(activityClient(), { type: 'cardio' })) as Record<
      string,
      unknown
    >;
    expect(Object.keys(cardio.muscle_groups as object)).toEqual(['cardio']);
    // Session metadata stays window-wide whatever the breakdown is filtered to.
    expect(cardio.total_workouts).toBe(2);
  });

  it('narrows to one group with specific, which implies its type so depth 1 is allowed', async () => {
    const result = (await hevyRecentActivity(activityClient(), {
      specific: 'triceps',
      depth: 1,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ type: 'muscles', specific: 'triceps' });
    expect(Object.keys(result.muscle_groups as object)).toEqual(['triceps']);
  });

  it('merges two workouts on the same day into one date bucket', async () => {
    const client = fakeHevy({
      templates: ACTIVITY_TEMPLATES,
      workoutPages: [
        [
          {
            id: 'w-pm',
            start_time: daysAgo(1),
            exercises: [
              {
                title: 'Bicep Curl',
                exercise_template_id: 'tmpl-curl',
                sets: [{ type: 'normal', weight_kg: 10, reps: 10 }],
              },
            ],
          },
          {
            id: 'w-am',
            start_time: daysAgo(1),
            exercises: [
              {
                title: 'Bicep Curl',
                exercise_template_id: 'tmpl-curl',
                sets: [{ type: 'normal', weight_kg: 12, reps: 8 }],
              },
            ],
          },
        ],
      ],
    });
    const result = (await hevyRecentActivity(client, { specific: 'biceps', depth: 1 })) as Record<
      string,
      unknown
    >;
    const groups = result.muscle_groups as Record<string, Record<string, Record<string, unknown>>>;
    const day = groups.biceps[dayOf(daysAgo(1))];
    expect(day).toMatchObject({ total_sets: 2, total_volume_kg: 196 });
    expect(day.exercises_text).toEqual({
      'Bicep Curl': '2 sets of 8-10 repetitions each with min of 10kg, max of 12kg.',
    });
  });

  it('falls back to the "other" group for unknown templates', async () => {
    const client = fakeHevy({
      workoutPages: [
        [
          {
            id: 'w1',
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
    const result = (await hevyRecentActivity(client, {})) as Record<string, unknown>;
    expect(Object.keys(result.muscle_groups as object)).toEqual(['other']);
  });

  it('refuses depth 1 without a narrowed type, and beyond 4 days', async () => {
    const client = activityClient();
    await expect(hevyRecentActivity(client, { depth: 1 })).rejects.toThrow(/narrower scope/);
    await expect(hevyRecentActivity(client, { type: 'all', depth: 1 })).rejects.toThrow(
      /narrower scope/,
    );
    await expect(
      hevyRecentActivity(client, { type: 'muscles', depth: 1, days: 10 }),
    ).rejects.toThrow(/at most 4 days/);
    // No request should have been made for any of the three.
    expect(client.calls).toHaveLength(0);
  });

  it('refuses an unknown muscle group and a contradictory type', async () => {
    const client = activityClient();
    await expect(hevyRecentActivity(client, { specific: 'lungs' })).rejects.toThrow(
      /unknown muscle group/,
    );
    await expect(
      hevyRecentActivity(client, { specific: 'triceps', type: 'cardio' }),
    ).rejects.toThrow(/contradicts/);
    await expect(hevyRecentActivity(client, { specific: 'cardio', type: 'muscles' })).rejects.toThrow(
      /contradicts/,
    );
  });
});

const TEMPLATES = [
  {
    id: '79D0BB3A',
    title: 'Bench Press (Barbell)',
    primary_muscle_group: 'chest',
    secondary_muscle_groups: ['triceps'],
    equipment: 'barbell',
  },
  { id: '3601968B', title: 'Bench Press (Dumbbell)', primary_muscle_group: 'chest' },
  { id: 'D04AC939', title: 'Squat (Barbell)', primary_muscle_group: 'quadriceps' },
  { id: 'C6272009', title: 'Triceps Pushdown', primary_muscle_group: 'triceps' },
];

describe('hevySearchExerciseCatalog', () => {
  it('ranks an exact title first and reports the id under its write-side name', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExerciseCatalog(client, {
      query: 'Bench Press (Barbell)',
    })) as { match_count: number; matches: Record<string, unknown>[] };
    expect(result.matches[0]).toMatchObject({
      exercise_template_id: '79D0BB3A',
      title: 'Bench Press (Barbell)',
      equipment: 'barbell',
      is_custom: false,
    });
    // "(barbell)" excludes the dumbbell variant, so the full title matches exactly one template.
    expect(result.match_count).toBe(1);
  });

  it('returns both variants for a partial name, shortest title first', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExerciseCatalog(client, { query: 'bench press' })) as {
      match_count: number;
      matches: { exercise_template_id: string }[];
    };
    expect(result.match_count).toBe(2);
    expect(result.matches[0].exercise_template_id).toBe('79D0BB3A');
  });

  it('honours the limit', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExerciseCatalog(client, {
      query: 'bench press',
      limit: 1,
    })) as { match_count: number };
    expect(result.match_count).toBe(1);
  });

  it('returns nothing for a query that matches no template', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExerciseCatalog(client, { query: 'deadlift' })) as {
      match_count: number;
    };
    expect(result.match_count).toBe(0);
  });

  it('browses a muscle group without a query, primary role first', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExerciseCatalog(client, { muscleGroup: 'triceps' })) as {
      match_count: number;
      total_in_group: number;
      matches: { title: string }[];
    };
    expect(result.match_count).toBe(2);
    expect(result.total_in_group).toBe(2);
    expect(result.matches.map(match => match.title)).toEqual([
      'Triceps Pushdown',
      'Bench Press (Barbell)',
    ]);
  });

  it('intersects a query with a muscle group', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExerciseCatalog(client, {
      query: 'bench press',
      muscleGroup: 'triceps',
    })) as { match_count: number; matches: { exercise_template_id: string }[] };
    expect(result.match_count).toBe(1);
    expect(result.matches[0].exercise_template_id).toBe('79D0BB3A');
  });

  it('refuses an empty search and an unknown muscle group', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    await expect(hevySearchExerciseCatalog(client, {})).rejects.toThrow(/pass query/);
    await expect(hevySearchExerciseCatalog(client, { muscleGroup: 'lungs' })).rejects.toThrow(
      /unknown muscle group/,
    );
  });
});

describe('hevyGetWorkout', () => {
  it('unwraps the single-workout envelope when there is one', async () => {
    const enveloped = fakeHevy({ byId: { '/v1/workouts/w1': { workout: { id: 'w1' } } } });
    expect(await hevyGetWorkout(enveloped, { workoutId: 'w1' })).toEqual({ id: 'w1' });

    const bare = fakeHevy({ byId: { '/v1/workouts/w1': { id: 'w1', title: 'Push' } } });
    expect(await hevyGetWorkout(bare, { workoutId: 'w1' })).toEqual({ id: 'w1', title: 'Push' });
  });
});

/** A routine as the API returns it, with the read-shape keys and a planned rep_range. */
const LISTED_ROUTINE = {
  id: 'r1',
  title: 'Upper A',
  folder_id: null,
  notes: null,
  exercises: [
    {
      index: 0,
      title: 'Bench Press (Barbell)',
      exercise_template_id: '79D0BB3A',
      rest_seconds: '90',
      notes: null,
      supersets_id: null,
      sets: [
        { type: 'warmup', weight_kg: 20, reps: 10 },
        { type: 'normal', weight_kg: 60, reps: null, rep_range: { start: 8, end: 12 } },
        { type: 'normal', weight_kg: 65, reps: null, rep_range: { start: 8, end: 12 } },
      ],
    },
    {
      index: 1,
      title: 'Triceps Pushdown',
      exercise_template_id: 'C6272009',
      rest_seconds: null,
      notes: 'slow eccentric',
      supersets_id: 2,
      sets: [{ type: 'normal', weight_kg: 30, reps: 12 }],
    },
  ],
};

describe('hevyRoutines', () => {
  it('paginates the full list', async () => {
    const client = fakeHevy({
      routinePages: [[{ id: 'r1' }, { id: 'r2' }], [{ id: 'r3' }]],
    });
    const result = (await hevyRoutines(client, {})) as { routine_count: number };
    expect(result.routine_count).toBe(3);
  });

  it('summarizes each exercise in one line, keyed by its position in the plan', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': { routine: LISTED_ROUTINE } } });
    const result = (await hevyRoutines(client, { routineId: 'r1' })) as Record<string, unknown>;
    expect(result).toMatchObject({
      routine_id: 'r1',
      title: 'Upper A',
      exercise_count: 2,
      total_sets: 4,
    });
    expect(result.exercises).toEqual({
      // rep_range feeds the rep clause, and the warmup is counted rather than described.
      '1. Bench Press (Barbell)':
        '2 sets of 8-12 repetitions each with min of 60kg, max of 65kg (+1 warmup). 90s rest.',
      '2. Triceps Pushdown': '1 set of 12 repetitions each at 30kg. Superset 2. Note: slow eccentric',
    });
  });

  it('omits null fields instead of showing them', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': { routine: LISTED_ROUTINE } } });
    const result = (await hevyRoutines(client, { routineId: 'r1' })) as Record<string, unknown>;
    expect(result).not.toHaveProperty('folder_id');
    expect(result).not.toHaveProperty('notes');

    const filed = fakeHevy({
      byId: { '/v1/routines/r2': { routine: { ...LISTED_ROUTINE, folder_id: 7, notes: 'heavy' } } },
    });
    expect(await hevyRoutines(filed, { routineId: 'r2' })).toMatchObject({
      folder_id: 7,
      notes: 'heavy',
    });
  });

  it('never returns raw set objects', async () => {
    const client = fakeHevy({ routinePages: [[LISTED_ROUTINE]] });
    const result = (await hevyRoutines(client, {})) as { routines: Record<string, unknown>[] };
    expect(JSON.stringify(result)).not.toContain('weight_kg');
  });
});

describe('hevyBodyMeasurements', () => {
  const measurementClient = (
    pages: unknown[][],
  ): HevyClient & { calls: HevyCall[] } => {
    const calls: HevyCall[] = [];
    return {
      calls,
      async get(endpoint, params) {
        calls.push({ method: 'GET', endpoint });
        if (endpoint === '/v1/body_measurements') {
          const page = Number(params?.page ?? '1');
          return {
            page,
            page_count: pages.length,
            body_measurements: pages[page - 1] ?? [],
          };
        }
        if (endpoint.startsWith('/v1/body_measurements/')) {
          const date = endpoint.split('/').pop();
          const all = pages.flat() as { date?: string }[];
          const found = all.find(entry => entry.date === date);
          if (!found) {
            throw new Error('Body measurement not found');
          }
          return found;
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
      async post() {
        throw new Error('unexpected write');
      },
      async put() {
        throw new Error('unexpected write');
      },
    };
  };

  const ENTRIES = [
    [
      { id: 1, date: '2026-08-01', weight_kg: 80, fat_percent: null, created_at: 'x' },
      { id: 2, date: '2026-07-01', weight_kg: 81.5, chest_cm: 95 },
    ],
    [{ id: 3, date: '2026-08-05', weight_kg: 79.4, lean_mass_kg: 65 }],
  ];

  it('sorts newest first across pages rather than trusting the API order', async () => {
    const client = measurementClient(ENTRIES);
    const result = (await hevyBodyMeasurements(client, {})) as {
      total_recorded: number;
      entry_count: number;
      measurements: { date: string }[];
    };
    expect(result.total_recorded).toBe(3);
    expect(result.entry_count).toBe(3);
    expect(result.measurements.map(entry => entry.date)).toEqual([
      '2026-08-05',
      '2026-08-01',
      '2026-07-01',
    ]);
  });

  it('drops null fields and API bookkeeping', async () => {
    const client = measurementClient(ENTRIES);
    const result = (await hevyBodyMeasurements(client, { limit: 1 })) as {
      measurements: Record<string, unknown>[];
    };
    expect(result.measurements[0]).toEqual({
      date: '2026-08-05',
      weight_kg: 79.4,
      lean_mass_kg: 65,
    });
    const older = (await hevyBodyMeasurements(client, { limit: 2 })) as {
      measurements: Record<string, unknown>[];
    };
    expect(older.measurements[1]).toEqual({ date: '2026-08-01', weight_kg: 80 });
  });

  it('honours the limit and the days window', async () => {
    const client = measurementClient([
      [
        { date: daysAgo(1).slice(0, 10), weight_kg: 80 },
        { date: daysAgo(60).slice(0, 10), weight_kg: 82 },
      ],
    ]);
    const windowed = (await hevyBodyMeasurements(client, { days: 30 })) as {
      period_days: number;
      total_recorded: number;
      entry_count: number;
    };
    expect(windowed).toMatchObject({ period_days: 30, total_recorded: 2, entry_count: 1 });

    const limited = (await hevyBodyMeasurements(client, { limit: 1 })) as { entry_count: number };
    expect(limited.entry_count).toBe(1);
  });

  it('fetches a single date directly', async () => {
    const client = measurementClient(ENTRIES);
    const result = (await hevyBodyMeasurements(client, { date: '2026-07-01' })) as {
      measurement: Record<string, unknown>;
    };
    expect(result.measurement).toEqual({ date: '2026-07-01', weight_kg: 81.5, chest_cm: 95 });
    expect(client.calls).toEqual([
      { method: 'GET', endpoint: '/v1/body_measurements/2026-07-01' },
    ]);
  });

  it('rejects a malformed date before calling the API', async () => {
    const client = measurementClient(ENTRIES);
    await expect(hevyBodyMeasurements(client, { date: '01-07-2026' })).rejects.toThrow(
      /must be YYYY-MM-DD/,
    );
    expect(client.calls).toHaveLength(0);
  });
});

/** A routine as the API returns it: read-shape keys, server-assigned index/title. */
const FETCHED_ROUTINE = {
  routine: {
    id: 'r1',
    title: 'Upper A',
    notes: 'keep form',
    folder_id: 42,
    exercises: [
      {
        index: 0,
        title: 'Bench Press (Barbell)',
        exercise_template_id: '79D0BB3A',
        supersets_id: 1,
        rest_seconds: '90',
        sets: [
          { index: 0, type: 'warmup', weight_kg: 20, reps: 10 },
          { index: 1, type: 'normal', weight_kg: 60, reps: 8 },
        ],
      },
      {
        index: 1,
        title: 'Squat (Barbell)',
        exercise_template_id: 'D04AC939',
        supersets_id: null,
        sets: [{ index: 0, type: 'normal', weight_kg: 80, reps: 5 }],
      },
    ],
  },
};

describe('hevyWriteRoutine', () => {
  it('POSTs a new routine when no id is given, resolving names', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    await hevyWriteRoutine(client, {
      title: 'Leg Day',
      exercises: [{ exercise: 'Squat (Barbell)', sets: 3, reps: 5, weight_kg: 80 }],
    });
    const write = client.calls.find(call => call.method === 'POST');
    expect(write?.endpoint).toBe('/v1/routines');
    const body = write?.body as { routine: { exercises: { exercise_template_id: string }[] } };
    expect(body.routine.exercises[0].exercise_template_id).toBe('D04AC939');
    expect(body.routine.exercises[0]).toMatchObject({ sets: expect.any(Array) });
  });

  it('preserves every existing exercise when updating without passing exercises', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': FETCHED_ROUTINE } });
    await hevyWriteRoutine(client, { routineId: 'r1', title: 'Upper A v2' });

    const write = client.calls.find(call => call.method === 'PUT');
    expect(write?.endpoint).toBe('/v1/routines/r1');
    const routine = (write?.body as { routine: Record<string, unknown> }).routine;
    expect(routine.title).toBe('Upper A v2');
    expect(routine.notes).toBe('keep form');
    expect(routine.exercises).toHaveLength(2);
    // folder_id is create-only; sending it on PUT is a 400.
    expect('folder_id' in routine).toBe(false);
  });

  it('carries supersets and rest across the read-modify-write round trip', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': FETCHED_ROUTINE } });
    await hevyWriteRoutine(client, { routineId: 'r1', notes: 'updated' });

    const body = client.calls.find(call => call.method === 'PUT')?.body as {
      routine: { exercises: Record<string, unknown>[] };
    };
    expect(body.routine.exercises[0]).toMatchObject({ superset_id: 1, rest_seconds: 90 });
    expect(body.routine.exercises[0]).not.toHaveProperty('supersets_id');
    expect(body.routine.exercises[0]).not.toHaveProperty('index');
  });

  it('appends to the existing exercises when exercise_mode is append', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': FETCHED_ROUTINE }, templates: TEMPLATES });
    await hevyWriteRoutine(client, {
      routineId: 'r1',
      exercises: [{ exercise_template_id: '79D0BB3A', sets: 2, reps: 10 }],
      exerciseMode: 'append',
    });
    const body = client.calls.find(call => call.method === 'PUT')?.body as {
      routine: { exercises: unknown[] };
    };
    expect(body.routine.exercises).toHaveLength(3);
  });

  it('replaces the exercises by default', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': FETCHED_ROUTINE } });
    await hevyWriteRoutine(client, {
      routineId: 'r1',
      exercises: [{ exercise_template_id: '79D0BB3A', sets: 2, reps: 10 }],
    });
    const body = client.calls.find(call => call.method === 'PUT')?.body as {
      routine: { exercises: unknown[] };
    };
    expect(body.routine.exercises).toHaveLength(1);
  });

  it('returns the request body and sends nothing when dry_run is set', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': FETCHED_ROUTINE } });
    const result = (await hevyWriteRoutine(client, {
      routineId: 'r1',
      title: 'Preview',
      dryRun: true,
    })) as { dry_run: boolean; method: string; endpoint: string };

    expect(result).toMatchObject({ dry_run: true, method: 'PUT', endpoint: '/v1/routines/r1' });
    expect(client.calls.some(call => call.method === 'PUT')).toBe(false);
  });

  it('refuses to move a routine between folders', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': FETCHED_ROUTINE } });
    await expect(
      hevyWriteRoutine(client, { routineId: 'r1', folderName: 'Push Pull' }),
    ).rejects.toThrow(/cannot be moved between folders/);
  });

  it('resolves a folder by name on create', async () => {
    const client = fakeHevy({
      templates: TEMPLATES,
      folderPages: [[{ id: 7, title: 'Push Pull' }]],
    });
    await hevyWriteRoutine(client, {
      title: 'Push A',
      exercises: [{ exercise_template_id: '79D0BB3A', reps: 5 }],
      folderName: 'push pull',
    });
    const body = client.calls.find(call => call.method === 'POST')?.body as {
      routine: { folder_id: number };
    };
    expect(body.routine.folder_id).toBe(7);
  });

  it('creates a missing folder only when create_folder is set', async () => {
    const strict = fakeHevy({ folderPages: [[]] });
    await expect(
      hevyWriteRoutine(strict, {
        title: 'Push A',
        exercises: [{ exercise_template_id: '79D0BB3A', reps: 5 }],
        folderName: 'New Folder',
      }),
    ).rejects.toThrow(/pass create_folder=true/);

    const lenient = fakeHevy({ folderPages: [[]], writeResult: { routine_folder: { id: 9 } } });
    await hevyWriteRoutine(lenient, {
      title: 'Push A',
      exercises: [{ exercise_template_id: '79D0BB3A', reps: 5 }],
      folderName: 'New Folder',
      createFolder: true,
    });
    const folderCall = lenient.calls.find(
      call => call.method === 'POST' && call.endpoint === '/v1/routine_folders',
    );
    expect(folderCall?.body).toEqual({ routine_folder: { title: 'New Folder' } });
    const routineBody = lenient.calls.find(
      call => call.method === 'POST' && call.endpoint === '/v1/routines',
    )?.body as { routine: { folder_id: number } };
    expect(routineBody.routine.folder_id).toBe(9);
  });

  it('refuses an ambiguous exercise name instead of guessing, and sends nothing', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    await expect(
      hevyWriteRoutine(client, { title: 'X', exercises: [{ exercise: 'bench press', reps: 5 }] }),
    ).rejects.toThrow(/is ambiguous/);
    expect(client.calls.some(call => call.method !== 'GET')).toBe(false);
  });

  it('rejects a routine set carrying rpe before any request is made', async () => {
    const client = fakeHevy({});
    await expect(
      hevyWriteRoutine(client, {
        title: 'X',
        exercises: [{ exercise_template_id: '79D0BB3A', reps: 5, rpe: 8 }],
      }),
    ).rejects.toThrow(/rpe is not supported on routine sets/);
    expect(client.calls).toHaveLength(0);
  });

  it('requires a title and exercises when creating', async () => {
    const client = fakeHevy({});
    await expect(hevyWriteRoutine(client, { title: 'X' })).rejects.toThrow(/requires exercises/);
    await expect(
      hevyWriteRoutine(client, { exercises: [{ exercise_template_id: 'X1', reps: 5 }] }),
    ).rejects.toThrow(/requires a title/);
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
