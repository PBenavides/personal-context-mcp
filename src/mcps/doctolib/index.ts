import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DOCTOLIB_COUNTRIES, type DoctolibCountry } from '../../connections/doctolib.js';
import { getConnections } from '../../connections/registry.js';
import type { McpDefinition } from '../../registry/types.js';
import { getAppVersion } from '../../version.js';
import { SPECIALTY_GUIDE, doctolibPractitioner, doctolibSearch } from './tools.js';

const NAME = 'doctolib';
// Sourced from package.json — MCPs are versioned service-wide (see getAppVersion).
const VERSION = getAppVersion();

const INSTRUCTIONS =
  'Find doctor appointments on Doctolib (doctolib.de / .fr / .it) through the JSON API its ' +
  'patient website uses. Read-only: nothing here books or cancels. Two tools. ' +
  'doctolib_search finds practitioners for a specialty in a city and, by default, checks ' +
  'their open slots and sorts them soonest first; pass availability: false to just browse. ' +
  'doctolib_practitioner shows one profile (visit motives, places, booking link); add ' +
  "visit_motive_id to see that motive's slots, e.g. a first visit instead of the acute-care " +
  "motive search matched. The specialty must be one of Doctolib's German slugs: other " +
  'spellings return zero results, not an error. To book, give the user booking_url and let ' +
  'them finish in a browser. A reason of "not_opened_availability" means the practice has ' +
  'not released slots that far ahead yet, which is not the same as fully booked.';

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
  return textResult(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, true);
}

/**
 * Doctolib's language filter takes flag-style codes: English is "gb", and "en" silently
 * matches nobody (0 vs 464 public GPs in Berlin, 2026-10-17). Found by the agent eval —
 * models reach for "en" — so it is aliased rather than left to fail.
 */
const LANGUAGE_ALIASES: Record<string, string> = { en: 'gb' };

function parseLanguages(value: string | undefined): string[] | undefined {
  const langs = value
    ?.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => LANGUAGE_ALIASES[s] ?? s);
  return langs?.length ? [...new Set(langs)] : undefined;
}

/**
 * Builds a fresh doctolib MCP server. Handlers live in `./tools.js` (unit-tested with a fake
 * client); the connection is a shared module-scoped singleton (see `getConnections`).
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  const doctolib = getConnections().doctolib;

  const country = z
    .enum(DOCTOLIB_COUNTRIES as [DoctolibCountry, ...DoctolibCountry[]])
    .optional()
    .describe(`Doctolib site: de, fr or it (default ${doctolib.defaultCountry})`);
  const days = z.number().int().min(2).max(90).optional().describe('Horizon in days (default 14)');

  server.registerTool(
    'doctolib_search',
    {
      title: 'Search Doctolib for practitioners and their earliest slots',
      description:
        'Find practitioners for a specialty in a city. By default checks every bookable match ' +
        'for open slots and returns them soonest first, each with next_slot, a few days of ' +
        'times, booking_url, and the profile_slug and motive_id doctolib_practitioner takes. ' +
        'availability: false returns the plain list (faster; use page to go further).',
      inputSchema: {
        specialty: z
          .string()
          .min(1)
          .describe(
            'Doctolib specialty slug. Use exactly one of these — other spellings return no ' +
              `results: ${SPECIALTY_GUIDE}`,
          ),
        city: z.string().min(1).optional().describe('City or address to search around (default Berlin)'),
        availability: z.boolean().optional().describe('Check open slots and sort by earliest (default true)'),
        within_days: days,
        insurance_sector: z
          .enum(['public', 'private'])
          .optional()
          .describe('"public" (gesetzlich) or "private"'),
        languages: z
          .string()
          .optional()
          .describe(
            'Comma-separated language codes the doctor speaks. Flag-style: English is "gb" ' +
              '(not "en"), e.g. "gb" or "tr,gb"',
          ),
        telehealth: z
          .boolean()
          .optional()
          .describe('true = video consultations only, false = in-person only; omit for both'),
        limit: z.number().int().min(1).max(20).optional().describe('Results to return (default 10)'),
        page: z.number().int().min(0).optional().describe('Search result page, 0-based (default 0)'),
        country,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(
          await doctolibSearch(doctolib.get(), {
            specialty: args.specialty,
            city: args.city ?? 'Berlin',
            country: args.country ?? doctolib.defaultCountry,
            availability: args.availability,
            withinDays: args.within_days,
            insuranceSector: args.insurance_sector,
            languages: parseLanguages(args.languages),
            telehealth: args.telehealth,
            limit: args.limit,
            page: args.page,
          }),
        );
      } catch (error) {
        return errorResult('Doctolib search failed', error);
      }
    },
  );

  server.registerTool(
    'doctolib_practitioner',
    {
      title: 'Doctolib practitioner profile and slots',
      description:
        'One practitioner by profile_slug: visit motives (with ids), places, and booking_url — ' +
        "the link a human opens to book. Pass visit_motive_id to also get that motive's open " +
        'slots, by place and day; start_date and days move the window.',
      inputSchema: {
        profile_slug: z.string().min(1).describe('profile_slug from doctolib_search'),
        visit_motive_id: z
          .number()
          .int()
          .optional()
          .describe('A motive id from this profile (or motive_id from doctolib_search) to get slots for'),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD; first day of the slot window (default today)'),
        days,
        country,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(
          await doctolibPractitioner(doctolib.get(), {
            profileSlug: args.profile_slug,
            country: args.country ?? doctolib.defaultCountry,
            visitMotiveId: args.visit_motive_id,
            startDate: args.start_date,
            days: args.days,
          }),
        );
      } catch (error) {
        return errorResult('Doctolib practitioner lookup failed', error);
      }
    },
  );

  return server;
}

export const doctolibDefinition: McpDefinition = {
  path: NAME,
  name: NAME,
  version: VERSION,
  build: buildServer,
};
