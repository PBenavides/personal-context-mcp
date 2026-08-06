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
  hevyRoutines,
  hevySearchExercises,
  hevyWriteRoutine,
  hevyWriteWorkout,
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

const TEMPLATES = [
  { id: '79D0BB3A', title: 'Bench Press (Barbell)', primary_muscle_group: 'chest' },
  { id: '3601968B', title: 'Bench Press (Dumbbell)', primary_muscle_group: 'chest' },
  { id: 'D04AC939', title: 'Squat (Barbell)', primary_muscle_group: 'quadriceps' },
];

describe('hevySearchExercises', () => {
  it('ranks an exact title first', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExercises(client, { query: 'Bench Press (Barbell)' })) as {
      match_count: number;
      matches: { id: string }[];
    };
    expect(result.matches[0].id).toBe('79D0BB3A');
    // "(barbell)" excludes the dumbbell variant, so the full title matches exactly one template.
    expect(result.match_count).toBe(1);
  });

  it('returns both variants for a partial name, shortest title first', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExercises(client, { query: 'bench press' })) as {
      match_count: number;
      matches: { id: string }[];
    };
    expect(result.match_count).toBe(2);
    expect(result.matches[0].id).toBe('79D0BB3A');
  });

  it('honours the limit', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExercises(client, { query: 'bench press', limit: 1 })) as {
      match_count: number;
    };
    expect(result.match_count).toBe(1);
  });

  it('returns nothing for a query that matches no template', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    const result = (await hevySearchExercises(client, { query: 'deadlift' })) as {
      match_count: number;
    };
    expect(result.match_count).toBe(0);
  });
});

describe('hevyRoutines', () => {
  it('paginates the full list', async () => {
    const client = fakeHevy({
      routinePages: [[{ id: 'r1' }, { id: 'r2' }], [{ id: 'r3' }]],
    });
    const result = (await hevyRoutines(client, {})) as { routine_count: number };
    expect(result.routine_count).toBe(3);
  });

  it('unwraps the single-routine envelope', async () => {
    const client = fakeHevy({ byId: { '/v1/routines/r1': { routine: { id: 'r1', title: 'A' } } } });
    expect(await hevyRoutines(client, { routineId: 'r1' })).toEqual({ id: 'r1', title: 'A' });
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

const FETCHED_WORKOUT = {
  id: 'w1',
  title: 'Push',
  start_time: '2026-08-01T18:00:00Z',
  end_time: '2026-08-01T19:00:00Z',
  description: 'solid',
  exercises: [
    {
      index: 0,
      title: 'Bench Press (Barbell)',
      exercise_template_id: '79D0BB3A',
      supersets_id: null,
      sets: [{ index: 0, type: 'normal', weight_kg: 60, reps: 8, rpe: 8.5 }],
    },
  ],
};

describe('hevyWriteWorkout', () => {
  it('POSTs a new workout when no id is given', async () => {
    const client = fakeHevy({ templates: TEMPLATES });
    await hevyWriteWorkout(client, {
      title: 'Push',
      startTime: '2026-08-06T18:00:00Z',
      endTime: '2026-08-06T19:00:00Z',
      exercises: [{ exercise: 'Bench Press (Barbell)', sets: 2, reps: 8, weight_kg: 60, rpe: 8 }],
    });
    const write = client.calls.find(call => call.method === 'POST');
    expect(write?.endpoint).toBe('/v1/workouts');
    const body = write?.body as { workout: { exercises: { sets: { rpe?: number }[] }[] } };
    expect(body.workout.exercises[0].sets).toHaveLength(2);
    expect(body.workout.exercises[0].sets[0].rpe).toBe(8);
  });

  it('preserves title, times, exercises and rpe when updating only the description', async () => {
    const client = fakeHevy({ byId: { '/v1/workouts/w1': FETCHED_WORKOUT } });
    await hevyWriteWorkout(client, { workoutId: 'w1', description: 'edited' });

    const body = client.calls.find(call => call.method === 'PUT')?.body as {
      workout: {
        title: string;
        start_time: string;
        description: string;
        exercises: { sets: { rpe?: number }[] }[];
      };
    };
    expect(body.workout).toMatchObject({
      title: 'Push',
      start_time: '2026-08-01T18:00:00Z',
      description: 'edited',
    });
    expect(body.workout.exercises[0].sets[0].rpe).toBe(8.5);
  });

  it('requires exercises when creating', async () => {
    const client = fakeHevy({});
    await expect(
      hevyWriteWorkout(client, { title: 'Push', startTime: 'a', endTime: 'b' }),
    ).rejects.toThrow(/requires exercises/);
  });

  it('rejects rest_seconds on a logged workout before any request is made', async () => {
    const client = fakeHevy({});
    await expect(
      hevyWriteWorkout(client, {
        title: 'Push',
        startTime: '2026-08-06T18:00:00Z',
        endTime: '2026-08-06T19:00:00Z',
        exercises: [{ exercise_template_id: '79D0BB3A', reps: 5, rest_seconds: 60 }],
      }),
    ).rejects.toThrow(/rest_seconds is a routine planning field/);
    expect(client.calls).toHaveLength(0);
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
