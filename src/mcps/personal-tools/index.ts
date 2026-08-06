import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConnections } from '../../connections/registry.js';
import type { McpDefinition } from '../../registry/types.js';
import { getAppVersion } from '../../version.js';
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
  '(hevy_* — recent activity, muscle-group breakdown), and Google Calendar (gcal_* — list ' +
  'calendars/events, get/create/update/delete an event, free/busy lookup). Raw YNAB amounts ' +
  'are in milliunits (1000 = one currency unit); ynab_report already converts to currency ' +
  'units. Most ynab_* tools default to the last-used budget — call ynab_budgets only when ' +
  'another budget is needed. gcal_* tools default to the "primary" calendar.';

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
      title: 'Recent Hevy workouts',
      description:
        'Summary of recent gym activity: total workouts, working sets, volume (kg), and ' +
        'per-session breakdowns (exercises, duration, volume) over the last N days. Warmup ' +
        'sets are excluded from counts and volume.',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('Lookback window (default 14)'),
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

  server.registerTool(
    'hevy_activity_by_muscle',
    {
      title: 'Hevy activity by muscle group',
      description:
        'Recent gym activity broken down by muscle group (via Hevy exercise-template ' +
        'metadata): sets and volume per group, split into primary/secondary involvement, ' +
        'sorted by volume. Groups: abdominals, shoulders, biceps, triceps, forearms, ' +
        'quadriceps, hamstrings, calves, glutes, abductors, adductors, lats, upper_back, ' +
        'traps, lower_back, chest, cardio, neck, full_body, other.',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('Lookback window (default 14)'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(await hevyActivityByMuscle(getConnections().hevy.get(), args));
      } catch (error) {
        return errorResult('Hevy activity by muscle failed', error);
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
