import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConnections } from '../../connections/registry.js';
import type { McpDefinition } from '../../registry/types.js';
import { getAppVersion } from '../../version.js';
import { MUSCLE_GROUPS } from './hevy-payloads.js';
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
  hevyGetWorkout,
  hevyRecentActivity,
  hevyRoutines,
  hevySearchExerciseCatalog,
  hevyWriteRoutine,
  ynabAccounts,
  ynabBudgets,
  ynabCategories,
  ynabCreateTransaction,
  ynabPayees,
  ynabReport,
  ynabScheduled,
  ynabTransactions,
} from './tools.js';

const NAME = 'personal-tools';
// Sourced from package.json — MCPs are versioned service-wide (see getAppVersion).
const VERSION = getAppVersion();

const INSTRUCTIONS =
  "Action layer over Pablo's personal accounts, ported from the my-mcp-platform Python " +
  'server. Three integrations: YNAB budgeting (ynab_* — budgets, accounts, transactions, ' +
  'categories, payees, scheduled transactions, aggregated reports), Hevy workout tracking ' +
  '(hevy_* — recent training by muscle group and day, logged workouts, routines, body ' +
  'measurements, and exercise-catalog search), and Google Calendar (gcal_* — list ' +
  'calendars/events, get/create/update/delete an event, free/busy lookup). Raw YNAB amounts ' +
  'are in milliunits (1000 = one currency unit); ynab_report already converts to currency ' +
  'units. Most ynab_* tools default to the last-used budget — call ynab_budgets only when ' +
  'another budget is needed. gcal_* tools default to the "primary" calendar. Hevy is read-only ' +
  'except for hevy_write_routine, which creates a reusable plan when no routine_id is passed ' +
  'and updates one when it is, preserving any field you omit; exercises there are addressed by ' +
  'exercise_template_id, so call hevy_search_exercise_catalog first (or pass a name and let it ' +
  'resolve), and dry_run previews the request body. Hevy cannot log or edit a workout, create a ' +
  'custom exercise, or delete anything — those happen in the app.';

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
  .describe('Budget to query; defaults to the last-used budget');

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

  server.registerTool(
    'ynab_budgets',
    {
      title: 'List YNAB budgets',
      description:
        'List all budgets (id, name, last modified), or pass budget_id for one budget in full ' +
        'detail. Only needed to discover budget ids — every other ynab_* tool defaults to the ' +
        'last-used budget.',
      inputSchema: { budget_id: z.string().optional().describe('One budget in full detail') },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabBudgets(getConnections().ynab.get(), { budgetId: args.budget_id }),
        );
      } catch (error) {
        return errorResult('YNAB budgets failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_accounts',
    {
      title: 'List YNAB accounts',
      description:
        'List all accounts with balances (milliunits), or pass account_id for one account. ' +
        'For net worth or currency-unit balances prefer ynab_report kind=net_worth.',
      inputSchema: {
        budget_id: budgetId,
        account_id: z.string().optional().describe('One account instead of the full list'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabAccounts(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            accountId: args.account_id,
          }),
        );
      } catch (error) {
        return errorResult('YNAB accounts failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_transactions',
    {
      title: 'Query YNAB transactions',
      description:
        'Query transactions. Scope precedence: transaction_id (single) > account_id > ' +
        'category_id > payee_id > whole budget (then since_date is required to bound the ' +
        'result). Default compact view: date, amount (milliunits, negative = outflow), payee, ' +
        'category, account, memo; verbose=true returns full objects with ids/subtransactions.',
      inputSchema: {
        budget_id: budgetId,
        transaction_id: z.string().optional().describe('Fetch exactly one transaction'),
        account_id: z.string().optional().describe('Transactions of one account'),
        category_id: z.string().optional().describe('Transactions of one category'),
        payee_id: z.string().optional().describe('Transactions of one payee'),
        since_date: z
          .string()
          .optional()
          .describe('YYYY-MM-DD; only transactions on/after this date'),
        type: z
          .enum(['uncategorized', 'unapproved'])
          .optional()
          .describe('Restrict to uncategorized or unapproved transactions'),
        verbose: z.boolean().optional().describe('Full YNAB objects instead of the compact view'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabTransactions(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            transactionId: args.transaction_id,
            accountId: args.account_id,
            categoryId: args.category_id,
            payeeId: args.payee_id,
            sinceDate: args.since_date,
            type: args.type,
            verbose: args.verbose,
          }),
        );
      } catch (error) {
        return errorResult('YNAB transactions failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_create_transaction',
    {
      title: 'Create YNAB transaction',
      description:
        'Create a transaction. amount is in milliunits (negative = outflow, e.g. -12340 = ' +
        'spending 12.34); date is YYYY-MM-DD. Get account_id from ynab_accounts.',
      inputSchema: {
        budget_id: budgetId,
        account_id: z.string().describe('Account the transaction belongs to'),
        date: z.string().describe('Transaction date, YYYY-MM-DD'),
        amount: z.number().int().describe('Milliunits; negative = outflow'),
        payee_name: z.string().optional().describe('Payee display name'),
        category_id: z.string().optional().describe('Category from ynab_categories'),
        memo: z.string().optional(),
      },
    },
    async args => {
      try {
        return jsonResult(
          await ynabCreateTransaction(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            accountId: args.account_id,
            date: args.date,
            amount: args.amount,
            payeeName: args.payee_name,
            categoryId: args.category_id,
            memo: args.memo,
          }),
        );
      } catch (error) {
        return errorResult('YNAB create transaction failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_categories',
    {
      title: 'List YNAB categories',
      description:
        'List all category groups with their categories, or pass category_id (plus optional ' +
        'month, "current" or YYYY-MM-01) for one category with its goal progress that month.',
      inputSchema: {
        budget_id: budgetId,
        category_id: z.string().optional().describe('One category, month-scoped, with goals'),
        month: z.string().optional().describe('"current" (default) or YYYY-MM-01'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabCategories(getConnections().ynab.get(), {
            budgetId: args.budget_id,
            categoryId: args.category_id,
            month: args.month,
          }),
        );
      } catch (error) {
        return errorResult('YNAB categories failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_payees',
    {
      title: 'List YNAB payees',
      description: 'List all payees in a budget.',
      inputSchema: { budget_id: budgetId },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabPayees(getConnections().ynab.get(), { budgetId: args.budget_id }),
        );
      } catch (error) {
        return errorResult('YNAB payees failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_scheduled',
    {
      title: 'List YNAB scheduled transactions',
      description: 'List all scheduled (recurring) transactions in a budget.',
      inputSchema: { budget_id: budgetId },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(
          await ynabScheduled(getConnections().ynab.get(), { budgetId: args.budget_id }),
        );
      } catch (error) {
        return errorResult('YNAB scheduled failed', error);
      }
    },
  );

  server.registerTool(
    'ynab_report',
    {
      title: 'YNAB financial report',
      description:
        'Aggregated reports in currency units (not milliunits). kind=net_worth: assets, ' +
        'liabilities, per-account breakdown. kind=monthly_summary: income, spending, savings ' +
        'rate, top categories for a month ("current" or YYYY-MM-01). kind=full: net worth + ' +
        'current month + cash-flow history over months_back (default 3) months.',
      inputSchema: {
        budget_id: budgetId,
        kind: z.enum(['net_worth', 'monthly_summary', 'full']),
        month: z.string().optional().describe('For monthly_summary: "current" or YYYY-MM-01'),
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

  const dryRun = z
    .boolean()
    .optional()
    .describe('Return the request body that would be sent, without sending it');

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
