import type { DoctolibClient, DoctolibCountry } from '../../connections/doctolib.js';

/**
 * Doctolib tool handlers: pure functions over an injected {@link DoctolibClient}, so tests run
 * against a fake. Three endpoints carry the whole read path (see the connection's header for
 * the transport quirks):
 *
 *   POST /patient-health-search/api/v1/hcp/search?page=N                    -> practitioners
 *   GET  /online_booking/api/slot_selection_funnel/v1/info.json?profile_slug -> motives/agendas
 *   GET  /availabilities.json                                               -> open slots
 *
 * Each search hit already carries the (visit motive, agendas, practice) triple that
 * availabilities needs, so find_earliest_appointment chains them without a per-practitioner
 * profile lookup.
 */

/**
 * doctolib.de search keywords, each verified to return Berlin results on 2026-10-17. The
 * keyword must match Doctolib's own slug, and the slugs follow no pattern ("urologie" works,
 * "urologe" does not; "radiologe" works, "radiologie" does not), so an unlisted keyword
 * silently returns zero hits rather than an error. Ten of the upstream project's fifteen had
 * gone stale this way — re-probe before adding to it.
 */
export const SPECIALTY_SLUGS: Record<string, string> = {
  allgemeinmedizin: 'GP / family doctor',
  'hausarztlich-tatige-internist-in': 'internist working as GP',
  internist: 'internist',
  zahnmedizin: 'dentist',
  kieferorthopadie: 'orthodontist',
  hautarzt: 'dermatologist',
  augenheilkunde: 'ophthalmologist',
  frauenarzt: 'gynaecologist',
  orthopadie: 'orthopaedist',
  chirurg: 'surgeon',
  handchirurg: 'hand surgeon',
  kardiologie: 'cardiologist',
  gastroenterologie: 'gastroenterologist',
  neurologie: 'neurologist',
  psychiatrie: 'psychiatrist',
  radiologe: 'radiologist',
  urologie: 'urologist',
  physiotherapie: 'physiotherapist',
};

const ZERO_HITS_HINT =
  'No results. Doctolib only matches its own specialty slugs and returns nothing for other ' +
  'spellings: try list_specialties, or a nearby term.';

/** Doctolib serves about two weeks per availabilities call; longer horizons walk start_date. */
export const MAX_DAYS_PER_CALL = 15;
/** Concurrent availability probes in find_earliest_appointment. */
const FAN_OUT = 4;

export interface SearchFilters {
  insuranceSector?: 'public' | 'private';
  /** Doctolib language codes, e.g. `["tr", "gb"]`. */
  languages?: string[];
  /** `false` is meaningful (in-person only) and differs from unset. */
  telehealth?: boolean;
}

export interface Provider {
  name: string;
  profile_slug: string | null;
  profile_url: string | null;
  speciality: string | null;
  city: string | null;
  address: string | null;
  zipcode: string | null;
  languages: string[] | null;
  telehealth: boolean | null;
  bookable_online: boolean;
  visit_motive_id: number | null;
  visit_motive_name: string | null;
  agenda_ids: number[];
  practice_id: number | null;
  accepts_new_patients: boolean | null;
}

