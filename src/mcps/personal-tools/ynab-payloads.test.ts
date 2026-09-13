import {
  buildCategoryBody,
  buildScheduledBody,
  buildTransactionBody,
  followingMonth,
  monthIso,
  parseAmount,
  planAssignments,
  resolveMonth,
  resolveRef,
  shapeOverview,
  shapeTransactions,
  YnabPayloadError,
} from './ynab-payloads.js';

describe('parseAmount', () => {
  it.each([
    [250.5, 250500],
    [-45, -45000],
    ['250.50', 250500],
    ['$250.50', 250500],
    ['-$45', -45000],
    ['$-45', -45000],
    ['250,50 EUR', 250500],
    ['EUR 10', 10000],
    ['1,250.75', 1250750],
    ['1.250', 1250000], // separator followed by 3 digits = thousands
    ['1,25', 1250],
    ['0.5', 500],
    ['10', 10000],
  ] as [string | number, number][])('parses %j → %d milliunits', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each(['abc', '--5', '1.2345', '1,2,3', '', '$'])('refuses %j naming the fix', input => {
    expect(() => parseAmount(input)).toThrow(YnabPayloadError);
    expect(() => parseAmount(input)).toThrow(/250\.50/);
  });
});

describe('months', () => {
  const now = new Date('2026-09-13T12:00:00Z');

  it('resolves keywords and shorthand', () => {
    expect(resolveMonth(undefined, now)).toBe('current');
    expect(resolveMonth('current', now)).toBe('current');
    expect(resolveMonth('next', now)).toBe('2026-10-01');
    expect(resolveMonth('2026-12', now)).toBe('2026-12-01');
    expect(resolveMonth('2026-12-01', now)).toBe('2026-12-01');
  });

  it('refuses non-first-of-month dates', () => {
    expect(() => resolveMonth('2026-12-15', now)).toThrow(/YYYY-MM-01/);
  });

  it('turns current into a concrete first-of-month and steps forward across years', () => {
    expect(monthIso(undefined, now)).toBe('2026-09-01');
    expect(followingMonth('2026-12-01')).toBe('2027-01-01');
  });
});

describe('resolveRef', () => {
  const items = [
    { id: 'c1', name: 'Groceries' },
    { id: 'c2', name: 'Dining Out' },
    { id: 'c3', name: 'Dining In' },
  ];

  it('matches exactly (case-insensitive), then by substring', () => {
    expect(resolveRef(items, 'groceries', 'category').id).toBe('c1');
    expect(resolveRef(items, 'out', 'category').id).toBe('c2');
  });

  it('refuses ambiguity with candidates, and unknown names', () => {
    expect(() => resolveRef(items, 'dining', 'category')).toThrow(/Dining Out, Dining In/);
    expect(() => resolveRef(items, 'rent', 'category')).toThrow(/no category matching "rent"/);
  });
});

describe('planAssignments', () => {
  const pool = [
    { id: 'c1', name: 'Groceries', budgeted: 300000 },
    { id: 'c2', name: 'Dining Out', budgeted: 100000 },
  ];

  it('computes set as absolute and adjust as a delta', () => {
    expect(
      planAssignments(pool, [
        { category: 'Groceries', set: '$400' },
        { category: 'Dining Out', adjust: -50 },
      ]),
    ).toEqual([
      { id: 'c1', name: 'Groceries', beforeMilli: 300000, afterMilli: 400000 },
      { id: 'c2', name: 'Dining Out', beforeMilli: 100000, afterMilli: 50000 },
    ]);
  });

  it('refuses set+adjust together, prefixed with the failing index', () => {
    expect(() =>
      planAssignments(pool, [{ category: 'Groceries', set: 1, adjust: 2 }]),
    ).toThrow(/assignments\[0\].*exactly one/);
  });

  it('refuses a category listed twice', () => {
    expect(() =>
      planAssignments(pool, [
        { category: 'Groceries', set: 1 },
        { category: 'groceries', adjust: 2 },
      ]),
    ).toThrow(/more than once/);
  });
});

describe('buildTransactionBody', () => {
  it('enforces the create trio', () => {
    expect(() => buildTransactionBody({}, { create: true })).toThrow(/requires an account/);
    expect(() => buildTransactionBody({ accountId: 'a1' }, { create: true })).toThrow(/date/);
    expect(() =>
      buildTransactionBody({ accountId: 'a1', date: '2026-09-10' }, { create: true }),
    ).toThrow(/amount/);
  });

  it('reconciles split sums with the total and forces category_id null', () => {
    const splits = [
      { amount: -30000, category_id: 'c1' },
      { amount: -15000, category_id: 'c2' },
    ];
    const body = buildTransactionBody(
      { accountId: 'a1', date: '2026-09-10', subtransactions: splits },
      { create: true },
    );
    expect(body).toMatchObject({ amount: -45000, category_id: null, subtransactions: splits });
    expect(() =>
      buildTransactionBody(
        { accountId: 'a1', date: '2026-09-10', amountMilli: -40000, subtransactions: splits },
        { create: true },
      ),
    ).toThrow(/must match/);
  });

  it('validates enums on update without requiring the trio', () => {
    expect(buildTransactionBody({ cleared: 'reconciled' }, { create: false })).toEqual({
      cleared: 'reconciled',
    });
    expect(() => buildTransactionBody({ cleared: 'nope' }, { create: false })).toThrow(
      /cleared must be one of/,
    );
    expect(() => buildTransactionBody({ flagColor: 'pink' }, { create: false })).toThrow(
      /flag_color must be one of/,
    );
  });
});

describe('buildScheduledBody', () => {
  const today = new Date('2026-09-13T12:00:00Z');
  const base = { accountId: 'a1', date: '2026-10-01', amountMilli: -1200000 };

  it('requires a future date and validates frequency', () => {
    expect(
      buildScheduledBody({ ...base, frequency: 'monthly' }, { create: true, today }),
    ).toMatchObject({ date: '2026-10-01', frequency: 'monthly' });
    expect(() =>
      buildScheduledBody({ ...base, date: '2026-09-13' }, { create: true, today }),
    ).toThrow(/future date/);
    expect(() =>
      buildScheduledBody({ ...base, frequency: 'fortnightly' }, { create: true, today }),
    ).toThrow(/frequency must be one of/);
  });

  it('refuses splits — an API impossibility', () => {
    expect(() =>
      buildScheduledBody(
        { ...base, subtransactions: [{ amount: 1 }, { amount: 2 }] },
        { create: true, today },
      ),
    ).toThrow(/split scheduled/);
  });
});

describe('buildCategoryBody', () => {
  it('requires name and group on create', () => {
    expect(() => buildCategoryBody({}, { create: true })).toThrow(/requires a name/);
    expect(() => buildCategoryBody({ name: 'Travel' }, { create: true })).toThrow(/group/);
  });

  it('keeps target_frequency and target_date exclusive, both needing an amount', () => {
    expect(() =>
      buildCategoryBody({ goalFrequency: 'monthly' }, { create: false }),
    ).toThrow(/requires target_amount/);
    expect(() =>
      buildCategoryBody(
        { goalTargetMilli: 400000, goalFrequency: 'monthly', goalTargetDate: '2027-01-01' },
        { create: false },
      ),
    ).toThrow(/mutually exclusive/);
    expect(
      buildCategoryBody({ goalTargetMilli: null }, { create: false }),
    ).toEqual({ goal_target: null });
  });
});

describe('shapeTransactions', () => {
  it('drops deleted rows, sorts newest first, applies the limit', () => {
    const shaped = shapeTransactions(
      [
        { id: 't1', date: '2026-07-01', amount: -1000, deleted: false },
        { id: 't2', date: '2026-07-03', amount: -2000, deleted: false },
        { id: 't3', date: '2026-07-02', amount: -3000, deleted: true },
      ],
      { limit: 1 },
    );
    expect(shaped).toEqual([{ id: 't2', date: '2026-07-03', amount: -2 }]);
  });
});

describe('shapeOverview', () => {
  it('reports fully_funded and a ready-to-assign alert when next month has idle money', () => {
    const result = shapeOverview({
      month: {
        month: '2026-09-01',
        income: 3200000,
        budgeted: 3100000,
        activity: -1850000,
        to_be_budgeted: 0,
        age_of_money: 41,
        categories: [],
      },
      following: {
        month: '2026-10-01',
        budgeted: 2980000,
        to_be_budgeted: 150000,
        categories: [
          { id: 'c1', name: 'Groceries', goal_type: 'NEED', goal_under_funded: 0, deleted: false, hidden: false },
        ],
      },
    }) as Record<string, unknown>;
    expect(result.month_ahead).toMatchObject({ fully_funded: true, underfunded_total: 0 });
    expect(result.ready_to_assign).toMatchObject({ this_month: 0, next_month: 150 });
    expect((result.alerts as string[]).some(alert => alert.includes('ready to assign'))).toBe(true);
    expect(result.overspent).toEqual([]);
  });
});
