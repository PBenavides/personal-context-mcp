/**
 * Pure payload builders and response shapers for the YNAB tools — no client, no I/O,
 * no network — so the amount/month/name rules are unit-tested directly and the same
 * builders back create and update paths (see `hevy-payloads.ts` for the pattern).
 *
 * Conventions enforced here (see docs/feat_requirements/YNAB_TOOLS_REFORMAT_SEP_13TH.md):
 * - Currency units everywhere: writes accept `250.5`, `"$250.50"`, `"250,50 EUR"` and
 *   convert to milliunits; reads divide by 1000. Milliunits never leak to the caller.
 * - Months are `current`, `next`, `YYYY-MM`, or `YYYY-MM-01`.
 * - Names are first-class ids: ambiguous or unknown names throw with candidates listed.
 */

export class YnabPayloadError extends Error {}

export type Json = Record<string, unknown>;

export function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

const AMOUNT_HINT = 'use forms like 250.50, "$250.50", "-$45", or "250,50 EUR"';

/**
 * Parses a human currency amount into YNAB milliunits (1000 = one unit).
 * Accepts numbers (currency units) or strings with an optional sign, currency
 * symbol, or 3-letter code. Separator rule: when both `.` and `,` appear, the
 * last one is the decimal separator; a lone separator followed by 1–2 digits is
 * decimal, by exactly 3 is a thousands separator.
 */
export function parseAmount(value: string | number, context = 'amount'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new YnabPayloadError(`${context} must be a finite number`);
    }
    return Math.round(value * 1000);
  }
  const original = value;
  let s = value.trim();
  const signs = s.match(/[-+]/g) ?? [];
  if (signs.length > 1) {
    throw new YnabPayloadError(`cannot parse ${context} "${original}" — ${AMOUNT_HINT}`);
  }
  const negative = signs[0] === '-';
  s = s.replace(/[-+]/, '');
  // Strip one currency symbol or 3-letter code from either edge ("$250", "250 EUR").
  s = s.replace(/^\s*(?:\p{Sc}|[a-z]{3})\s*/iu, '').replace(/\s*(?:\p{Sc}|[a-z]{3})\s*$/iu, '');
  s = s.replace(/\s+/g, '');
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) {
    throw new YnabPayloadError(`cannot parse ${context} "${original}" — ${AMOUNT_HINT}`);
  }
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimalSep = '';
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const idx = Math.max(lastDot, lastComma);
    const digitsAfter = s.length - idx - 1;
    const occurrences = s.split(sep).length - 1;
    if (occurrences === 1 && digitsAfter >= 1 && digitsAfter <= 2) {
      decimalSep = sep;
    } else if (digitsAfter === 3) {
      decimalSep = ''; // thousands separator(s), e.g. "1,250" or "1.250.000"
    } else {
      throw new YnabPayloadError(`cannot parse ${context} "${original}" — ${AMOUNT_HINT}`);
    }
  }
  let intPart = s;
  let fracPart = '';
  if (decimalSep) {
    const idx = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, idx);
    fracPart = s.slice(idx + 1);
  }
  intPart = intPart.replace(/[.,]/g, '');
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart) || (!intPart && !fracPart)) {
    throw new YnabPayloadError(`cannot parse ${context} "${original}" — ${AMOUNT_HINT}`);
  }
  const milli =
    Number(intPart || '0') * 1000 + Math.round(Number(`0.${fracPart || '0'}`) * 1000);
  return negative ? -milli : milli;
}

/** Milliunits → currency units; non-numbers become 0. */
export function toCurrency(milli: unknown): number {
  return typeof milli === 'number' ? milli / 1000 : 0;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

/** Resolves a month arg to what the API path wants: `current` or `YYYY-MM-01`. */
export function resolveMonth(month: string | undefined, now = new Date()): string {
  if (!month || month === 'current') {
    return 'current';
  }
  if (month === 'next') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10);
  }
  if (/^\d{4}-\d{2}$/.test(month)) {
    return `${month}-01`;
  }
  if (/^\d{4}-\d{2}-01$/.test(month)) {
    return month;
  }
  throw new YnabPayloadError(
    `month must be "current", "next", YYYY-MM, or YYYY-MM-01 — got "${month}"`,
  );
}

