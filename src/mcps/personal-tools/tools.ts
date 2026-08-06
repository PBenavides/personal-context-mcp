import type { GoogleCalendarClient } from '../../connections/google-calendar.js';
import type { HevyClient } from '../../connections/hevy.js';
import type { YnabClient } from '../../connections/ynab.js';
import {
  DEFAULT_ENERGY_MODEL,
  estimateWorkoutEnergy,
  type BodyComposition,
  type EnergyModel,
  type EnergyTemplate,
  type EnergyWorkout,
} from './hevy-energy.js';
import {
  buildExercises,
  buildRoutineBody,
  HevyPayloadError,
  MUSCLE_GROUPS,
  routineToWriteShape,
  type BuiltExercise,
  type MuscleGroup,
  type TemplateResolver,
} from './hevy-payloads.js';

/**
 * Handler logic for the personal-tools MCP, ported from `my-mcp-platform` (Python/FastMCP)
 * and consolidated: the 17-tool YNAB surface collapses into 8 intent-level tools (filters
 * become parameters instead of separate tools), and Hevy's two aggregations collapse into one
 * (`hevyRecentActivity`), since answering "what have I trained lately" needed both.
 *
 * All functions take the connection client as an argument so they unit-test against fakes
 * (see `tools.test.ts`), mirroring `../personal-context/tools.ts`.
 *
 * YNAB conventions preserved from the source: raw endpoints return amounts in milliunits
 * (1000 = 1 currency unit); the report helpers divide by 1000 into currency units.
 */

// ---------------------------------------------------------------------------
// YNAB
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET = 'last-used';

/** Account types YNAB models as debt; everything else counts as an asset. */
const LIABILITY_TYPES = new Set([
  'creditCard',
  'lineOfCredit',
  'mortgage',
  'autoLoan',
  'studentLoan',
  'medicalDebt',
  'otherDebt',
]);

/** Compact per-transaction view — keeps token usage low for the default listing mode. */
const SIMPLE_TRANSACTION_FIELDS = [
  'id',
  'date',
  'amount',
  'payee_name',
  'category_name',
  'account_name',
  'memo',
  'approved',
  'cleared',
  'deleted',
] as const;

type Json = Record<string, unknown>;

