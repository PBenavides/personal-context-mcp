import type { GoogleCalendarClient } from '../../connections/google-calendar.js';
import type { HevyClient } from '../../connections/hevy.js';
import type { YnabClient } from '../../connections/ynab.js';

/**
 * Handler logic for the personal-tools MCP, ported from `my-mcp-platform` (Python/FastMCP)
 * and consolidated: the 17-tool YNAB surface collapses into 8 intent-level tools (filters
 * become parameters instead of separate tools), Hevy keeps its 2 aggregation tools.
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
}

interface HevyExercise {
  title?: string;
  exercise_template_id?: string;
  sets?: HevySet[];
}

interface HevyWorkout {
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
  primary_muscle_group?: string;
  secondary_muscle_groups?: string[];
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

/** Working sets and volume (kg) for one exercise; warmup sets excluded throughout. */
function exerciseTotals(exercise: HevyExercise): { sets: number; volumeKg: number } {
  let sets = 0;
  let volumeKg = 0;
  for (const set of exercise.sets ?? []) {
    if (set.type === 'warmup') {
      continue;
    }
    sets += 1;
    volumeKg += (set.weight_kg ?? 0) * (set.reps ?? 0);
  }
  return { sets, volumeKg };
}

function durationMinutes(workout: HevyWorkout): number | null {
  const start = Date.parse(workout.start_time ?? '');
  const end = Date.parse(workout.end_time ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return Math.round(((end - start) / 60_000) * 10) / 10;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

export async function hevyRecentActivity(
  client: HevyClient,
  args: { days?: number },
): Promise<unknown> {
  const days = args.days ?? 14;
  const workouts = await recentWorkouts(client, days);

  let totalSets = 0;
  let totalVolumeKg = 0;
  const uniqueExercises = new Set<string>();
  const sessions = workouts.map(workout => {
    let sessionSets = 0;
    let sessionVolume = 0;
    const exercises: string[] = [];
    for (const exercise of workout.exercises ?? []) {
      exercises.push(exercise.title ?? 'Unknown');
      uniqueExercises.add(exercise.title ?? 'Unknown');
      const totals = exerciseTotals(exercise);
      sessionSets += totals.sets;
      sessionVolume += totals.volumeKg;
    }
    totalSets += sessionSets;
    totalVolumeKg += sessionVolume;
    return {
      title: workout.title ?? 'Untitled',
      date: workout.start_time ?? '',
      duration_minutes: durationMinutes(workout),
      exercises,
      working_sets: sessionSets,
      volume_kg: round1(sessionVolume),
    };
  });

  return {
    period_days: days,
    total_workouts: workouts.length,
    total_working_sets: totalSets,
    total_volume_kg: round1(totalVolumeKg),
    unique_exercises: uniqueExercises.size,
    sessions,
  };
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

interface MuscleAggregate {
  totalSets: number;
  totalVolumeKg: number;
  asPrimary: number;
  asSecondary: number;
  exercises: Set<string>;
}

export async function hevyActivityByMuscle(
  client: HevyClient,
  args: { days?: number },
): Promise<unknown> {
  const days = args.days ?? 14;
  const [workouts, templates] = await Promise.all([
    recentWorkouts(client, days),
    loadTemplates(client),
  ]);

  const muscles = new Map<string, MuscleAggregate>();
  const add = (group: string, role: 'primary' | 'secondary', title: string, totals: { sets: number; volumeKg: number }): void => {
    const entry = muscles.get(group) ?? {
      totalSets: 0,
      totalVolumeKg: 0,
      asPrimary: 0,
      asSecondary: 0,
      exercises: new Set<string>(),
    };
    entry.totalSets += totals.sets;
    entry.totalVolumeKg += totals.volumeKg;
    if (role === 'primary') {
      entry.asPrimary += totals.sets;
    } else {
      entry.asSecondary += totals.sets;
    }
    entry.exercises.add(title);
    muscles.set(group, entry);
  };

  for (const workout of workouts) {
    for (const exercise of workout.exercises ?? []) {
      const template = templates.get(exercise.exercise_template_id ?? '');
      const totals = exerciseTotals(exercise);
      const title = exercise.title ?? '';
      add(template?.primary_muscle_group ?? 'other', 'primary', title, totals);
      for (const secondary of template?.secondary_muscle_groups ?? []) {
        add(secondary, 'secondary', title, totals);
      }
    }
  }

  const muscleGroups = [...muscles.entries()]
    .sort((a, b) => b[1].totalVolumeKg - a[1].totalVolumeKg)
    .map(([group, data]) => ({
      muscle_group: group,
      total_sets: data.totalSets,
      total_volume_kg: round1(data.totalVolumeKg),
      as_primary: data.asPrimary,
      as_secondary: data.asSecondary,
      exercises: [...data.exercises].sort(),
    }));

  return {
    period_days: days,
    total_workouts: workouts.length,
    muscle_groups: muscleGroups,
  };
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