interface Slot {
  date: string;
  slots: unknown[];
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** First slot's timestamp — slots arrive as ISO strings or `{start_date}` objects. */
function slotTime(slot: unknown): string {
  if (typeof slot === 'string') {
    return slot;
  }
  return str(obj(slot).start_date) ?? '';
}

/**
 * Geocode a city into the `place` Doctolib's search expects. The viewport is what actually
 * filters: lat/lng without it silently returns nationwide results. Nominatim's bbox is
 * `[south, north, west, east]` — transposing any pair geocodes the wrong city with no error.
 */
export async function resolvePlace(
  client: DoctolibClient,
  city: string,
  country: DoctolibCountry,
): Promise<Json> {
  const hit = await client.geocode(city, country);
  if (!hit) {
    throw new Error(`Could not geocode ${JSON.stringify(city)} in ${country.toUpperCase()}`);
  }
  const [south, north, west, east] = hit.boundingbox.map(Number);
  return {
    name: city,
    slug: city.toLowerCase().trim().replace(/\s+/g, '-'),
    country,
    type: 'locality',
    viewport: {
      northeast: { lat: north, lng: east },
      southwest: { lat: south, lng: west },
    },
    gpsPoint: { lat: Number(hit.lat), lng: Number(hit.lon) },
  };
}

export function normaliseProvider(raw: unknown, baseUrl: string): Provider {
  const h = obj(raw);
  const motive = obj(h.matchedVisitMotive);
  const booking = obj(h.onlineBooking);
  const refs = obj(h.references);
  const loc = obj(h.location);
  const link = str(h.link);
  const slug = link ? (link.split('?')[0].replace(/\/+$/, '').split('/').pop() ?? null) : null;
  // `speciality` is a {name, slug} dict in search results but a bare string elsewhere.
  const speciality =
    typeof h.speciality === 'string' ? h.speciality : (str(obj(h.speciality).name) ?? str(h.subtitle));
  const agendaIds = Array.isArray(booking.agendaIds)
    ? booking.agendaIds
    : Array.isArray(motive.agendaIds)
      ? motive.agendaIds
      : [];
  return {
    name: [str(h.firstName), str(h.name)].filter(Boolean).join(' '),
    profile_slug: slug || null,
    profile_url: link ? `${baseUrl}${link}` : null,
    speciality,
    city: str(loc.city),
    address: str(loc.address),
    zipcode: str(loc.zipcode),
    languages: Array.isArray(h.languages) ? (h.languages as string[]) : null,
    telehealth: bool(booking.telehealth),
    bookable_online: Array.isArray(h.services) && h.services.includes('onlineBooking'),
    visit_motive_id: num(motive.visitMotiveId),
    visit_motive_name: str(motive.name),
    agenda_ids: agendaIds.filter((a): a is number => typeof a === 'number'),
    practice_id: num(refs.practiceId),
    accepts_new_patients: bool(motive.allowNewPatients),
  };
}

export function listSpecialties(): { specialties: Record<string, string>; note: string } {
  return {
    specialties: SPECIALTY_SLUGS,
    note: 'Verified on doctolib.de. Other slugs may exist; an unrecognised one returns zero results.',
  };
}

export async function searchDoctors(
  client: DoctolibClient,
  args: { specialty: string; city: string; country: DoctolibCountry; page?: number } & SearchFilters,
): Promise<{ total: number | null; page: number; providers: Provider[]; hint?: string }> {
  const place = await resolvePlace(client, args.city, args.country);
  const filters: Json = {};
  if (args.insuranceSector) {
    filters.insuranceSector = args.insuranceSector;
  }
  if (args.languages?.length) {
    filters.languages = args.languages;
  }
  if (args.telehealth !== undefined) {
    filters.telehealth = args.telehealth;
  }
  const page = args.page ?? 0;
  const data = obj(
    await client.request(args.country, 'POST', '/patient-health-search/api/v1/hcp/search', {
      params: { page },
      body: { keyword: args.specialty, location: { place }, filters },
    }),
  );
  const hits = Array.isArray(data.healthcareProviders) ? data.healthcareProviders : [];
  return {
    total: num(data.total),
    page,
    providers: hits.map((h) => normaliseProvider(h, client.baseUrl(args.country))),
    ...(hits.length === 0 && page === 0 ? { hint: ZERO_HITS_HINT } : {}),
  };
}

export async function getPractitioner(
  client: DoctolibClient,
  args: { profileSlug: string; country: DoctolibCountry },
): Promise<Json> {
  const data = obj(
    await client.request(args.country, 'GET', '/online_booking/api/slot_selection_funnel/v1/info.json', {
      params: { profile_slug: args.profileSlug, locale: args.country },
    }),
  );
  const d = obj(data.data);
  const prof = obj(d.profile);
  const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
  // `redirect_url` is the specialty/city listing (`/zahnmedizin/berlin`), not the profile; the
  // profile page is that path plus the slug. Older payloads carried the full path already.
  let redirect = str(prof.redirect_url)?.replace(/\/+$/, '') ?? null;
  if (redirect && !redirect.endsWith(`/${args.profileSlug}`)) {
    redirect = `${redirect}/${args.profileSlug}`;
  }
  return {
    profile_id: num(prof.id),
    name: str(prof.name_with_title),
    speciality: str(prof.subtitle),
    telehealth_enabled: bool(prof.telehealth_enabled),
    profile_url: redirect ? `${client.baseUrl(args.country)}${redirect}` : null,
    visit_motives: list(d.visit_motives).map((m) => ({
      id: m.id,
      name: m.name,
      telehealth: m.telehealth,
      allow_new_patients: m.allow_new_patients,
    })),
    agendas: list(d.agendas).map((a) => ({
      id: a.id,
      practice_id: a.practice_id,
      visit_motive_ids: a.visit_motive_ids,
    })),
    places: list(d.places).map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      city: p.city,
      practice_ids: p.practice_ids,
    })),
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Open slots for one motive/agenda/practice triple, walking `days` in ≤15-day windows.
 * Doctolib rejects `limit < 2` with a 400, so each window's limit is floored at 2 — a trailing
 * 1-day chunk therefore reaches a day further than asked, which is harmless.
 * `reason: not_opened_availability` means the practice has not released that far ahead yet,
 * which is different from being fully booked; it is passed through to the caller.
 */