/** Unwraps YNAB's `{ data: { <key>: ... } }` envelope; returns the raw result if absent. */
function unwrap(result: unknown, key: string): unknown {
  const data = (result as Json | undefined)?.data;
  if (data && typeof data === 'object' && key in (data as Json)) {
    return (data as Json)[key];
  }
  return result;
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function simplifyTransactions(transactions: unknown): unknown {
  return asArray(transactions).map(txn =>
    Object.fromEntries(
      SIMPLE_TRANSACTION_FIELDS.filter(field => field in txn).map(field => [field, txn[field]]),
    ),
  );
}

export interface YnabBudgetsArgs {
  budgetId?: string;
}

/** Without `budgetId`: all budgets. With it: that budget's full detail. */
export async function ynabBudgets(client: YnabClient, args: YnabBudgetsArgs): Promise<unknown> {
  if (args.budgetId) {
    return unwrap(await client.get(`/budgets/${args.budgetId}`), 'budget');
  }
  return unwrap(await client.get('/budgets'), 'budgets');
}

export interface YnabAccountsArgs {
  budgetId?: string;
  accountId?: string;
}

export async function ynabAccounts(client: YnabClient, args: YnabAccountsArgs): Promise<unknown> {
  const budget = args.budgetId ?? DEFAULT_BUDGET;
  if (args.accountId) {
    return unwrap(await client.get(`/budgets/${budget}/accounts/${args.accountId}`), 'account');
  }
  return unwrap(await client.get(`/budgets/${budget}/accounts`), 'accounts');
}

export interface YnabTransactionsArgs {
  budgetId?: string;
  transactionId?: string;
  accountId?: string;
  categoryId?: string;
  payeeId?: string;
  sinceDate?: string;
  type?: 'uncategorized' | 'unapproved';
  verbose?: boolean;
}

/**
 * One transaction-query tool covering the four Python listing tools plus single-get. Scope
 * precedence: transactionId > accountId > categoryId > payeeId > budget-wide. The budget-wide
 * listing requires `sinceDate` (same guard as the source — unbounded listings blow up context).
 */
export async function ynabTransactions(
  client: YnabClient,
  args: YnabTransactionsArgs,
): Promise<unknown> {
  const budget = args.budgetId ?? DEFAULT_BUDGET;
  if (args.transactionId) {
    return unwrap(
      await client.get(`/budgets/${budget}/transactions/${args.transactionId}`),
      'transaction',
    );
  }

  const params = { since_date: args.sinceDate, type: args.type };
  let endpoint = `/budgets/${budget}/transactions`;
  if (args.accountId) {
    endpoint = `/budgets/${budget}/accounts/${args.accountId}/transactions`;
  } else if (args.categoryId) {
    endpoint = `/budgets/${budget}/categories/${args.categoryId}/transactions`;
  } else if (args.payeeId) {
    endpoint = `/budgets/${budget}/payees/${args.payeeId}/transactions`;
  } else if (!args.sinceDate) {
    throw new Error(
      'sinceDate is required (YYYY-MM-DD) unless filtering by transactionId, accountId, categoryId, or payeeId',
    );
  }

  const transactions = unwrap(await client.get(endpoint, params), 'transactions');
  return args.verbose ? transactions : simplifyTransactions(transactions);
}

export interface YnabCreateTransactionArgs {
  budgetId?: string;
  accountId: string;
  date: string;
  amount: number;
  payeeName?: string;
  categoryId?: string;
  memo?: string;
}

export async function ynabCreateTransaction(
  client: YnabClient,
  args: YnabCreateTransactionArgs,
): Promise<unknown> {
  const budget = args.budgetId ?? DEFAULT_BUDGET;
  const transaction: Json = {
    account_id: args.accountId,
    date: args.date,
    amount: args.amount,
  };
  if (args.payeeName) {
    transaction.payee_name = args.payeeName;
  }
  if (args.categoryId) {
    transaction.category_id = args.categoryId;
  }
  if (args.memo) {
    transaction.memo = args.memo;
  }
  return unwrap(await client.post(`/budgets/${budget}/transactions`, { transaction }), 'transaction');
}

export interface YnabCategoriesArgs {
  budgetId?: string;
  categoryId?: string;
  month?: string;
}

/**
 * Without `categoryId`: all category groups. With it: that category, month-scoped (includes
 * goal progress) — `month` is `current` or `YYYY-MM-01`.
 */
export async function ynabCategories(
  client: YnabClient,
  args: YnabCategoriesArgs,
): Promise<unknown> {
  const budget = args.budgetId ?? DEFAULT_BUDGET;
  if (args.categoryId) {
    const month = args.month ?? 'current';
    return unwrap(
      await client.get(`/budgets/${budget}/months/${month}/categories/${args.categoryId}`),
      'category',
    );
  }
  return unwrap(await client.get(`/budgets/${budget}/categories`), 'category_groups');
}

export async function ynabPayees(
  client: YnabClient,
  args: { budgetId?: string },
): Promise<unknown> {
  return unwrap(await client.get(`/budgets/${args.budgetId ?? DEFAULT_BUDGET}/payees`), 'payees');
}

export async function ynabScheduled(
  client: YnabClient,
  args: { budgetId?: string },
): Promise<unknown> {
  return unwrap(
    await client.get(`/budgets/${args.budgetId ?? DEFAULT_BUDGET}/scheduled_transactions`),
    'scheduled_transactions',
  );
}

interface NetWorthReport {
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  account_breakdown: Json[];
}

async function netWorth(client: YnabClient, budget: string): Promise<NetWorthReport> {
  const accounts = asArray(unwrap(await client.get(`/budgets/${budget}/accounts`), 'accounts'));
  let assets = 0;
  let liabilities = 0;
  const breakdown: Json[] = [];
  for (const account of accounts) {
    if (account.deleted || account.closed) {
      continue;
    }
    const balance = typeof account.balance === 'number' ? account.balance : 0;
    const type = typeof account.type === 'string' ? account.type : '';
    const isLiability = LIABILITY_TYPES.has(type);
    if (isLiability) {
      liabilities += balance;
    } else {
      assets += balance;
    }
    breakdown.push({
      name: account.name ?? '',
      type,
      balance: balance / 1000,
      on_budget: account.on_budget ?? true,
      is_liability: isLiability,
    });
  }
  breakdown.sort((a, b) => (b.balance as number) - (a.balance as number));
  return {
    total_assets: assets / 1000,
    total_liabilities: liabilities / 1000,
    net_worth: (assets + liabilities) / 1000,
    account_breakdown: breakdown,
  };
}

function summariseMonth(month: Json): Json {
  const income = (typeof month.income === 'number' ? month.income : 0) / 1000;
  const activity = (typeof month.activity === 'number' ? month.activity : 0) / 1000;
  const spending = Math.abs(activity);
  const netSavings = income - spending;
  return {
    income,
    spending,
    net_savings: netSavings,
    savings_rate: income > 0 ? Math.round((netSavings / income) * 1000) / 10 : 0,
  };
}

async function monthlySummary(client: YnabClient, budget: string, month: string): Promise<Json> {
  const data = unwrap(await client.get(`/budgets/${budget}/months/${month}`), 'month') as Json;
  const summary = summariseMonth(data);
  const topCategories: Json[] = [];
  for (const category of asArray(data.categories)) {
    if (category.deleted) {
      continue;
    }
    const activity = (typeof category.activity === 'number' ? category.activity : 0) / 1000;
    if (activity < 0) {
      topCategories.push({
        name: category.name ?? '',
        budgeted: (typeof category.budgeted === 'number' ? category.budgeted : 0) / 1000,
        spent: Math.abs(activity),
        balance: (typeof category.balance === 'number' ? category.balance : 0) / 1000,
      });
    }
  }
  topCategories.sort((a, b) => (b.spent as number) - (a.spent as number));
  return {
    month,
    budgeted: (typeof data.budgeted === 'number' ? data.budgeted : 0) / 1000,
    ...summary,
    top_categories: topCategories.slice(0, 15),
  };
}

export interface YnabReportArgs {
  budgetId?: string;
  kind: 'net_worth' | 'monthly_summary' | 'full';
  month?: string;
  monthsBack?: number;
}

/** Aggregated reports (currency units, not milliunits) — the `reports.py` port. */
export async function ynabReport(client: YnabClient, args: YnabReportArgs): Promise<unknown> {
  const budget = args.budgetId ?? DEFAULT_BUDGET;
  if (args.kind === 'net_worth') {
    return netWorth(client, budget);
  }
  if (args.kind === 'monthly_summary') {
    return monthlySummary(client, budget, args.month ?? 'current');
  }

  const monthsBack = args.monthsBack ?? 3;
  const allMonths = asArray(unwrap(await client.get(`/budgets/${budget}/months`), 'months'));
  const history = allMonths
    .sort((a, b) => String(b.month ?? '').localeCompare(String(a.month ?? '')))
    .slice(0, monthsBack)
    .map(month => ({
      month: String(month.month ?? '').slice(0, 7),
      ...summariseMonth(month),
    }));

  return {
    generated_at: new Date().toISOString(),
    net_worth: await netWorth(client, budget),
    current_month: await monthlySummary(client, budget, 'current'),
    monthly_history: history,
  };
}

// ---------------------------------------------------------------------------
// Hevy
// ---------------------------------------------------------------------------

interface HevySet {
  type?: string;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  /** Routines plan a range where workouts record a count. */
  rep_range?: { start?: number | null; end?: number | null } | null;
}

interface HevyExercise {
  title?: string;
  exercise_template_id?: string;
  sets?: HevySet[];
}

interface HevyWorkout {
  id?: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  exercises?: HevyExercise[];
}

interface HevyWorkoutsPage {
  workouts?: HevyWorkout[];
  page_count?: number;
}

interface HevyTemplate {
  id?: string;
  title?: string;
  type?: string;
  primary_muscle_group?: string;
  secondary_muscle_groups?: string[];
  equipment?: string;
  is_custom?: boolean;
}

interface HevyTemplatesPage {
  exercise_templates?: HevyTemplate[];
  page_count?: number;
}

/**
 * All workouts from the last `days` days. The API returns newest-first pages of 10; stop
 * paginating at the first workout older than the cutoff.
 */
async function recentWorkouts(client: HevyClient, days: number): Promise<HevyWorkout[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const workouts: HevyWorkout[] = [];
  for (let page = 1; ; page++) {
    const resp = (await client.get('/v1/workouts', {
      page: String(page),
      pageSize: '10',
    })) as HevyWorkoutsPage;
    const pageWorkouts = resp.workouts ?? [];
    if (pageWorkouts.length === 0) {
      break;
    }
    let done = false;
    for (const workout of pageWorkouts) {
      const started = Date.parse(workout.start_time ?? '');
      if (Number.isFinite(started) && started >= cutoff) {
        workouts.push(workout);
      } else {
        done = true;
        break;
      }
    }
    if (done || page >= (resp.page_count ?? page)) {
      break;
    }
  }
  return workouts;
}

async function loadTemplates(client: HevyClient): Promise<Map<string, HevyTemplate>> {
  const templates = new Map<string, HevyTemplate>();
  for (let page = 1; ; page++) {
    const resp = (await client.get('/v1/exercise_templates', {
      page: String(page),
      pageSize: '100',
    })) as HevyTemplatesPage;
    for (const template of resp.exercise_templates ?? []) {
      if (template.id) {
        templates.set(template.id, template);
      }
    }
    if (page >= (resp.page_count ?? page)) {
      break;
    }
  }
  return templates;
}

/** Warmups are excluded from every count, volume and summary this module produces. */
function workingSets(exercise: HevyExercise): HevySet[] {
  return (exercise.sets ?? []).filter(set => set.type !== 'warmup');
}

function setsVolumeKg(sets: HevySet[]): number {
  return sets.reduce((total, set) => total + (set.weight_kg ?? 0) * (set.reps ?? 0), 0);
}

function durationMinutes(workout: HevyWorkout): number | null {
  const start = Date.parse(workout.start_time ?? '');
  const end = Date.parse(workout.end_time ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.round(((end - start) / 60_000) * 10) / 10;
}

/** The grouping key: the workout's calendar day in UTC, `YYYY-MM-DD`. */
function workoutDay(workout: HevyWorkout): string {
  const started = Date.parse(workout.start_time ?? '');
  return Number.isFinite(started) ? new Date(started).toISOString().slice(0, 10) : 'unknown';
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Recorded values of one set field; zero and absent both mean "not recorded" in Hevy. */
function recorded(sets: HevySet[], pick: (set: HevySet) => number | null | undefined): number[] {
  return sets.map(pick).filter((value): value is number => typeof value === 'number' && value > 0);
}

/**
 * One exercise's working sets as a sentence — what `depth: 1` and the routine listing return
 * instead of a set-by-set dump, e.g. "4 sets of 10 repetitions each with min of 15kg, max of
 * 20kg." Clauses are dropped when the field is unrecorded and duration/distance are appended in
 * their place, so a treadmill run reads as sensibly as a bench press.
 *
 * A routine's planned `rep_range` and a workout's recorded `reps` both feed the rep clause, which
 * is why "8-12" and "10" come out of the same renderer.
 */
function describeSets(sets: HevySet[], warmups = 0): string {
  const parts = [`${sets.length} set${sets.length === 1 ? '' : 's'}`];

  const reps = [
    ...recorded(sets, set => set.reps),
    ...recorded(sets, set => set.rep_range?.start),
    ...recorded(sets, set => set.rep_range?.end),
  ];
  if (reps.length > 0) {
    const [min, max] = [Math.min(...reps), Math.max(...reps)];
    parts.push(`of ${min === max ? min : `${min}-${max}`} repetitions each`);
  }

  const weights = recorded(sets, set => set.weight_kg);
  if (weights.length > 0) {
    const [min, max] = [round1(Math.min(...weights)), round1(Math.max(...weights))];
    parts.push(min === max ? `at ${min}kg` : `with min of ${min}kg, max of ${max}kg`);
  }

  const seconds = recorded(sets, set => set.duration_seconds);
  if (seconds.length > 0) {
    const total = seconds.reduce((sum, value) => sum + value, 0);
    parts.push(`totalling ${round1(total / 60)} min`);
  }

  const meters = recorded(sets, set => set.distance_meters);
  if (meters.length > 0) {
    const total = meters.reduce((sum, value) => sum + value, 0);
    parts.push(`over ${total >= 1000 ? `${round1(total / 1000)} km` : `${Math.round(total)} m`}`);
  }

  if (warmups > 0) {
    parts.push(`(+${warmups} warmup${warmups === 1 ? '' : 's'})`);
  }

  return `${parts.join(' ')}.`;
}

/** First-level summarization: cardio is the `cardio` muscle group, muscles is everything else. */
export const ACTIVITY_TYPES = ['all', 'muscles', 'cardio'] as const;
type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const DEFAULT_ACTIVITY_DAYS = 4;
/** `depth: 1` renders every set of every exercise, so the window it may span is capped. */
export const MAX_DEEP_ACTIVITY_DAYS = 4;

/** Working sets of one exercise on one day, kept until the response decides ids vs. prose. */
interface ExerciseTally {
  templateId: string;
  sets: HevySet[];
}

interface MuscleDay {
  totalSets: number;
  totalVolumeKg: number;
  asPrimary: number;
  asSecondary: number;
  exercises: Map<string, ExerciseTally>;
}

/**
 * Recent training, grouped **by muscle group and then by day** — the merge of what used to be
 * `hevy_recent_activity` (session totals) and `hevy_activity_by_muscle` (muscle breakdown).
 *
 * One call now answers "have I trained triceps this week, and how hard?", which previously took
 * a muscle-group call plus a session call plus the caller's own date arithmetic. Session metadata
 * (workout id, duration) is kept alongside the breakdown; the ids are what `hevy_get_workout`
 * and `hevy_write_workout` need, and nothing else exposes them.
 *
 * `type`/`specific` choose which groups appear; `depth: 1` swaps each day's exercise-id map for a
 * written summary of the sets. Deep output is only allowed once the window is narrowed — the two
 * guards mirror the point of the tool, which is to stay cheap enough to call every time.
 */
export async function hevyRecentActivity(
  client: HevyClient,
  args: { days?: number; type?: string; depth?: number; specific?: string },
): Promise<unknown> {
  const days = args.days ?? DEFAULT_ACTIVITY_DAYS;
  const depth = args.depth ?? 0;
  const specific = args.specific?.trim().toLowerCase() || undefined;

  if (depth !== 0 && depth !== 1) {
    throw new Error(`depth must be 0 or 1 (got ${JSON.stringify(args.depth)})`);
  }
  if (specific && !MUSCLE_GROUPS.includes(specific as MuscleGroup)) {
    throw new Error(
      `unknown muscle group ${JSON.stringify(specific)}; one of: ${MUSCLE_GROUPS.join(', ')}`,
    );
  }
  if (args.type !== undefined && !ACTIVITY_TYPES.includes(args.type as ActivityType)) {
    throw new Error(`type must be one of: ${ACTIVITY_TYPES.join(', ')}`);
  }

  // A specific group implies its meta-category, so `specific: "triceps", depth: 1` — the tool's
  // whole point — works without also having to spell out `type: "muscles"`.
  const type: ActivityType =
    (args.type as ActivityType | undefined) ??
    (specific ? (specific === 'cardio' ? 'cardio' : 'muscles') : 'all');

  if (specific && (specific === 'cardio') !== (type === 'cardio')) {
    throw new Error(
      `specific: ${JSON.stringify(specific)} contradicts type: ${JSON.stringify(type)}`,
    );
  }
  if (depth === 1 && type === 'all') {
    throw new Error(
      'depth: 1 needs a narrower scope than type: "all" — pass type: "muscles" or "cardio", or a ' +
        'specific muscle group',
    );
  }
  if (depth === 1 && days > MAX_DEEP_ACTIVITY_DAYS) {
    throw new Error(
      `depth: 1 covers at most ${MAX_DEEP_ACTIVITY_DAYS} days (got ${days}); lower days, or use ` +
        'depth: 0',
    );
  }

  const [workouts, templates] = await Promise.all([
    recentWorkouts(client, days),
    loadTemplates(client),
  ]);

  const keep = (group: string): boolean => {
    if (specific) {
      return group === specific;
    }
    if (type === 'cardio') {
      return group === 'cardio';
    }
    if (type === 'muscles') {
      return group !== 'cardio';
    }
    return true;
  };

  const muscles = new Map<string, Map<string, MuscleDay>>();
  const add = (
    group: string,
    day: string,
    role: 'primary' | 'secondary',
    exercise: HevyExercise,
    sets: HevySet[],
  ): void => {
    if (!keep(group)) {
      return;
    }
    const byDay = muscles.get(group) ?? new Map<string, MuscleDay>();
    const entry = byDay.get(day) ?? {
      totalSets: 0,
      totalVolumeKg: 0,
      asPrimary: 0,
      asSecondary: 0,
      exercises: new Map<string, ExerciseTally>(),
    };
    entry.totalSets += sets.length;
    entry.totalVolumeKg += setsVolumeKg(sets);
    if (role === 'primary') {
      entry.asPrimary += sets.length;
    } else {
      entry.asSecondary += sets.length;
    }
    const title = exercise.title ?? 'Unknown';
    const tally = entry.exercises.get(title) ?? {
      templateId: exercise.exercise_template_id ?? '',
      sets: [],
    };
    tally.sets.push(...sets);
    entry.exercises.set(title, tally);
    byDay.set(day, entry);
    muscles.set(group, byDay);
  };

  // Session totals stay window-wide (every group, cardio included) — they answer "how much did I
  // train", while `muscle_groups` answers "what did I train", and only that honours the filters.
  let totalSets = 0;
  let totalVolumeKg = 0;
  const sessions = workouts.map(workout => {
    const day = workoutDay(workout);
    let sessionSets = 0;
    let sessionVolume = 0;
    for (const exercise of workout.exercises ?? []) {
      const sets = workingSets(exercise);
      sessionSets += sets.length;
      sessionVolume += setsVolumeKg(sets);
      const template = templates.get(exercise.exercise_template_id ?? '');
      add(template?.primary_muscle_group ?? 'other', day, 'primary', exercise, sets);
      for (const secondary of template?.secondary_muscle_groups ?? []) {
        add(secondary, day, 'secondary', exercise, sets);
      }
    }
    totalSets += sessionSets;
    totalVolumeKg += sessionVolume;
    return {
      workout_id: workout.id ?? null,
      title: workout.title ?? 'Untitled',
      date: day,
      start_time: workout.start_time ?? '',
      duration_minutes: durationMinutes(workout),
      working_sets: sessionSets,
      volume_kg: round1(sessionVolume),
    };
  });

  const volumeOf = (byDay: Map<string, MuscleDay>): number =>
    [...byDay.values()].reduce((total, entry) => total + entry.totalVolumeKg, 0);

  const muscleGroups: Record<string, Record<string, unknown>> = {};
  for (const [group, byDay] of [...muscles.entries()].sort(
    (a, b) => volumeOf(b[1]) - volumeOf(a[1]),
  )) {
    // Newest day first, so "did I train this yesterday?" is the first thing read.
    const dayEntries = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    muscleGroups[group] = Object.fromEntries(
      dayEntries.map(([day, entry]) => {
        const exercises = [...entry.exercises.entries()];
        return [
          day,
          {
            total_sets: entry.totalSets,
            total_volume_kg: round1(entry.totalVolumeKg),
            as_primary: entry.asPrimary,
            as_secondary: entry.asSecondary,
            ...(depth === 1
              ? {
                  exercises_text: Object.fromEntries(
                    exercises.map(([title, tally]) => [title, describeSets(tally.sets)]),
                  ),
                }
              : {
                  exercises_ids: Object.fromEntries(
                    exercises.map(([title, tally]) => [title, tally.templateId]),
                  ),
                }),
          },
        ];
      }),
    );
  }

  return {
    period_days: days,
    type,
    depth,
    ...(specific ? { specific } : {}),
    total_workouts: workouts.length,
    total_working_sets: totalSets,
    total_volume_kg: round1(totalVolumeKg),
    sessions,
    muscle_groups: muscleGroups,
  };
}

/**
 * Estimated energy cost of one logged workout.
 *
 * Fetches three things and hands them to the pure model in `hevy-energy.ts`: the workout, the
 * exercise templates (for the muscle groups that scale each exercise's cost), and the latest body
 * measurement (for a personalized resting rate). Explicit body arguments win over the measurement,
 * which is the escape hatch when Hevy's is stale or missing.
 *
 * The result always carries `accuracy_note` and a `warnings` list — the estimate is weak enough
 * that shipping the number without them would be misleading.
 */
export async function hevyCalculateBurntCalories(
  client: HevyClient,
  args: {
    workoutId: string;
    weightKg?: number;
    fatPercent?: number;
    leanMassKg?: number;
  },
  model: EnergyModel = DEFAULT_ENERGY_MODEL,
): Promise<unknown> {
  const wantsMeasurement = args.weightKg === undefined || args.leanMassKg === undefined;

  const [workoutResp, templates, measurement] = await Promise.all([
    client.get(`/v1/workouts/${args.workoutId}`) as Promise<{ workout?: EnergyWorkout }>,
    loadTemplates(client),
    wantsMeasurement
      ? latestMeasurement(client).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  const workout = (workoutResp?.workout ?? workoutResp) as EnergyWorkout | undefined;
  if (!workout || (!workout.id && !workout.start_time && !workout.exercises)) {
    throw new Error(
      `no workout found for id ${JSON.stringify(args.workoutId)}; ids come from ` +
        "hevy_recent_activity's session list",
    );
  }

  const body: BodyComposition = {
    weightKg: args.weightKg ?? numeric(measurement?.weight_kg),
    leanMassKg: args.leanMassKg ?? numeric(measurement?.lean_mass_kg),
    fatPercent: args.fatPercent ?? numeric(measurement?.fat_percent),
    measuredOn:
      args.weightKg === undefined && args.leanMassKg === undefined
        ? measurement?.date
        : undefined,
  };

  if (body.weightKg === undefined && body.leanMassKg === undefined) {
    throw new Error(
      'no body mass available: the Hevy account has no body measurement with a weight. Log one ' +
        'in the app, or pass weight_kg (and ideally fat_percent) to this tool.',
    );
  }

  const estimate = estimateWorkoutEnergy(
    workout,
    templates as Map<string, EnergyTemplate>,
    body,
    model,
  );

  if (args.weightKg !== undefined || args.leanMassKg !== undefined || args.fatPercent !== undefined) {
    estimate.warnings.push('Body composition was supplied by the caller, not read from Hevy.');
  }
  return estimate;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Hevy — writes
// ---------------------------------------------------------------------------
//
// The procedure is the same for every write: resolve exercise names to template ids, build the
// body (`hevy-payloads.ts` validates and throws before anything is sent), then POST or PUT.
// `dry_run` stops after the build and returns the body instead.
//
// Hevy has no PATCH, so `PUT` replaces the whole object. The update paths therefore read the
// current object and merge the caller's changes over it — omitting `exercises` preserves them
// rather than deleting them.

/** Ranks loaded templates against a free-text query: exact, then prefix, then substring, then
 *  all-words-present; ties break on title length, since the shortest title is usually the
 *  plainest variant. Pure over an already-loaded cache, so it costs no extra API calls. */
function rankTemplates(
  templates: Map<string, HevyTemplate>,
  query: string,
  limit: number,
): HevyTemplate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }
  const words = needle.split(/\s+/);

  const scored: { rank: number; length: number; template: HevyTemplate }[] = [];
  for (const template of templates.values()) {
    const title = (template.title ?? '').toLowerCase();
    let rank: number;
    if (title === needle) {
      rank = 0;
    } else if (title.startsWith(needle)) {
      rank = 1;
    } else if (title.includes(needle)) {
      rank = 2;
    } else if (words.every(word => title.includes(word))) {
      rank = 3;
    } else {
      continue;
    }
    scored.push({ rank, length: title.length, template });
  }

  scored.sort((a, b) => a.rank - b.rank || a.length - b.length);
  return scored.slice(0, limit).map(entry => entry.template);
}

/** Does this template train `group`, in either role? */
function trainsMuscleGroup(template: HevyTemplate, group: string): boolean {
  return (
    template.primary_muscle_group === group ||
    (template.secondary_muscle_groups ?? []).includes(group)
  );
}

/** The catalog's own field is `id`; every write asks for `exercise_template_id`. Say so. */
function templateResult(template: HevyTemplate): Record<string, unknown> {
  return {
    exercise_template_id: template.id,
    title: template.title,
    type: template.type,
    primary_muscle_group: template.primary_muscle_group,
    secondary_muscle_groups: template.secondary_muscle_groups ?? [],
    equipment: template.equipment,
    is_custom: template.is_custom ?? false,
  };
}

/**
 * Search the exercise catalog — Hevy's stock templates plus the account's custom ones — by name,
 * by muscle group, or both. This is the only place `exercise_template_id` comes from, so every
 * write starts here.
 *
 * Browsing a muscle group is a first-class case, not just a filter on a name search: "what cardio
 * options exist" and "what else hits lats" have no name to search for. With no query, matches
 * come back primary-role first, then secondary, each alphabetical.
 */
export async function hevySearchExerciseCatalog(
  client: HevyClient,
  args: { query?: string; muscleGroup?: string; limit?: number },
): Promise<unknown> {
  const limit = args.limit ?? 20;
  const query = args.query?.trim() ?? '';
  const muscleGroup = args.muscleGroup?.trim().toLowerCase() || undefined;

  if (!query && !muscleGroup) {
    throw new Error('pass query (an exercise name), muscle_group, or both');
  }
  if (muscleGroup && !MUSCLE_GROUPS.includes(muscleGroup as MuscleGroup)) {
    throw new Error(
      `unknown muscle group ${JSON.stringify(muscleGroup)}; one of: ${MUSCLE_GROUPS.join(', ')}`,
    );
  }

  const all = await loadTemplates(client);
  const scoped = muscleGroup
    ? new Map([...all].filter(([, template]) => trainsMuscleGroup(template, muscleGroup)))
    : all;

  const matches = query
    ? rankTemplates(scoped, query, limit)
    : [...scoped.values()]
        .sort(
          (a, b) =>
            Number(b.primary_muscle_group === muscleGroup) -
              Number(a.primary_muscle_group === muscleGroup) ||
            (a.title ?? '').localeCompare(b.title ?? ''),
        )
        .slice(0, limit);

  return {
    ...(query ? { query } : {}),
    ...(muscleGroup ? { muscle_group: muscleGroup } : {}),
    match_count: matches.length,
    ...(muscleGroup && !query ? { total_in_group: scoped.size } : {}),
    matches: matches.map(templateResult),
  };
}

/**
 * Builds a resolver over a loaded template cache. Refuses ambiguous names with the candidates
 * listed rather than guessing, so a wrong exercise never gets silently written.
 */
function templateResolver(templates: Map<string, HevyTemplate>): TemplateResolver {
  return (name: string): string => {
    const matches = rankTemplates(templates, name, 10);
    if (matches.length === 0) {
      throw new HevyPayloadError(
        `no exercise template matches ${JSON.stringify(name)}; search with ` +
          'hevy_search_exercise_catalog, or create one with hevy_create_custom_exercise',
      );
    }
    const needle = name.trim().toLowerCase();
    const exact = matches.find(t => (t.title ?? '').trim().toLowerCase() === needle);
    if (exact?.id) {
      return exact.id;
    }
    if (matches.length === 1 && matches[0].id) {
      return matches[0].id;
    }
    const listed = matches
      .slice(0, 5)
      .map(t => `${JSON.stringify(t.title ?? '')} (${t.id ?? '?'})`)
      .join(', ');
    throw new HevyPayloadError(
      `exercise name ${JSON.stringify(name)} is ambiguous — ${matches.length} templates match: ` +
        `${listed}. Pass an exact title or an exercise_template_id.`,
    );
  };
}

/** Only load the template cache when some exercise is identified by name. */
async function resolverIfNeeded(
  client: HevyClient,
  exercises: unknown,
): Promise<TemplateResolver | undefined> {
  const needsNames =
    Array.isArray(exercises) &&
    exercises.some(spec => {
      if (typeof spec !== 'object' || spec === null) {
        return false;
      }
      const record = spec as Record<string, unknown>;
      const hasId = Boolean(record.exercise_template_id ?? record.template_id ?? record.id);
      return !hasId;
    });
  return needsNames ? templateResolver(await loadTemplates(client)) : undefined;
}

function dryRunResult(method: string, endpoint: string, payload: unknown): unknown {
  return { dry_run: true, method, endpoint, payload };
}

type ExerciseMode = 'replace' | 'append';

/** Merge current exercises with the caller's, per `mode`; `undefined` incoming keeps them all. */
function mergeExercises(
  existing: BuiltExercise[],
  incoming: BuiltExercise[] | undefined,
  mode: ExerciseMode,
): BuiltExercise[] {
  if (incoming === undefined) {
    return existing;
  }
  return mode === 'append' ? [...existing, ...incoming] : incoming;
}

/**
 * One logged workout in full. Ids come from `hevy_recent_activity`'s session list — nothing else
 * in the surface exposes them. Tolerates the envelope some Hevy read endpoints wrap results in.
 */
export async function hevyGetWorkout(
  client: HevyClient,
  args: { workoutId: string },
): Promise<unknown> {
  const resp = (await client.get(`/v1/workouts/${args.workoutId}`)) as { workout?: unknown };
  return resp?.workout ?? resp;
}

interface HevyRoutineExercise {
  title?: string;
  exercise_template_id?: string;
  notes?: string | null;
  rest_seconds?: string | number | null;
  supersets_id?: number | null;
  sets?: HevySet[];
}

interface HevyRoutine {
  id?: string;
  title?: string;
  notes?: string | null;
  folder_id?: number | null;
  exercises?: HevyRoutineExercise[];
}

interface HevyRoutinesPage {
  routines?: HevyRoutine[];
  page_count?: number;
}

/**
 * One planned exercise as a sentence: its sets, then rest and superset when the routine sets
 * them. Warmups are counted rather than described — they are part of the plan, but not the point
 * of it.
 */
function describeRoutineExercise(exercise: HevyRoutineExercise): string {
  const sets = exercise.sets ?? [];
  const working = sets.filter(set => set.type !== 'warmup');
  const warmups = sets.length - working.length;

  const parts = [
    working.length > 0
      ? describeSets(working, warmups)
      : `${warmups} warmup set${warmups === 1 ? '' : 's'} only.`,
  ];

  const rest = Number(exercise.rest_seconds);
  if (Number.isFinite(rest) && rest > 0) {
    parts.push(`${Math.trunc(rest)}s rest.`);
  }
  if (exercise.supersets_id !== null && exercise.supersets_id !== undefined) {
    parts.push(`Superset ${exercise.supersets_id}.`);
  }
  if (exercise.notes) {
    parts.push(`Note: ${exercise.notes}`);
  }
  return parts.join(' ');
}

/**
 * A routine as a plan you can read, not a set-by-set dump: each exercise becomes one sentence,
 * keyed by its position so the order of the plan survives and two entries for the same movement
 * stay distinct. Null fields are omitted entirely rather than shown as null.
 */
function summarizeRoutine(routine: HevyRoutine): Record<string, unknown> {
  const exercises = routine.exercises ?? [];
  return {
    routine_id: routine.id,
    title: routine.title ?? 'Untitled',
    ...(routine.folder_id === null || routine.folder_id === undefined
      ? {}
      : { folder_id: routine.folder_id }),
    ...(routine.notes ? { notes: routine.notes } : {}),
    exercise_count: exercises.length,
    total_sets: exercises.reduce((total, exercise) => total + (exercise.sets ?? []).length, 0),
    exercises: Object.fromEntries(
      exercises.map((exercise, index) => [
        `${index + 1}. ${exercise.title ?? 'Unknown'}`,
        describeRoutineExercise(exercise),
      ]),
    ),
  };
}

/** All routines, or one when `routineId` is given. `GET /v1/routines/{id}` wraps its result. */
export async function hevyRoutines(
  client: HevyClient,
  args: { routineId?: string },
): Promise<unknown> {
  if (args.routineId) {
    const resp = (await client.get(`/v1/routines/${args.routineId}`)) as {
      routine?: HevyRoutine;
    };
    return summarizeRoutine(resp.routine ?? (resp as HevyRoutine));
  }
  const routines: HevyRoutine[] = [];
  for (let page = 1; ; page++) {
    const resp = (await client.get('/v1/routines', {
      page: String(page),
      pageSize: '10',
    })) as HevyRoutinesPage;
    routines.push(...(resp.routines ?? []));
    if (page >= (resp.page_count ?? page)) {
      break;
    }
  }
  return { routine_count: routines.length, routines: routines.map(summarizeRoutine) };
}

// ---------------------------------------------------------------------------
// Hevy — body measurements
// ---------------------------------------------------------------------------

interface HevyMeasurement {
  date?: string;
  [field: string]: unknown;
}

interface HevyMeasurementsPage {
  body_measurements?: HevyMeasurement[];
  page_count?: number;
}

/** Bookkeeping the API returns but nothing can be done with — measurements are keyed by date. */
const MEASUREMENT_NOISE_FIELDS = new Set(['id', 'created_at', 'updated_at']);

/**
 * Drop nulls and bookkeeping, keep everything else. Most of the ~18 measurement fields are null
 * on any given entry, and passing the rest through unshaped means a field Hevy adds later shows
 * up without a code change.
 */
function shapeMeasurement(measurement: HevyMeasurement): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(measurement).filter(
      ([field, value]) => value !== null && value !== undefined && !MEASUREMENT_NOISE_FIELDS.has(field),
    ),
  );
}

/** `/v1/body_measurements` pages at 10; this bounds a full sweep at 250 entries. */
export const MAX_MEASUREMENT_PAGES = 25;

/**
 * The most recent measurement, or undefined when none is logged. Only the first page is read —
 * whichever end the newest entry sits on, it is on page 1 or the last page, and the caller only
 * needs a body mass, so a full sweep would be wasteful here.
 */
async function latestMeasurement(client: HevyClient): Promise<HevyMeasurement | undefined> {
  const first = (await client.get('/v1/body_measurements', {
    page: '1',
    pageSize: '10',
  })) as HevyMeasurementsPage;
  const entries = [...(first.body_measurements ?? [])];
  const pageCount = first.page_count ?? 1;
  if (pageCount > 1) {
    const last = (await client.get('/v1/body_measurements', {
      page: String(pageCount),
      pageSize: '10',
    })) as HevyMeasurementsPage;
    entries.push(...(last.body_measurements ?? []));
  }
  entries.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return entries[0];
}

/**
 * Logged body measurements — weight, lean mass, body fat and the girth fields — newest first.
 *
 * `date` fetches one entry; otherwise the window is the most recent `limit` entries, optionally
 * confined to the last `days`. The API documents no ordering for the list, so this sweeps the
 * pages and sorts by date rather than trusting a guess (measurements are sparse, so the sweep is
 * a handful of requests).
 */
export async function hevyBodyMeasurements(
  client: HevyClient,
  args: { date?: string; days?: number; limit?: number },
): Promise<unknown> {
  if (args.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
      throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(args.date)}`);
    }
    const resp = (await client.get(`/v1/body_measurements/${args.date}`)) as {
      body_measurement?: HevyMeasurement;
    };
    return { measurement: shapeMeasurement(resp?.body_measurement ?? (resp as HevyMeasurement)) };
  }

  const limit = args.limit ?? 10;
  const entries: HevyMeasurement[] = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    const resp = (await client.get('/v1/body_measurements', {
      page: String(page),
      pageSize: '10',
    })) as HevyMeasurementsPage;
    entries.push(...(resp.body_measurements ?? []));
    if (page >= (resp.page_count ?? page)) {
      break;
    }
    if (page >= MAX_MEASUREMENT_PAGES) {
      truncated = true;
      break;
    }
  }

  entries.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const cutoff = args.days === undefined ? undefined : Date.now() - args.days * 86_400_000;
  const windowed =
    cutoff === undefined
      ? entries
      : entries.filter(entry => Date.parse(entry.date ?? '') >= cutoff);

  return {
    ...(args.days === undefined ? {} : { period_days: args.days }),
    total_recorded: entries.length,
    entry_count: Math.min(windowed.length, limit),
    ...(truncated ? { truncated: true } : {}),
    measurements: windowed.slice(0, limit).map(shapeMeasurement),
  };
}

interface HevyFolder {
  id?: number;
  title?: string;
}

interface HevyFoldersPage {
  routine_folders?: HevyFolder[];
  page_count?: number;
}

async function listFolders(client: HevyClient): Promise<HevyFolder[]> {
  const folders: HevyFolder[] = [];
  for (let page = 1; ; page++) {
    const resp = (await client.get('/v1/routine_folders', {
      page: String(page),
      pageSize: '10',
    })) as HevyFoldersPage;
    folders.push(...(resp.routine_folders ?? []));
    if (page >= (resp.page_count ?? page)) {
      break;
    }
  }
  return folders;
}

/** Resolve a folder name to its id, optionally creating the folder. */
async function resolveFolderId(
  client: HevyClient,
  name: string,
  create: boolean,
): Promise<number> {
  const needle = name.trim().toLowerCase();
  const existing = (await listFolders(client)).find(
    folder => (folder.title ?? '').trim().toLowerCase() === needle,
  );
  if (existing?.id !== undefined) {
    return existing.id;
  }
  if (!create) {
    throw new HevyPayloadError(
      `no routine folder named ${JSON.stringify(name)}; pass create_folder=true to create it`,
    );
  }
  const created = (await client.post('/v1/routine_folders', {
    routine_folder: { title: name },
  })) as { routine_folder?: HevyFolder; id?: number };
  const id = created.routine_folder?.id ?? created.id;
  if (id === undefined) {
    throw new HevyPayloadError(
      `created routine folder ${JSON.stringify(name)} but the API returned no id`,
    );
  }
  return id;
}

/**
 * Create a routine, or update one when `routineId` is given.
 *
 * On update, fields left undefined keep their current value, and `folder_id` is unavailable —
 * the API only accepts it on create, so routines cannot be moved between folders.
 */
export async function hevyWriteRoutine(
  client: HevyClient,
  args: {
    routineId?: string;
    title?: string;
    exercises?: unknown;
    notes?: string;
    folderName?: string;
    createFolder?: boolean;
    exerciseMode?: ExerciseMode;
    dryRun?: boolean;
  },
): Promise<unknown> {
  const resolve = await resolverIfNeeded(client, args.exercises);
  const built =
    args.exercises === undefined ? undefined : buildExercises(args.exercises, true, resolve);

  if (!args.routineId) {
    if (!args.title) {
      throw new HevyPayloadError('creating a routine requires a title');
    }
    if (built === undefined) {
      throw new HevyPayloadError('creating a routine requires exercises');
    }
    const folderId = args.folderName
      ? await resolveFolderId(client, args.folderName, args.createFolder ?? false)
      : null;
    const body = buildRoutineBody({
      title: args.title,
      exercises: built,
      notes: args.notes,
      folderId,
    });
    return args.dryRun
      ? dryRunResult('POST', '/v1/routines', body)
      : client.post('/v1/routines', body);
  }

  if (args.folderName) {
    throw new HevyPayloadError(
      'a routine cannot be moved between folders; the Hevy API only accepts a folder when the ' +
        'routine is created',
    );
  }

  const resp = (await client.get(`/v1/routines/${args.routineId}`)) as { routine?: HevyRoutine };
  const current = resp.routine ?? (resp as HevyRoutine);
  const body = buildRoutineBody({
    title: args.title ?? current.title ?? '',
    exercises: mergeExercises(
      routineToWriteShape(current as { exercises?: [] }),
      built,
      args.exerciseMode ?? 'replace',
    ),
    notes: args.notes ?? current.notes ?? undefined,
    includeFolderId: false,
  });
  const endpoint = `/v1/routines/${args.routineId}`;
  return args.dryRun ? dryRunResult('PUT', endpoint, body) : client.put(endpoint, body);
}

// ---------------------------------------------------------------------------
// Google Calendar
// ---------------------------------------------------------------------------

interface GcalTime {
  dateTime?: string;
  date?: string;
}

interface GcalAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
}

interface GcalEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GcalTime;
  end?: GcalTime;
  status?: string;
  htmlLink?: string;
  attendees?: GcalAttendee[];
  organizer?: { email?: string };
  created?: string;
  updated?: string;
  recurringEventId?: string;
}

/** Normalizes a raw Google Calendar event — the `_format_event` port. */
function formatEvent(raw: GcalEvent): Json {
  const start = raw.start ?? {};
  const end = raw.end ?? {};
  return {
    id: raw.id,
    summary: raw.summary ?? '(No title)',
    description: raw.description,
    location: raw.location,
    start: start.dateTime ?? start.date,
    end: end.dateTime ?? end.date,
    all_day: 'date' in start && !('dateTime' in start),
    status: raw.status,
    html_link: raw.htmlLink,
    attendees: (raw.attendees ?? []).map(a => ({
      email: a.email,
      display_name: a.displayName,
      response_status: a.responseStatus,
    })),
    organizer: raw.organizer?.email,
    created: raw.created,
    updated: raw.updated,
    recurring_event_id: raw.recurringEventId,
  };
}

/** URL-encodes calendar IDs that contain special characters (e.g. email addresses). */
function encodeCalendarId(calendarId: string): string {
  return encodeURIComponent(calendarId);
}

interface GcalCalendarListEntry {
  id?: string;
  summary?: string;
  description?: string;
  timeZone?: string;
  accessRole?: string;
  primary?: boolean;
  backgroundColor?: string;
}

export interface GcalListCalendarsArgs {
  minAccessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
}

export async function gcalListCalendars(
  client: GoogleCalendarClient,
  args: GcalListCalendarsArgs,
): Promise<unknown> {
  const items: GcalCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const resp = (await client.get('/users/me/calendarList', {
      minAccessRole: args.minAccessRole,
      pageToken,
    })) as { items?: GcalCalendarListEntry[]; nextPageToken?: string };
    items.push(...(resp.items ?? []));
    pageToken = resp.nextPageToken;
  } while (pageToken);

  return {
    calendars: items.map(c => ({
      id: c.id,
      summary: c.summary,
      description: c.description,
      time_zone: c.timeZone,
      access_role: c.accessRole,
      primary: c.primary ?? false,
      background_color: c.backgroundColor,
    })),
  };
}

export interface GcalListEventsArgs {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  query?: string;
  maxResults?: number;
}

export async function gcalListEvents(
  client: GoogleCalendarClient,
  args: GcalListEventsArgs,
): Promise<unknown> {
  const calendarId = args.calendarId ?? 'primary';
  const maxResults = Math.min(Math.max(1, args.maxResults ?? 50), 2500);

  const items: GcalEvent[] = [];
  let pageToken: string | undefined;
  do {
    const resp = (await client.get(`/calendars/${encodeCalendarId(calendarId)}/events`, {
      maxResults: String(maxResults),
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      q: args.query,
      pageToken,
    })) as { items?: GcalEvent[]; nextPageToken?: string };
    items.push(...(resp.items ?? []));
    pageToken = resp.nextPageToken;
  } while (pageToken && items.length < maxResults);

  const page = items.slice(0, maxResults);
  return { calendar_id: calendarId, count: page.length, events: page.map(formatEvent) };
}

export interface GcalGetEventArgs {
  eventId: string;
  calendarId?: string;
}

export async function gcalGetEvent(
  client: GoogleCalendarClient,
  args: GcalGetEventArgs,
): Promise<unknown> {
  const calendarId = args.calendarId ?? 'primary';
  const raw = (await client.get(
    `/calendars/${encodeCalendarId(calendarId)}/events/${args.eventId}`,
  )) as GcalEvent;
  return formatEvent(raw);
}

export interface GcalCreateEventArgs {
  summary: string;
  start: string;
  end: string;
  calendarId?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  allDay?: boolean;
  timezone?: string;
  sendNotifications?: boolean;
}

export async function gcalCreateEvent(
  client: GoogleCalendarClient,
  args: GcalCreateEventArgs,
): Promise<unknown> {
  const calendarId = args.calendarId ?? 'primary';
  const body: Json = { summary: args.summary };

  if (args.allDay) {
    body.start = { date: args.start };
    body.end = { date: args.end };
  } else {
    const timeZone = args.timezone ?? 'UTC';
    body.start = { dateTime: args.start, timeZone };
    body.end = { dateTime: args.end, timeZone };
  }
  if (args.description) {
    body.description = args.description;
  }
  if (args.location) {
    body.location = args.location;
  }
  if (args.attendees) {
    body.attendees = args.attendees.map(email => ({ email }));
  }

  const raw = (await client.post(
    `/calendars/${encodeCalendarId(calendarId)}/events`,
    body,
    args.sendNotifications ? { sendUpdates: 'all' } : undefined,
  )) as GcalEvent;
  return formatEvent(raw);
}

export interface GcalUpdateEventArgs {
  eventId: string;
  calendarId?: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
  attendees?: string[];
  timezone?: string;
  sendNotifications?: boolean;
}

export async function gcalUpdateEvent(
  client: GoogleCalendarClient,
  args: GcalUpdateEventArgs,
): Promise<unknown> {
  const calendarId = args.calendarId ?? 'primary';
  const body: Json = {};

  if (args.summary !== undefined) {
    body.summary = args.summary;
  }
  if (args.description !== undefined) {
    body.description = args.description;
  }
  if (args.location !== undefined) {
    body.location = args.location;
  }
  if (args.attendees !== undefined) {
    body.attendees = args.attendees.map(email => ({ email }));
  }
  const timeZone = args.timezone ?? 'UTC';
  if (args.start !== undefined) {
    body.start = args.start.includes('T') ? { dateTime: args.start, timeZone } : { date: args.start };
  }
  if (args.end !== undefined) {
    body.end = args.end.includes('T') ? { dateTime: args.end, timeZone } : { date: args.end };
  }

  const raw = (await client.patch(
    `/calendars/${encodeCalendarId(calendarId)}/events/${args.eventId}`,
    body,
    args.sendNotifications ? { sendUpdates: 'all' } : undefined,
  )) as GcalEvent;
  return formatEvent(raw);
}

export interface GcalDeleteEventArgs {
  eventId: string;
  calendarId?: string;
  sendNotifications?: boolean;
}

export async function gcalDeleteEvent(
  client: GoogleCalendarClient,
  args: GcalDeleteEventArgs,
): Promise<unknown> {
  const calendarId = args.calendarId ?? 'primary';
  await client.delete(
    `/calendars/${encodeCalendarId(calendarId)}/events/${args.eventId}`,
    args.sendNotifications ? { sendUpdates: 'all' } : undefined,
  );
  return { deleted: true, event_id: args.eventId };
}

export interface GcalFreeBusyArgs {
  timeMin: string;
  timeMax: string;
  calendarIds?: string[];
}

interface GcalFreeBusyCalendarResult {
  busy?: { start?: string; end?: string }[];
  errors?: Json[];
}

export async function gcalFreeBusy(
  client: GoogleCalendarClient,
  args: GcalFreeBusyArgs,
): Promise<unknown> {
  const ids = args.calendarIds ?? ['primary'];
  const resp = (await client.post('/freeBusy', {
    timeMin: args.timeMin,
    timeMax: args.timeMax,
    items: ids.map(id => ({ id })),
  })) as { calendars?: Record<string, GcalFreeBusyCalendarResult> };

  const calendars: Json = {};
  for (const [id, data] of Object.entries(resp.calendars ?? {})) {
    calendars[id] = { busy: data.busy ?? [], errors: data.errors ?? [] };
  }
  return { time_min: args.timeMin, time_max: args.timeMax, calendars };
}