/** Like resolveMonth but always concrete ISO (`current` becomes this month's first). */
export function monthIso(month: string | undefined, now = new Date()): string {
  const resolved = resolveMonth(month, now);
  if (resolved !== 'current') {
    return resolved;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/** The first-of-month ISO date directly after `iso` (a YYYY-MM-01 date). */
export function followingMonth(iso: string): string {
  const [year, month] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

export interface Named {
  id: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Resolves a name-or-uuid reference against a fetched list. Case-insensitive exact
 * match first, then substring; zero or several matches are refused with the
 * candidates named — never guessed at.
 */
export function resolveRef<T extends Named>(items: T[], ref: string, kind: string): T {
  if (isUuid(ref)) {
    const byId = items.find(item => item.id.toLowerCase() === ref.toLowerCase());
    if (!byId) {
      throw new YnabPayloadError(`no ${kind} with id ${ref}`);
    }
    return byId;
  }
  const needle = ref.trim().toLowerCase();
  const exact = items.filter(item => item.name.toLowerCase() === needle);
  if (exact.length === 1) {
    return exact[0];
  }
  const pool = exact.length > 1 ? exact : items.filter(item => item.name.toLowerCase().includes(needle));
  if (pool.length === 1) {
    return pool[0];
  }
  if (pool.length === 0) {
    throw new YnabPayloadError(`no ${kind} matching "${ref}"`);
  }
  const candidates = pool.slice(0, 6).map(item => item.name).join(', ');
  throw new YnabPayloadError(
    `"${ref}" is ambiguous — matching ${kind}s: ${candidates}${pool.length > 6 ? ', …' : ''}. ` +
      'Use the exact name or id.',
  );
}

/** Projects raw YNAB records onto {id, name} for resolveRef, skipping deleted ones. */
export function toNamed(raw: unknown): (Named & Json)[] {
  return asArray(raw)
    .filter(item => !item.deleted && typeof item.id === 'string' && typeof item.name === 'string')
    .map(item => item as Named & Json);
}

// ---------------------------------------------------------------------------
// Assignments (the one-month-ahead write)
// ---------------------------------------------------------------------------

export interface AssignmentItem {
  category: string;
  set?: string | number;
  adjust?: string | number;
}

export interface AssignmentChange {
  id: string;
  name: string;
  beforeMilli: number;
  afterMilli: number;
}

/**
 * Turns assignment items into concrete before→after changes against a month's
 * categories. `set` is the absolute assigned amount; `adjust` a ±delta on the
 * current one — a move is one category adjusted down and another up in one call.
 */
export function planAssignments(
  categories: (Named & { budgeted: number })[],
  items: AssignmentItem[],
): AssignmentChange[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new YnabPayloadError('assignments must contain at least one item');
  }
  const seen = new Set<string>();
  return items.map((item, index) => {
    try {
      if (!item.category) {
        throw new YnabPayloadError('category is required');
      }
      const hasSet = item.set !== undefined;
      const hasAdjust = item.adjust !== undefined;
      if (hasSet === hasAdjust) {
        throw new YnabPayloadError('pass exactly one of set (absolute) or adjust (± delta)');
      }
      const category = resolveRef(categories, item.category, 'category');
      if (seen.has(category.id)) {
        throw new YnabPayloadError(`category "${category.name}" appears more than once`);
      }
      seen.add(category.id);
      const beforeMilli = category.budgeted;
      const afterMilli = hasSet
        ? parseAmount(item.set as string | number, 'set')
        : beforeMilli + parseAmount(item.adjust as string | number, 'adjust');
      return { id: category.id, name: category.name, beforeMilli, afterMilli };
    } catch (error) {
      if (error instanceof YnabPayloadError) {
        throw new YnabPayloadError(`assignments[${index}]: ${error.message}`);
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Transaction payloads
// ---------------------------------------------------------------------------

export const CLEARED_STATES = ['cleared', 'uncleared', 'reconciled'] as const;
export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export const FREQUENCIES = [
  'never',
  'daily',
  'weekly',
  'everyOtherWeek',
  'twiceAMonth',
  'every4Weeks',
  'monthly',
  'everyOtherMonth',
  'every3Months',
  'every4Months',
  'twiceAYear',
  'yearly',
  'everyOtherYear',
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface BuiltSplit {
  amount: number; // milliunits
  category_id?: string;
  payee_name?: string;
  memo?: string;
}

export interface TransactionFields {
  accountId?: string;
  date?: string;
  amountMilli?: number;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  memo?: string;
  cleared?: string;
  approved?: boolean;
  flagColor?: string;
  importId?: string;
  subtransactions?: BuiltSplit[];
}

function requireDate(date: string, context: string): string {
  if (!DATE_RE.test(date)) {
    throw new YnabPayloadError(`${context} must be YYYY-MM-DD — got "${date}"`);
  }
  return date;
}

/**
 * Assembles the SaveTransaction body from resolved fields, including only what was
 * supplied — on update, YNAB changes only the fields present. `create` enforces the
 * required trio (account, date, amount) and reconciles split sums with the total.
 */
export function buildTransactionBody(
  fields: TransactionFields,
  opts: { create: boolean },
): Json {
  const body: Json = {};
  if (opts.create) {
    if (!fields.accountId) {
      throw new YnabPayloadError('creating a transaction requires an account');
    }
    if (!fields.date) {
      throw new YnabPayloadError('creating a transaction requires a date (YYYY-MM-DD)');
    }
    if (fields.amountMilli === undefined && !fields.subtransactions?.length) {
      throw new YnabPayloadError(
        'creating a transaction requires an amount (negative = outflow, e.g. "-$45")',
      );
    }
  }
  if (fields.accountId !== undefined) body.account_id = fields.accountId;
  if (fields.date !== undefined) body.date = requireDate(fields.date, 'date');
  if (fields.subtransactions?.length) {
    if (fields.subtransactions.length < 2) {
      throw new YnabPayloadError('splits need at least two entries');
    }
    const sum = fields.subtransactions.reduce((total, split) => total + split.amount, 0);
    if (fields.amountMilli !== undefined && fields.amountMilli !== sum) {
      throw new YnabPayloadError(
        `split amounts sum to ${round3(toCurrency(sum))} but the transaction amount is ` +
          `${round3(toCurrency(fields.amountMilli))} — they must match (or omit amount to use the sum)`,
      );
    }
    body.amount = fields.amountMilli ?? sum;
    body.category_id = null; // split transactions carry categories on the subtransactions
    body.subtransactions = fields.subtransactions;
  } else if (fields.amountMilli !== undefined) {
    body.amount = fields.amountMilli;
  }
  if (fields.payeeId !== undefined) body.payee_id = fields.payeeId;
  if (fields.payeeName !== undefined) body.payee_name = fields.payeeName;
  if (fields.categoryId !== undefined && body.category_id === undefined) {
    body.category_id = fields.categoryId;
  }
  if (fields.memo !== undefined) body.memo = fields.memo;
  if (fields.cleared !== undefined) {
    if (!(CLEARED_STATES as readonly string[]).includes(fields.cleared)) {
      throw new YnabPayloadError(`cleared must be one of: ${CLEARED_STATES.join(', ')}`);
    }
    body.cleared = fields.cleared;
  }
  if (fields.approved !== undefined) body.approved = fields.approved;
  if (fields.flagColor !== undefined) {
    if (!(FLAG_COLORS as readonly string[]).includes(fields.flagColor)) {
      throw new YnabPayloadError(`flag_color must be one of: ${FLAG_COLORS.join(', ')}`);
    }
    body.flag_color = fields.flagColor;
  }
  if (fields.importId !== undefined) body.import_id = fields.importId;
  return body;
}

/**
 * The scheduled-transaction variant: date must be in the future, splits are not
 * supported by the API, and `frequency` (default `never` = one-time) is validated.
 */
export function buildScheduledBody(
  fields: TransactionFields & { frequency?: string },
  opts: { create: boolean; today?: Date },
): Json {
  if (fields.subtransactions?.length) {
    throw new YnabPayloadError(
      'the YNAB API cannot create split scheduled transactions — drop the splits or make it a regular transaction',
    );
  }
  if (fields.importId !== undefined) {
    throw new YnabPayloadError('import_id does not apply to scheduled transactions');
  }
  const body = buildTransactionBody(fields, { create: opts.create });
  delete body.import_id;
  delete body.approved;
  delete body.cleared;
  if (fields.date !== undefined) {
    const today = (opts.today ?? new Date()).toISOString().slice(0, 10);
    if (fields.date <= today) {
      throw new YnabPayloadError(
        `a scheduled transaction needs a future date — got ${fields.date} (today is ${today})`,
      );
    }
  }
  if (fields.frequency !== undefined) {
    if (!(FREQUENCIES as readonly string[]).includes(fields.frequency)) {
      throw new YnabPayloadError(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
    }
    body.frequency = fields.frequency;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Category payloads
// ---------------------------------------------------------------------------

export const TARGET_FREQUENCIES = ['monthly', 'weekly', 'yearly'] as const;

export interface CategoryFields {
  name?: string;
  groupId?: string;
  note?: string;
  /** milliunits; explicit null removes an existing target. */
  goalTargetMilli?: number | null;
  goalTargetDate?: string;
  goalFrequency?: string;
}

export function buildCategoryBody(fields: CategoryFields, opts: { create: boolean }): Json {
  if (opts.create && !fields.name) {
    throw new YnabPayloadError('creating a category requires a name');
  }
  if (opts.create && !fields.groupId) {
    throw new YnabPayloadError('creating a category requires a group (name or id)');
  }
  if (fields.goalFrequency !== undefined) {
    if (!(TARGET_FREQUENCIES as readonly string[]).includes(fields.goalFrequency)) {
      throw new YnabPayloadError(
        `target_frequency must be one of: ${TARGET_FREQUENCIES.join(', ')}`,
      );
    }
    if (fields.goalTargetDate !== undefined) {
      throw new YnabPayloadError(
        'target_frequency and target_date are mutually exclusive in the YNAB API — pick one',
      );
    }
    if (fields.goalTargetMilli === undefined || fields.goalTargetMilli === null) {
      throw new YnabPayloadError('target_frequency requires target_amount');
    }
  }
  if (fields.goalTargetDate !== undefined) {
    requireDate(fields.goalTargetDate, 'target_date');
    if (fields.goalTargetMilli === undefined || fields.goalTargetMilli === null) {
      throw new YnabPayloadError('target_date requires target_amount');
    }
  }
  const body: Json = {};
  if (fields.name !== undefined) body.name = fields.name;
  if (fields.groupId !== undefined) body.category_group_id = fields.groupId;
  if (fields.note !== undefined) body.note = fields.note;
  if (fields.goalTargetMilli !== undefined) body.goal_target = fields.goalTargetMilli;
  if (fields.goalTargetDate !== undefined) body.goal_target_date = fields.goalTargetDate;
  if (fields.goalFrequency !== undefined) body.goal_frequency = fields.goalFrequency;
  return body;
}

// ---------------------------------------------------------------------------
// Shapers (currency units, compact)
// ---------------------------------------------------------------------------

const HOUSEKEEPING_GROUPS = new Set(['Internal Master Category', 'Hidden Categories']);

function pick(source: Json, fields: string[]): Json {
  return Object.fromEntries(
    fields
      .filter(field => field in source && source[field] !== undefined && source[field] !== null)
      .map(field => [field, source[field]]),
  );
}

export function shapeTransaction(txn: Json): Json {
  const shaped: Json = {
    ...pick(txn, ['id', 'date']),
    amount: round3(toCurrency(txn.amount)),
    ...pick(txn, ['payee_name', 'category_name', 'account_name', 'memo', 'cleared', 'approved']),
  };
  if (txn.flag_color) {
    shaped.flag_color = txn.flag_color;
  }
  const splits = asArray(txn.subtransactions);
  if (splits.length > 0) {
    shaped.splits = splits.map(split => ({
      amount: round3(toCurrency(split.amount)),
      ...pick(split, ['category_name', 'payee_name', 'memo']),
    }));
  }
  return shaped;
}

export function shapeTransactions(raw: unknown, opts: { limit?: number } = {}): Json[] {
  const limit = opts.limit ?? 30;
  return asArray(raw)
    .filter(txn => !txn.deleted)
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    .slice(0, limit)
    .map(shapeTransaction);
}

export function shapeAccounts(raw: unknown, opts: { includeClosed?: boolean } = {}): Json[] {
  return asArray(raw)
    .filter(account => !account.deleted && (opts.includeClosed || !account.closed))
    .map(account => ({
      ...pick(account, ['id', 'name', 'type']),
      balance: round3(toCurrency(account.balance)),
      ...pick(account, ['on_budget', 'transfer_payee_id']),
      ...(account.closed ? { closed: true } : {}),
    }));
}

export function shapePayees(raw: unknown): Json[] {
  return asArray(raw)
    .filter(payee => !payee.deleted)
    .map(payee => pick(payee, ['id', 'name', 'transfer_account_id']));
}

export function shapeBudgets(raw: unknown): Json[] {
  return asArray(raw).map(budget => pick(budget, ['id', 'name', 'last_modified_on']));
}

export function shapeScheduled(raw: unknown): Json[] {
  return asArray(raw)
    .filter(txn => !txn.deleted)
    .sort((a, b) => String(a.date_next ?? '').localeCompare(String(b.date_next ?? '')))
    .map(txn => ({
      ...pick(txn, ['id', 'date_next', 'frequency']),
      amount: round3(toCurrency(txn.amount)),
      ...pick(txn, ['payee_name', 'category_name', 'account_name', 'memo']),
    }));
}

/** Target summary for one category, or undefined when it has no target. */
export function shapeGoal(category: Json): Json | undefined {
  if (!category.goal_type) {
    return undefined;
  }
  const goal: Json = { type: category.goal_type };
  if (typeof category.goal_target === 'number') {
    goal.target = round3(toCurrency(category.goal_target));
  }
  if (category.goal_target_date) {
    goal.by = category.goal_target_date;
  }
  if (typeof category.goal_under_funded === 'number' && category.goal_under_funded > 0) {
    goal.under_funded = round3(toCurrency(category.goal_under_funded));
  }
  if (typeof category.goal_percentage_complete === 'number') {
    goal.pct = category.goal_percentage_complete;
  }
  return goal;
}

function shapeCategory(category: Json): Json {
  const shaped: Json = {
    ...pick(category, ['id', 'name']),
    assigned: round3(toCurrency(category.budgeted)),
    activity: round3(toCurrency(category.activity)),
    available: round3(toCurrency(category.balance)),
  };
  const goal = shapeGoal(category);
  if (goal) {
    shaped.target = goal;
  }
  return shaped;
}

function visibleCategories(categories: Json[], includeHidden: boolean): Json[] {
  return categories.filter(category => !category.deleted && (includeHidden || !category.hidden));
}

/** Compact grouped list from `GET /plans/{id}/categories` (current-month numbers). */
export function shapeCategoryGroups(
  groupsRaw: unknown,
  opts: { includeHidden?: boolean } = {},
): Json[] {
  const includeHidden = opts.includeHidden ?? false;
  return asArray(groupsRaw)
    .filter(
      group =>
        !group.deleted &&
        (includeHidden || (!group.hidden && !HOUSEKEEPING_GROUPS.has(String(group.name)))),
    )
    .map(group => ({
      group: group.name ?? '',
      categories: visibleCategories(asArray(group.categories), includeHidden).map(shapeCategory),
    }))
    .filter(group => (group.categories as Json[]).length > 0);
}

/**
 * Compact grouped list for a non-current month: the month detail carries the
 * per-category numbers, the groups fetch supplies the group names.
 */
export function shapeMonthCategories(
  monthRaw: Json,
  groupsRaw: unknown,
  opts: { includeHidden?: boolean } = {},
): Json[] {
  const groupNames = new Map<string, string>();
  const skippedGroups = new Set<string>();
  const includeHidden = opts.includeHidden ?? false;
  for (const group of asArray(groupsRaw)) {
    const id = String(group.id ?? '');
    groupNames.set(id, String(group.name ?? ''));
    if (group.deleted || (!includeHidden && (group.hidden || HOUSEKEEPING_GROUPS.has(String(group.name))))) {
      skippedGroups.add(id);
    }
  }
  const byGroup = new Map<string, Json[]>();
  for (const category of visibleCategories(asArray(monthRaw.categories), includeHidden)) {
    const groupId = String(category.category_group_id ?? '');
    if (skippedGroups.has(groupId)) {
      continue;
    }
    const list = byGroup.get(groupId) ?? [];
    list.push(shapeCategory(category));
    byGroup.set(groupId, list);
  }
  return [...byGroup.entries()].map(([groupId, categories]) => ({
    group: groupNames.get(groupId) ?? groupId,
    categories,
  }));
}

/** Full single-category view: month-scoped numbers plus the complete target picture. */
export function shapeCategoryDetail(category: Json): Json {
  const shaped = shapeCategory(category);
  const extras = pick(category, ['category_group_name', 'note']);
  const goal = shapeGoal(category);
  if (goal) {
    for (const field of ['goal_overall_funded', 'goal_overall_left', 'goal_months_to_budget']) {
      if (typeof category[field] === 'number') {
        goal[field.replace('goal_', '')] =
          field === 'goal_months_to_budget'
            ? category[field]
            : round3(toCurrency(category[field]));
      }
    }
    shaped.target = goal;
  }
  return { ...shaped, ...extras };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface OverviewInput {
  /** Raw month detail for the requested month. */
  month: Json;
  /** Raw month detail for the month after it, when available. */
  following?: Json;
  /**
   * The following month exists in the calendar but not yet in YNAB (404): months
   * materialize only once something is assigned or scheduled into them.
   */
  followingIso?: string;
  /** Raw scheduled transactions (for the upcoming-bills window). */
  scheduled?: unknown;
  today?: Date;
}

const UPCOMING_WINDOW_DAYS = 30;

/**
 * The one-call budget-health snapshot: Ready to Assign (with the month-ahead
 * semantics — once money is assigned into the future, the future-most month holds
 * the authoritative number), month totals, next month's funding progress,
 * overspent categories, upcoming bills, and derived alerts for a triage agent.
 */
export function shapeOverview(input: OverviewInput): Json {
  const month = input.month;
  const monthLabel = String(month.month ?? '').slice(0, 7);
  const categories = visibleCategories(asArray(month.categories), false);
  const alerts: string[] = [];

  const overspent = categories
    .filter(category => typeof category.balance === 'number' && (category.balance as number) < 0)
    .map(category => ({
      category: String(category.name ?? ''),
      overspent_by: round3(-toCurrency(category.balance)),
    }))
    .sort((a, b) => b.overspent_by - a.overspent_by);
  for (const entry of overspent.slice(0, 3)) {
    alerts.push(
      `"${entry.category}" is overspent by ${entry.overspent_by} — cover it before assigning ahead`,
    );
  }
  if (overspent.length > 3) {
    alerts.push(`…and ${overspent.length - 3} more overspent categories`);
  }

  const following = input.following;
  let monthAhead: Json | undefined;
  if (following) {
    const followingCategories = visibleCategories(asArray(following.categories), false);
    const withTargets = followingCategories.filter(category => category.goal_type);
    const underfunded = withTargets
      .filter(
        category =>
          typeof category.goal_under_funded === 'number' &&
          (category.goal_under_funded as number) > 0,
      )
      .map(category => ({
        category: String(category.name ?? ''),
        needed: round3(toCurrency(category.goal_under_funded)),
      }))
      .sort((a, b) => b.needed - a.needed);
    const underfundedTotal = round3(
      underfunded.reduce((total, entry) => total + entry.needed, 0),
    );
    monthAhead = {
      month: String(following.month ?? '').slice(0, 7),
      assigned: round3(toCurrency(following.budgeted)),
      fully_funded: withTargets.length > 0 && underfunded.length === 0,
      underfunded_total: underfundedTotal,
      underfunded: underfunded.slice(0, 15),
    };
    const followingRta = toCurrency(following.to_be_budgeted);
    if (followingRta < 0) {
      alerts.push(
        `next month is over-assigned by ${round3(-followingRta)} — unassign until its Ready to Assign is back to 0`,
      );
    } else if (followingRta > 0) {
      alerts.push(
        `${round3(followingRta)} is ready to assign — fund next month's categories (ynab_assign with month: "next")`,
      );
    }
    if (underfundedTotal > 0) {
      alerts.push(`next month needs ${underfundedTotal} more to be fully funded`);
    }
  } else {
    // No following month: this month's Ready to Assign is the authoritative one,
    // so the over-assigned / idle-money alerts have to come from it instead.
    const rta = toCurrency(month.to_be_budgeted);
    if (rta < 0) {
      alerts.push(
        `this month is over-assigned by ${round3(-rta)} — reduce an assignment until Ready to Assign is back to 0`,
      );
    } else if (rta > 0) {
      alerts.push(`${round3(rta)} is ready to assign`);
    }
    if (input.followingIso) {
      alerts.push(
        `next month (${input.followingIso.slice(0, 7)}) is not open in YNAB yet — assigning to it ` +
          'creates it (ynab_assign with month: "next" and set amounts)',
      );
    }
  }

  const today = input.today ?? new Date();
  const horizon = new Date(today.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const upcoming = shapeScheduled(input.scheduled)
    .filter(txn => typeof txn.date_next === 'string' && (txn.date_next as string) <= horizon)
    .slice(0, 15)
    .map(txn => ({
      date: txn.date_next,
      ...pick(txn, ['payee_name', 'category_name', 'amount', 'frequency']),
    }));

  return {
    month: monthLabel,
    ready_to_assign: {
      this_month: round3(toCurrency(month.to_be_budgeted)),
      ...(following
        ? {
            next_month: round3(toCurrency(following.to_be_budgeted)),
            note:
              'once money is assigned into the future, the future-most month holds the authoritative Ready to Assign',
          }
        : {}),
    },
    ...(!following && input.followingIso
      ? { month_ahead: { month: input.followingIso.slice(0, 7), open_in_ynab: false } }
      : {}),
    age_of_money: typeof month.age_of_money === 'number' ? month.age_of_money : null,
    income: round3(toCurrency(month.income)),
    assigned: round3(toCurrency(month.budgeted)),
    activity: round3(toCurrency(month.activity)),
    ...(monthAhead ? { month_ahead: monthAhead } : {}),
    overspent: overspent.slice(0, 15),
    ...(upcoming.length > 0 ? { upcoming_scheduled: upcoming } : {}),
    alerts,
  };
}