export async function getAvailabilities(
  client: DoctolibClient,
  args: {
    visitMotiveId: number;
    agendaIds: number[];
    practiceId: number;
    startDate?: string;
    days?: number;
    country: DoctolibCountry;
  },
): Promise<{ total: number; days_with_slots: Slot[]; first_slot: string | null; reason: string | null }> {
  let cursor = args.startDate ?? new Date().toISOString().slice(0, 10);
  let remaining = Math.max(2, args.days ?? 14);
  const out: Slot[] = [];
  let total = 0;
  let reason: string | null = null;

  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_DAYS_PER_CALL);
    const data = obj(
      await client.request(args.country, 'GET', '/availabilities.json', {
        params: {
          start_date: cursor,
          visit_motive_ids: args.visitMotiveId,
          agenda_ids: args.agendaIds.join('-'),
          practice_ids: args.practiceId,
          limit: Math.max(2, chunk),
        },
      }),
    );
    for (const day of Array.isArray(data.availabilities) ? data.availabilities.map(obj) : []) {
      if (Array.isArray(day.slots) && day.slots.length) {
        out.push({ date: String(day.date), slots: day.slots });
      }
    }
    total += num(data.total) ?? 0;
    reason = str(data.reason) ?? reason;
    cursor = addDays(cursor, chunk);
    remaining -= chunk;
  }

  return {
    total,
    days_with_slots: out,
    first_slot: out.length ? slotTime(out[0].slots[0]) : null,
    reason,
  };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Search, then probe each bookable hit's availability and return the soonest slots first.
 * This is the tool worth having: the website makes you open practitioners one at a time.
 * A probe that fails is counted in `errors` instead of failing the whole search.
 */
export async function findEarliestAppointment(
  client: DoctolibClient,
  args: {
    specialty: string;
    city: string;
    country: DoctolibCountry;
    withinDays?: number;
    limit?: number;
    scan?: number;
  } & SearchFilters,
): Promise<Json> {
  const found = await searchDoctors(client, args);
  const candidates = found.providers
    .filter((p) => p.visit_motive_id !== null && p.agenda_ids.length && p.practice_id !== null)
    .slice(0, args.scan ?? 20);

  const probed = await mapLimit(candidates, FAN_OUT, async (p) => {
    try {
      const av = await getAvailabilities(client, {
        visitMotiveId: p.visit_motive_id as number,
        agendaIds: p.agenda_ids,
        practiceId: p.practice_id as number,
        days: args.withinDays ?? 14,
        country: args.country,
      });
      return {
        ...p,
        first_slot: av.first_slot,
        slot_count: av.total,
        days_with_slots: av.days_with_slots.slice(0, 3),
        reason: av.reason,
      };
    } catch (error) {
      return {
        ...p,
        first_slot: null,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      };
    }
  });

  const withSlots = probed
    .filter((p) => p.first_slot)
    // Compare instants, not strings: slots carry UTC offsets that differ across DST.
    .sort((a, b) => Date.parse(a.first_slot as string) - Date.parse(b.first_slot as string));
  return {
    searched: candidates.length,
    with_availability: withSlots.length,
    errors: probed.filter((p) => 'error' in p).length,
    total_matching_practitioners: found.total,
    results: withSlots.slice(0, args.limit ?? 10),
    ...(found.hint ? { hint: found.hint } : {}),
  };
}

/** The URL a human opens to book in a browser — the safe handoff; commits nothing. */
export async function bookingUrl(
  client: DoctolibClient,
  args: { profileSlug: string; country: DoctolibCountry },
): Promise<{ name: unknown; booking_url: string; note: string }> {
  const p = await getPractitioner(client, args);
  return {
    name: p.name,
    booking_url:
      (p.profile_url as string | null) ?? `${client.baseUrl(args.country)}/booking/${args.profileSlug}`,
    note: 'Open in a browser and complete the booking there.',
  };
}
