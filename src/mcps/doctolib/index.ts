import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DOCTOLIB_COUNTRIES, type DoctolibCountry } from '../../connections/doctolib.js';
import { getConnections } from '../../connections/registry.js';
import type { McpDefinition } from '../../registry/types.js';
import { getAppVersion } from '../../version.js';
import {
  bookingUrl,
  findEarliestAppointment,
  getAvailabilities,
  getPractitioner,
  listSpecialties,
  searchDoctors,
} from './tools.js';

const NAME = 'doctolib';
// Sourced from package.json — MCPs are versioned service-wide (see getAppVersion).
const VERSION = getAppVersion();

const INSTRUCTIONS =
  'Find doctor appointments on Doctolib (doctolib.de / .fr / .it) through the JSON API its ' +
  'patient website uses. Read-only: nothing here books or cancels. Start with ' +
  'find_earliest_appointment — it searches a specialty in a city and checks every match for ' +
  'open slots, soonest first. Use search_doctors to browse without availability, ' +
  'get_practitioner when the visit motive search matched is not the one needed (e.g. a ' +
  'first-visit motive instead of acute care), and get_availabilities for one ' +
  "motive/agenda/practice triple. The specialty must be one of Doctolib's German slugs " +
  '(list_specialties): other spellings return zero results, not an error. To book, hand the user booking_url and let them finish in a browser. A ' +
  'reason of "not_opened_availability" means the practice has not released slots that far ' +
  'ahead yet, which is not the same as fully booked.';

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

