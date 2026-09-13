import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConnections } from '../../connections/registry.js';
import type { McpDefinition } from '../../registry/types.js';
import { getAppVersion } from '../../version.js';
import { MUSCLE_GROUPS } from './hevy-payloads.js';
import {
  CLEARED_STATES,
  FLAG_COLORS,
  FREQUENCIES,
  TARGET_FREQUENCIES,
} from './ynab-payloads.js';
import {
  ACTIVITY_TYPES,
  gcalCreateEvent,
  gcalDeleteEvent,
  gcalFreeBusy,
  gcalGetEvent,
  gcalListCalendars,
  gcalListEvents,
  gcalUpdateEvent,
  hevyBodyMeasurements,
  hevyCalculateBurntCalories,
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

const NAME = 'personal-tools';
// Sourced from package.json — MCPs are versioned service-wide (see getAppVersion).
const VERSION = getAppVersion();

const INSTRUCTIONS =
  "Action layer over Pablo's personal accounts. Three integrations: YNAB budgeting " +
  '(ynab_* — a budget-health overview, transaction queries, categories with targets, ' +
  'reports, lookups, and writes that assign money, manage transactions, and reshape ' +
  'categories), Hevy workout tracking ' +
  '(hevy_* — recent training by muscle group and day, logged workouts, routines, body ' +
  'measurements, a calorie estimate, and exercise-catalog search), and Google Calendar (gcal_* — list ' +
  'calendars/events, get/create/update/delete an event, free/busy lookup). The budget runs ' +
  "the one-month-ahead method: income received this month is assigned into next month's " +
  'categories (ynab_assign with month: "next") until Ready to Assign is 0. Start any ' +
  'budget-health question at ynab_overview. All ynab_* amounts are currency units, never ' +
  'milliunits; writes accept strings like "$250.50" or "250,50 EUR", and outflows are ' +
  'negative. Categories, accounts, and payees go by name or id — ambiguous names are ' +
  'refused with the candidates listed. Tools default to the last-used budget (ynab_lookup ' +
  'entity: "budgets" lists the rest). The YNAB writes (ynab_assign, ' +
  'ynab_write_transaction, ynab_write_category) all take dry_run to preview the exact ' +
  'request — prefer it before committing; the API cannot delete categories, accounts, or ' +
  'payees, and cannot create whole budgets. gcal_* tools default to the "primary" ' +
  'calendar. Hevy is read-only ' +
  'except for hevy_write_routine, which creates a reusable plan when no routine_id is passed ' +
  'and updates one when it is, preserving any field you omit; exercises there are addressed by ' +
  'exercise_template_id, so call hevy_search_exercise_catalog first (or pass a name and let it ' +
  'resolve), and dry_run previews the request body. Hevy cannot log or edit a workout, create a ' +
  'custom exercise, or delete anything — those happen in the app. ' +
  'hevy_calculate_burnt_calories returns a rough estimate (±20-30%): always report its ' +
  'accuracy_note and warnings with the number rather than presenting it as measured.';

interface TextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function textResult(text: string, isError = false): TextResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

function jsonResult(data: unknown): TextResult {
  return textResult(JSON.stringify(data, null, 2));
}

function errorResult(prefix: string, error: unknown): TextResult {
  return textResult(
    `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );
}

const budgetId = z
  .string()
  .optional()
  .describe('Budget; defaults to the last-used budget');

/**
 * Builds a fresh personal-tools MCP server. Handlers live in `./tools.js` (unit-tested with
 * fake clients); the YNAB/Hevy connections are shared module-scoped singletons (see
 * `getConnections`), so building per request stays cheap under the stateless transport.
 * `get()` on an unconfigured connection throws — surfaced to the caller as an isError result.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  // Shared across the YNAB and Hevy write tools so their contracts cannot drift.
  const dryRun = z
    .boolean()
    .optional()
    .describe('Return the request body that would be sent, without sending it');
  // Shared across the YNAB tools: month keywords and human-format amounts.
  const ynabMonth = z
    .string()
    .optional()
    .describe('"current" (default), "next", YYYY-MM, or YYYY-MM-01');
  const ynabAmount = z
    .union([z.number(), z.string()])
    .describe('Currency units: 250.5, "$250.50", or "250,50 EUR"');

  server.registerTool(
    'ynab_overview',
    {
      title: 'YNAB budget health overview',
      description:
        'The first call for any budget-health question. One shot: Ready to Assign for this ' +
        'and next month (once money is assigned ahead, the future-most month holds the ' +
        "authoritative number), age of money, income/assigned/activity, next month's " +
        'funding progress against targets (underfunded categories and amounts), overspent ' +
        'categories, scheduled bills due in the next 30 days, and derived alerts for ' +
        'triage. Currency units.',
      inputSchema: { budget_id: budgetId, month: ynabMonth },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabOverview(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            month: args.month,
          }),
        );
      } catch (error) {
        return errorResult('YNAB overview failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_transactions',
    {
      title: 'Query YNAB transactions',
      description:
        'Query transactions, newest first. Scope precedence: transaction_id (single) > ' +
        'account > category > payee > whole budget (then since_date is required to bound ' +
        'the result). Scopes accept a name or id — an ambiguous name is refused with the ' +
        'candidates listed. Compact view in currency units (negative = outflow); ' +
        'verbose=true returns raw YNAB objects.',
      inputSchema: {
        budget_id: budgetId,
        transaction_id: z.string().optional().describe('Fetch exactly one transaction'),
        account: z.string().optional().describe('Transactions of one account (name or id)'),
        category: z.string().optional().describe('Transactions of one category (name or id)'),
        payee: z.string().optional().describe('Transactions of one payee (name or id)'),
        since_date: z
          .string()
          .optional()
          .describe('YYYY-MM-DD; only transactions on/after this date'),
        until_date: z
          .string()
          .optional()
          .describe('YYYY-MM-DD; only transactions on/before this date'),
        type: z
          .enum(['uncategorized', 'unapproved'])
          .optional()
          .describe('Restrict to uncategorized or unapproved transactions'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max transactions returned (default 30, newest first)'),
        verbose: z.boolean().optional().describe('Raw YNAB objects instead of the compact view'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabTransactions(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            transactionId: args.transaction_id,
            account: args.account,
            category: args.category,
            payee: args.payee,
            sinceDate: args.since_date,
            untilDate: args.until_date,
            type: args.type,
            limit: args.limit,
            verbose: args.verbose,
          }),
        );
      } catch (error) {
        return errorResult('YNAB transactions failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_categories',
    {
      title: 'YNAB categories and targets',
      description:
        'Grouped category list for a month — assigned, activity, available, and target ' +
        'progress per category, hidden ones skipped unless include_hidden — or pass ' +
        "category (name or id) for one category's full target detail. Currency units.",
      inputSchema: {
        budget_id: budgetId,
        category: z.string().optional().describe('One category (name or id) in full detail'),
        month: ynabMonth,
        include_hidden: z
          .boolean()
          .optional()
          .describe('Include hidden categories and housekeeping groups'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabCategories(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            category: args.category,
            month: args.month,
            includeHidden: args.include_hidden,
          }),
        );
      } catch (error) {
        return errorResult('YNAB categories failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_report',
    {
      title: 'YNAB financial report',
      description:
        'Aggregated reports in currency units. kind=net_worth: assets, liabilities, ' +
        'per-account breakdown. kind=monthly_summary: income, spending, savings rate, top ' +
        'categories for a month. kind=full: net worth + current month + cash-flow history ' +
        'over months_back (default 3) months.',
      inputSchema: {
        budget_id: budgetId,
        kind: z.enum(['net_worth', 'monthly_summary', 'full']),
        month: ynabMonth,
        months_back: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .describe('For full: history depth in months (default 3)'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabReport(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            kind: args.kind,
            month: args.month,
            monthsBack: args.months_back,
          }),
        );
      } catch (error) {
        return errorResult('YNAB report failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_lookup',
    {
      title: 'YNAB entity lookup',
      description:
        'Compact listings of the ids and names the other ynab_* tools consume. ' +
        'entity=budgets (all budgets — everything else defaults to the last-used one), ' +
        'accounts (balances, types, transfer_payee_id for transfers), payees, or scheduled ' +
        '(recurring transactions and next dates). id narrows to one record (accounts and ' +
        'payees also accept a name); include_closed adds closed accounts.',
      inputSchema: {
        budget_id: budgetId,
        entity: z.enum(['budgets', 'accounts', 'payees', 'scheduled']),
        id: z.string().optional().describe('One record by id (accounts/payees: name works too)'),
        include_closed: z.boolean().optional().describe('Include closed accounts'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabLookup(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            entity: args.entity,
            id: args.id,
            includeClosed: args.include_closed,
          }),
        );
      } catch (error) {
        return errorResult('YNAB lookup failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_assign',
    {
      title: 'Assign money to YNAB categories',
      description:
        'The budgeting write: set or adjust the assigned amount of one or more categories ' +
        'for a month, in one call. Each assignment names a category (name or id) and ' +
        'exactly one of set (the absolute assigned amount) or adjust (a ± delta on it); ' +
        'moving money is one category adjusted down and another up together. month: "next" ' +
        "is the one-month-ahead move — assign this month's income into next month until " +
        'Ready to Assign is 0. Amounts accept 250.5 or "$250.50". dry_run previews ' +
        'before/after per category, the exact requests, and the projected Ready to Assign — ' +
        'use it to propose changes before committing.',
      inputSchema: {
        budget_id: budgetId,
        month: ynabMonth,
        assignments: z
          .array(
            z.object({
              category: z.string().describe('Category name or id'),
              set: ynabAmount.optional().describe('Absolute assigned amount for the month'),
              adjust: ynabAmount.optional().describe('± change to the current assigned amount'),
            }),
          )
          .min(1)
          .describe('One entry per category; exactly one of set/adjust each'),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async args => {
      try {
        return jsonResult(
          await ynabAssign(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            month: args.month,
            assignments: args.assignments,
            dryRun: args.dry_run,
          }),
        );
      } catch (error) {
        return errorResult('YNAB assign failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_write_transaction',
    {
      title: 'Create, update, or delete a YNAB transaction',
      description:
        'The id decides the verb: without transaction_id this creates (account, date, ' +
        'amount required); with it, it updates just the fields you pass; delete: true ' +
        'deletes. Amounts accept 250.5 or "$250.50"; negative = outflow/spending. account ' +
        'and category take a name or id; payee takes a payee name (YNAB matches or creates ' +
        'it) or id. A frequency or a future date makes it a scheduled (recurring) ' +
        'transaction automatically — pass scheduled: true when updating or deleting one, ' +
        'since ids do not say. splits creates a split transaction; the API cannot edit ' +
        'splits afterwards (delete and recreate). Writes real records — prefer dry_run ' +
        'first.',
      inputSchema: {
        budget_id: budgetId,
        transaction_id: z
          .string()
          .optional()
          .describe('Update this transaction instead of creating one'),
        delete: z.boolean().optional().describe('Delete the transaction (needs transaction_id)'),
        scheduled: z
          .boolean()
          .optional()
          .describe('Target a scheduled transaction (auto-detected on create)'),
        account: z.string().optional().describe('Account name or id (required to create)'),
        date: z.string().optional().describe('YYYY-MM-DD (required to create)'),
        amount: ynabAmount.optional().describe('Currency units; negative = outflow, e.g. "-$45"'),
        payee: z.string().optional().describe('Payee name (matched or created) or payee id'),
        category: z.string().optional().describe('Category name or id'),
        memo: z.string().optional(),
        cleared: z.enum(CLEARED_STATES).optional(),
        approved: z.boolean().optional(),
        flag_color: z.enum(FLAG_COLORS).optional(),
        import_id: z
          .string()
          .optional()
          .describe('Dedup key (create only): a repeat with the same import_id is rejected'),
        frequency: z
          .enum(FREQUENCIES)
          .optional()
          .describe('Makes it recurring ("never" = one-time scheduled)'),
        splits: z
          .array(
            z.object({
              amount: ynabAmount.describe('Split amount; splits must sum to the total'),
              category: z.string().optional().describe('Category name or id'),
              payee: z.string().optional(),
              memo: z.string().optional(),
            }),
          )
          .optional()
          .describe('Create as a split transaction (2+ entries)'),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabWriteTransaction(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            transactionId: args.transaction_id,
            delete: args.delete,
            scheduled: args.scheduled,
            account: args.account,
            date: args.date,
            amount: args.amount,
            payee: args.payee,
            category: args.category,
            memo: args.memo,
            cleared: args.cleared,
            approved: args.approved,
            flagColor: args.flag_color,
            importId: args.import_id,
            frequency: args.frequency,
            splits: args.splits,
            dryRun: args.dry_run,
          }),
        );
      } catch (error) {
        return errorResult('YNAB write transaction failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_write_category',
    {
      title: 'Create or update YNAB categories and groups',
      description:
        'The "priorities changed" write. Without category: creates one (name and group ' +
        'required). With category (name or id): renames via name, moves via group, edits ' +
        'note, and manages the target — target_amount sets one (optionally with ' +
        'target_date OR target_frequency), remove_target removes it. new_group creates a ' +
        'category group; group + rename_group_to renames one. The API cannot delete or ' +
        'hide categories — that stays in the app. Prefer dry_run first.',
      inputSchema: {
        budget_id: budgetId,
        category: z
          .string()
          .optional()
          .describe('Existing category to update (name or id); omit to create'),
        name: z.string().optional().describe('Category name: the new category, or a rename'),
        group: z
          .string()
          .optional()
          .describe('Category group (name or id): home on create, move on update'),
        note: z.string().optional(),
        target_amount: ynabAmount.optional().describe('Target ("goal") amount, e.g. "$400"'),
        target_date: z
          .string()
          .optional()
          .describe('YYYY-MM-DD target date (not with target_frequency)'),
        target_frequency: z
          .enum(TARGET_FREQUENCIES)
          .optional()
          .describe('monthly, weekly, or yearly refill cadence (not with target_date)'),
        remove_target: z.boolean().optional().describe('Remove the existing target'),
        new_group: z
          .string()
          .optional()
          .describe('Create a category group with this name (combines with nothing else)'),
        rename_group_to: z.string().optional().describe('Rename the group passed in group'),
        dry_run: dryRun,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async args => {
      try {
        return jsonResult(
          await ynabWriteCategory(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            category: args.category,
            name: args.name,
            group: args.group,
            note: args.note,
            targetAmount: args.target_amount,
            targetDate: args.target_date,
            targetFrequency: args.target_frequency,
            removeTarget: args.remove_target,
            newGroup: args.new_group,
            renameGroupTo: args.rename_group_to,
            dryRun: args.dry_run,
          }),
        );
      } catch (error) {
        return errorResult('YNAB write category failed', error);
      }
    },
  );

  server.registerTool(
    'hevy_recent_activity',
    {
      title: 'Recent Hevy training, by muscle group and day',
      description:
        'What Pablo has trained recently, grouped by muscle group and then by calendar day — so ' +
        '"did I already hit triceps this week, and how hard?" is one call. Per group per day: ' +
        'sets, volume (kg), primary/secondary involvement, and the exercises used. Also returns ' +
        'every session in the window with its workout_id (the id hevy_get_workout needs), ' +
        'duration in minutes, sets and volume. Warmup sets are ' +
        'excluded throughout. Narrow the breakdown with type (all / muscles / cardio) or with ' +
        'specific for a single group. depth: 1 replaces each day\'s exercise-id map with a ' +
        'written summary of the sets ("4 sets of 10 repetitions each with min of 15kg, max of ' +
        '20kg") — it needs a narrowed type and at most 4 days.',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Lookback window in days (default 4; at most 4 when depth is 1)'),
        type: z
          .enum(ACTIVITY_TYPES)
          .optional()
          .describe(
            'Which meta-category to break down: all (default), muscles (everything except ' +
              'cardio), or cardio',
          ),
        depth: z
          .number()
          .int()
          .min(0)
          .max(1)
          .optional()
          .describe(
            '0 (default) lists each exercise as name → exercise_template_id; 1 describes its ' +
              'sets in words. 1 requires type "muscles"/"cardio" or a specific group, and days <= 4',
          ),
        specific: z
          .enum(MUSCLE_GROUPS)
          .optional()
          .describe('Restrict the breakdown to one muscle group (or "cardio")'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(await hevyRecentActivity(getConnections().hevy.get(), args));
      } catch (error) {
        return errorResult('Hevy recent activity failed', error);
      }
    },
  );

  // Shared across the Hevy write tools so the exercise contract cannot drift between them.
  const exercisesSchema = z
    .array(z.record(z.string(), z.unknown()))
    .describe(
      'Exercises, in order. Identify each by exercise_template_id (from ' +
        'hevy_search_exercise_catalog) ' +
        'or by exercise: "<name>", which is resolved automatically and errors with the ' +
        'candidates listed if the name is ambiguous. Sets are either an explicit list — ' +
        'sets: [{reps: 8, weight_kg: 60}, ...] — or a count that repeats the set fields on the ' +
        'exercise itself: {exercise: "Squat (Barbell)", sets: 3, reps: 8, weight_kg: 60}. Set ' +
        'fields: type ("normal" default, or warmup/failure/dropset), weight_kg, reps, ' +
        'distance_meters, duration_seconds, custom_metric; workout sets also take rpe (6, 7, ' +
        '7.5, 8, 8.5, 9, 9.5, 10) and routine sets also take rep_range ({start, end} or "8-12"). ' +
        'Exercise fields: notes, superset_id (equal integers group a superset); routine ' +
        'exercises also take rest_seconds.',
    );

  const exerciseMode = z
    .enum(['replace', 'append'])
    .optional()
    .describe('replace (default) swaps in the exercises you pass; append adds them at the end');

  server.registerTool(
    'hevy_search_exercise_catalog',
    {
      title: 'Search the Hevy exercise catalog',
      description:
        'Look up exercises in the Hevy catalog (its stock templates plus Pablo\'s custom ones) ' +
        'and get the exercise_template_id every write needs. Search by name — query: "bench ' +
        'press", "romanian deadlift" — ranked exact, then prefix, then substring; or browse a ' +
        'muscle_group ("lats", "triceps", "cardio", …) to see what trains it, primary-role ' +
        'first; or both, to search names within a group. Each match returns the id, title, ' +
        'equipment, measurement type and muscle groups. This is a catalog of what can be ' +
        'logged, not a record of what Pablo did — for that use hevy_recent_activity.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Exercise name, e.g. "bench press"; omit to browse a whole muscle_group'),
        muscle_group: z
          .enum(MUSCLE_GROUPS)
          .optional()
          .describe('Only exercises training this group, in either the primary or secondary role'),
        limit: z.number().int().min(1).max(100).optional().describe('Max matches (default 20)'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await hevySearchExerciseCatalog(getConnections().hevy.get(), {
            query: args.query,
            muscleGroup: args.muscle_group,
            limit: args.limit,
          }),
        );
      } catch (error) {
        return errorResult('Hevy exercise catalog search failed', error);
      }
    },
  );

  server.registerTool(
    'hevy_get_workout',
    {
      title: 'Get a Hevy workout',
      description:
        'Fetch one logged workout by id, with all exercises and sets exactly as recorded. ' +
        "Workout ids come from hevy_recent_activity's session list. Use this when the " +
        'muscle-group summary is not enough and the raw session is needed.',
      inputSchema: {
        workout_id: z.string().describe('Workout id, as returned by hevy_recent_activity'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await hevyGetWorkout(getConnections().hevy.get(), { workoutId: args.workout_id }),
        );
      } catch (error) {
        return errorResult('Hevy get workout failed', error);
      }
    },
  );

  server.registerTool(
    'hevy_routines',
    {
      title: 'List Hevy routines',
      description:
        'List the routines (reusable workout plans), or pass routine_id for one. Each exercise ' +
        'is summarized in one line — "3. Lat Pulldown: 4 sets of 8-12 repetitions each at 55kg. ' +
        '90s rest." — rather than dumped set by set, keyed by its position in the plan. Routines ' +
        'are plans; logged sessions are workouts (hevy_recent_activity).',
      inputSchema: {
        routine_id: z.string().optional().describe('One routine instead of the full list'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await hevyRoutines(getConnections().hevy.get(), { routineId: args.routine_id }),
        );
      } catch (error) {
        return errorResult('Hevy routines failed', error);
      }
    },
  );

  server.registerTool(
    'hevy_body_measurements',
    {
      title: 'Hevy body measurements',
      description:
        'Logged body measurements, newest first: weight_kg, lean_mass_kg, fat_percent and the ' +
        'girth fields (neck, shoulder, chest, bicep, forearm, abdomen, waist, hips, thigh, calf ' +
        '— left/right where it applies). Entries are keyed by date and are sparse: only the ' +
        'fields actually recorded on a date are returned, so a missing field means it was not ' +
        'measured. Pass date for one entry, days to confine the window, or neither for the ' +
        'latest few. Read-only — measurements are logged in the app.',
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('One entry by date, YYYY-MM-DD; omit for the most recent entries'),
        days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Only entries from the last N days; omit for no time limit'),
        limit: z.number().int().min(1).max(100).optional().describe('Max entries (default 10)'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await hevyBodyMeasurements(getConnections().hevy.get(), {
            date: args.date,
            days: args.days,
            limit: args.limit,
          }),
        );
      } catch (error) {
        return errorResult('Hevy body measurements failed', error);
      }
    },
  );

  server.registerTool(
    'hevy_calculate_burnt_calories',
    {
      title: 'Estimate calories burnt in a Hevy workout',
      description:
        'Estimate the energy cost of one logged workout. Scales each exercise by how much muscle ' +
        'it recruits (squats cost more than wrist curls), charges time under tension and rest ' +
        'separately, derives cardio intensity from actual pace, and personalizes the resting rate ' +
        "from Hevy's latest body measurement (Katch-McArdle on lean mass when body fat is " +
        'logged). Workout ids come from hevy_recent_activity. IMPORTANT: the result is a rough ' +
        'estimate, ±20-30% at best and weakest for resistance training — always report the ' +
        'accuracy_note and any warnings alongside the number, and treat it as a way to compare ' +
        'sessions rather than a calorie budget.',
      inputSchema: {
        workout_id: z.string().describe('Workout id, as returned by hevy_recent_activity'),
        weight_kg: z
          .number()
          .positive()
          .optional()
          .describe('Override body weight instead of using the latest Hevy measurement'),
        fat_percent: z
          .number()
          .min(1)
          .max(75)
          .optional()
          .describe('Body fat %; enables the lean-mass resting rate when Hevy has none logged'),
        lean_mass_kg: z
          .number()
          .positive()
          .optional()
          .describe('Lean body mass; the most accurate input, overrides weight/fat'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await hevyCalculateBurntCalories(getConnections().hevy.get(), {
            workoutId: args.workout_id,
            weightKg: args.weight_kg,
            fatPercent: args.fat_percent,
            leanMassKg: args.lean_mass_kg,
          }),
        );
      } catch (error) {
        return errorResult('Hevy calorie estimate failed', error);
      }
    },
  );

  server.registerTool(
    'hevy_write_routine',
    {
      title: 'Create or update a Hevy routine',
      description:
        'Create or edit a reusable workout plan. Omit routine_id to create; pass one to update. ' +
        'Creating requires title and exercises, and may file the routine under folder_name ' +
        '(with create_folder to make it if missing). Updating preserves every field you omit — ' +
        'including exercises — because this reads the routine and merges your changes over it. ' +
        'A routine cannot be moved between folders: Hevy only accepts a folder at creation.',
      inputSchema: {
        routine_id: z.string().optional().describe('Update this routine; omit to create a new one'),
        title: z.string().optional().describe('Routine title; required when creating'),
        exercises: exercisesSchema.optional(),
        notes: z.string().optional().describe('Notes shown on the routine'),
        folder_name: z
          .string()
          .optional()
          .describe('Create-only: file the routine under this folder, by name'),
        create_folder: z
          .boolean()
          .optional()
          .describe('Create folder_name if no folder matches it'),
        exercise_mode: exerciseMode,
        dry_run: dryRun,
      },
    },
    async args => {
      try {
        return jsonResult(
          await hevyWriteRoutine(getConnections().hevy.get(), {
            routineId: args.routine_id,
            title: args.title,
            exercises: args.exercises,
            notes: args.notes,
            folderName: args.folder_name,
            createFolder: args.create_folder,
            exerciseMode: args.exercise_mode,
            dryRun: args.dry_run,
          }),
        );
      } catch (error) {
        return errorResult('Hevy write routine failed', error);
      }
    },
  );

  const calendarId = z
    .string()
    .optional()
    .describe('Calendar to use; defaults to "primary"');

  server.registerTool(
    'gcal_list_calendars',
    {
      title: 'List Google Calendars',
      description: 'List all Google Calendars the user has access to.',
      inputSchema: {
        min_access_role: z
          .enum(['freeBusyReader', 'reader', 'writer', 'owner'])
          .optional()
          .describe('Minimum permission level to filter by; omit for all calendars'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await gcalListCalendars(getConnections().googleCalendar.get(), {
            minAccessRole: args.min_access_role,
          }),
        );
      } catch (error) {
        return errorResult('Google Calendar list calendars failed', error);
      }
    },
  );

  server.registerTool(
    'gcal_list_events',
    {
      title: 'List Google Calendar events',
      description:
        'List events from a calendar, optionally bounded by time range and/or free-text ' +
        'search. Recurring events are expanded into instances, ordered by start time.',
      inputSchema: {
        calendar_id: calendarId,
        time_min: z.string().optional().describe('RFC3339 lower bound on start time'),
        time_max: z.string().optional().describe('RFC3339 upper bound on end time'),
        query: z.string().optional().describe('Free-text search over title/description/location'),
        max_results: z.number().int().min(1).max(2500).optional().describe('Default 50'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await gcalListEvents(getConnections().googleCalendar.get(), {
            calendarId: args.calendar_id,
            timeMin: args.time_min,
            timeMax: args.time_max,
            query: args.query,
            maxResults: args.max_results,
          }),
        );
      } catch (error) {
        return errorResult('Google Calendar list events failed', error);
      }
    },
  );

  server.registerTool(
    'gcal_get_event',
    {
      title: 'Get a Google Calendar event',
      description: 'Get a single calendar event by its id (from gcal_list_events).',
      inputSchema: {
        event_id: z.string().describe('Event id'),
        calendar_id: calendarId,
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await gcalGetEvent(getConnections().googleCalendar.get(), {
            eventId: args.event_id,
            calendarId: args.calendar_id,
          }),
        );
      } catch (error) {
        return errorResult('Google Calendar get event failed', error);
      }
    },
  );

  server.registerTool(
    'gcal_create_event',
    {
      title: 'Create a Google Calendar event',
      description:
        'Create a new calendar event. For timed events, start/end are RFC3339 datetimes ' +
        '(e.g. "2026-07-22T10:00:00") and timezone applies; for all_day events they are plain ' +
        'dates (YYYY-MM-DD).',
      inputSchema: {
        summary: z.string().describe('Event title'),
        start: z.string().describe('Start datetime (RFC3339) or date (YYYY-MM-DD if all_day)'),
        end: z.string().describe('End datetime (RFC3339) or date (YYYY-MM-DD if all_day)'),
        calendar_id: calendarId,
        description: z.string().optional().describe('Event notes'),
        location: z.string().optional(),
        attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
        all_day: z.boolean().optional().describe('Treat start/end as dates, not datetimes'),
        timezone: z.string().optional().describe('IANA timezone; defaults to UTC'),
        send_notifications: z.boolean().optional().describe('Email invites to attendees'),
      },
    },
    async args => {
      try {
        return jsonResult(
          await gcalCreateEvent(getConnections().googleCalendar.get(), {
            summary: args.summary,
            start: args.start,
            end: args.end,
            calendarId: args.calendar_id,
            description: args.description,
            location: args.location,
            attendees: args.attendees,
            allDay: args.all_day,
            timezone: args.timezone,
            sendNotifications: args.send_notifications,
          }),
        );
      } catch (error) {
        return errorResult('Google Calendar create event failed', error);
      }
    },
  );

  server.registerTool(
    'gcal_update_event',
    {
      title: 'Update a Google Calendar event',
      description: 'Partially update an existing event — only the fields you pass are changed.',
      inputSchema: {
        event_id: z.string().describe('Event id (from gcal_list_events or gcal_get_event)'),
        calendar_id: calendarId,
        summary: z.string().optional(),
        start: z.string().optional().describe('New start datetime (RFC3339) or date'),
        end: z.string().optional().describe('New end datetime (RFC3339) or date'),
        description: z.string().optional(),
        location: z.string().optional(),
        attendees: z
          .array(z.string())
          .optional()
          .describe('Replaces the full attendee list; pass [] to remove all'),
        timezone: z.string().optional().describe('IANA timezone for start/end'),
        send_notifications: z.boolean().optional().describe('Notify attendees of the change'),
      },
    },
    async args => {
      try {
        return jsonResult(
          await gcalUpdateEvent(getConnections().googleCalendar.get(), {
            eventId: args.event_id,
            calendarId: args.calendar_id,
            summary: args.summary,
            start: args.start,
            end: args.end,
            description: args.description,
            location: args.location,
            attendees: args.attendees,
            timezone: args.timezone,
            sendNotifications: args.send_notifications,
          }),
        );
      } catch (error) {
        return errorResult('Google Calendar update event failed', error);
      }
    },
  );

  server.registerTool(
    'gcal_delete_event',
    {
      title: 'Delete a Google Calendar event',
      description: 'Delete an event.',
      inputSchema: {
        event_id: z.string().describe('Event id'),
        calendar_id: calendarId,
        send_notifications: z.boolean().optional().describe('Notify attendees of cancellation'),
      },
    },
    async args => {
      try {
        return jsonResult(
          await gcalDeleteEvent(getConnections().googleCalendar.get(), {
            eventId: args.event_id,
            calendarId: args.calendar_id,
            sendNotifications: args.send_notifications,
          }),
        );
      } catch (error) {
        return errorResult('Google Calendar delete event failed', error);
      }
    },
  );

  server.registerTool(
    'gcal_free_busy',
    {
      title: 'Google Calendar free/busy lookup',
      description:
        'Query busy time blocks across one or more calendars in a time window — use to find ' +
        'free slots (anything not returned as busy).',
      inputSchema: {
        time_min: z.string().describe('RFC3339 start of the window'),
        time_max: z.string().describe('RFC3339 end of the window'),
        calendar_ids: z.array(z.string()).optional().describe('Defaults to ["primary"]'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await gcalFreeBusy(getConnections().googleCalendar.get(), {
            timeMin: args.time_min,
            timeMax: args.time_max,
            calendarIds: args.calendar_ids,
          }),
        );
      } catch (error) {
        return errorResult('Google Calendar free/busy failed', error);
      }
    },
  );

  return server;
}

export const personalToolsDefinition: McpDefinition = {
  path: NAME,
  name: NAME,
  version: VERSION,
  build: buildServer,
};