/** Accepts `"12,34"`, `"12-34"`, `12` or `[12, 34]` — search output and humans differ. */
function parseIds(value: string | number | number[]): number[] {
  if (Array.isArray(value)) {
    return value;
  }
  return String(value)
    .split(/[,-]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

function parseLanguages(value: string | undefined): string[] | undefined {
  const langs = value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return langs?.length ? langs : undefined;
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
  const specialty = z
    .string()
    .min(1)
    .describe('Doctolib specialty slug from list_specialties, e.g. "zahnmedizin" for a dentist');
  const city = z.string().min(1).optional().describe('City or address to search around (default Berlin)');
  const insuranceSector = z
    .enum(['public', 'private'])
    .optional()
    .describe('"public" (gesetzlich) or "private"');
  const languages = z
    .string()
    .optional()
    .describe('Comma-separated Doctolib language codes the doctor speaks, e.g. "en" or "tr,gb"');
  const telehealth = z
    .boolean()
    .optional()
    .describe('true = video consultations only, false = in-person only; omit for both');

  server.registerTool(
    'list_specialties',
    {
      title: 'List Doctolib specialties',
      description:
        'Common Doctolib specialty slugs (German) with English meanings, for the `specialty` ' +
        'argument. Doctolib matches only its own slugs; a close spelling (e.g. "zahnarzt" ' +
        'instead of "zahnmedizin") returns zero results without an error.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => jsonResult(listSpecialties()),
  );

  server.registerTool(
    'find_earliest_appointment',
    {
      title: 'Find the earliest Doctolib appointment',
      description:
        "The main tool. Searches practitioners for a specialty in a city, checks each one's " +
        'open slots (up to `scan` practitioners, 4 at a time), and returns them sorted by ' +
        'earliest slot. Each result carries profile_url and the ids get_availabilities needs.',
      inputSchema: {
        specialty,
        city,
        within_days: z.number().int().min(2).max(90).optional().describe('Horizon in days (default 14)'),
        insurance_sector: insuranceSector,
        languages,
        telehealth,
        limit: z.number().int().min(1).max(50).optional().describe('Results to return (default 10)'),
        scan: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('Practitioners to probe for availability (default 20)'),
        country,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(
          await findEarliestAppointment(doctolib.get(), {
            specialty: args.specialty,
            city: args.city ?? 'Berlin',
            country: args.country ?? doctolib.defaultCountry,
            withinDays: args.within_days,
            insuranceSector: args.insurance_sector,
            languages: parseLanguages(args.languages),
            telehealth: args.telehealth,
            limit: args.limit,
            scan: args.scan,
          }),
        );
      } catch (error) {
        return errorResult('Doctolib earliest-appointment search failed', error);
      }
    },
  );

  server.registerTool(
    'search_doctors',
    {
      title: 'Search Doctolib practitioners',
      description:
        'Search practitioners without checking availability. Each result carries ' +
        'visit_motive_id, agenda_ids and practice_id — the triple get_availabilities needs — ' +
        'plus profile_slug for get_practitioner / booking_url.',
      inputSchema: {
        specialty,
        city,
        insurance_sector: insuranceSector,
        languages,
        telehealth,
        page: z.number().int().min(0).optional().describe('Result page, 0-based (default 0)'),
        country,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(
          await searchDoctors(doctolib.get(), {
            specialty: args.specialty,
            city: args.city ?? 'Berlin',
            country: args.country ?? doctolib.defaultCountry,
            insuranceSector: args.insurance_sector,
            languages: parseLanguages(args.languages),
            telehealth: args.telehealth,
            page: args.page,
          }),
        );
      } catch (error) {
        return errorResult('Doctolib search failed', error);
      }
    },
  );

  server.registerTool(
    'get_practitioner',
    {
      title: 'Get a Doctolib practitioner',
      description:
        'All visit motives, agendas and practice locations for one practitioner. Use it when ' +
        'the motive search matched is not the one wanted — a first-visit motive often has ' +
        'entirely different availability from acute care.',
      inputSchema: {
        profile_slug: z.string().min(1).describe('profile_slug from search results'),
        country,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(
          await getPractitioner(doctolib.get(), {
            profileSlug: args.profile_slug,
            country: args.country ?? doctolib.defaultCountry,
          }),
        );
      } catch (error) {
        return errorResult('Doctolib practitioner lookup failed', error);
      }
    },
  );

  server.registerTool(
    'get_availabilities',
    {
      title: 'Get Doctolib availabilities',
      description:
        'Open slots for one visit motive / agenda / practice triple (from search_doctors or ' +
        'get_practitioner). A reason of "not_opened_availability" means the practice has not ' +
        'released slots that far ahead yet — different from fully booked.',
      inputSchema: {
        visit_motive_id: z.number().int().describe('visit_motive_id'),
        agenda_ids: z
          .union([z.string(), z.number(), z.array(z.number())])
          .describe('Agenda ids: array, or comma/hyphen-separated string'),
        practice_id: z.number().int().describe('practice_id'),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD (default today)'),
        days: z.number().int().min(2).max(90).optional().describe('Horizon in days (default 14)'),
        country,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const agendaIds = parseIds(args.agenda_ids);
        if (!agendaIds.length) {
          return textResult('agenda_ids must contain at least one id', true);
        }
        return jsonResult(
          await getAvailabilities(doctolib.get(), {
            visitMotiveId: args.visit_motive_id,
            agendaIds,
            practiceId: args.practice_id,
            startDate: args.start_date,
            days: args.days,
            country: args.country ?? doctolib.defaultCountry,
          }),
        );
      } catch (error) {
        return errorResult('Doctolib availability lookup failed', error);
      }
    },
  );

  server.registerTool(
    'booking_url',
    {
      title: 'Doctolib booking link',
      description:
        'The URL a human opens to book with this practitioner in a browser. Commits nothing; ' +
        'this is how to hand off a booking.',
      inputSchema: {
        profile_slug: z.string().min(1).describe('profile_slug from search results'),
        country,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(
          await bookingUrl(doctolib.get(), {
            profileSlug: args.profile_slug,
            country: args.country ?? doctolib.defaultCountry,
          }),
        );
      } catch (error) {
        return errorResult('Doctolib booking link failed', error);
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
