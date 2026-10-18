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
 * availabilities needs, so doctolibSearch chains them without a per-practitioner profile
 * lookup; doctolibPractitioner derives the same triple from a profile's agendas.
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

/** `zahnmedizin (dentist), hautarzt (dermatologist), …` — for tool descriptions and hints. */
export const SPECIALTY_GUIDE = Object.entries(SPECIALTY_SLUGS)
  .map(([slug, meaning]) => `${slug} (${meaning})`)
  .join(', ');

// The slug list rides along in the hint, so recovering from a miss costs no extra call.
const ZERO_HITS_HINT =
  'No results. Doctolib only matches its own specialty slugs and returns nothing for other ' +
  `spellings. Verified slugs: ${SPECIALTY_GUIDE}.`;

/** Doctolib serves about two weeks per availabilities call; longer horizons walk start_date. */
export const MAX_DAYS_PER_CALL = 15;
/** Concurrent availability probes (search fan-out, multi-place practitioners). */
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

/** Non-empty trimmed string or null — Doctolib names carry stray trailing spaces. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
      name: str(m.name),
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
      name: str(p.name),
      address: str(p.address),
      city: str(p.city),
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

// ---------------------------------------------------------------------------------------------
// The tool surface. Two intent-level tools sit on the building blocks above:
//
//   doctolibSearch        "who, and when is the soonest slot?"  (search ± availability)
//   doctolibPractitioner  "tell me about this one / when can I see them for X?"
//
// Responses are shaped for a model to read: slots as {date: ["HH:MM", …]}, no internal ids
// (agendas, practices) the caller never needs to pass back, and no null fields.
// ---------------------------------------------------------------------------------------------

/** Days and times shown per search result: enough to compare practices, not a full calendar. */
const SEARCH_PREVIEW_DAYS = 3;
const SEARCH_PREVIEW_TIMES = 6;
/** A practitioner's availability shows every day in the window, capped per day. */
const PROFILE_TIMES_PER_DAY = 12;

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) {
    return true;
  }
  if (Array.isArray(v)) {
    return v.length === 0;
  }
  return typeof v === 'object' && Object.keys(v as object).length === 0;
}

/** Drop null, undefined and empty array/object fields so results carry only what is known. */
function compact<T extends Json>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => !isEmpty(v))) as Partial<T>;
}

/** `2026-10-17T18:45:00.000+02:00` -> `2026-10-17 18:45`, in the practice's own local time. */
export function formatSlot(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** `[{date, slots}]` -> `{date: ["HH:MM", …]}`, at most `maxDays` days and `maxTimes` each. */
export function slotsByDay(days: Slot[], maxDays: number, maxTimes: number): Record<string, string[]> {
  return Object.fromEntries(
    days
      .slice(0, maxDays)
      .map((d) => [d.date, d.slots.slice(0, maxTimes).map((s) => slotTime(s).slice(11, 16))]),
  );
}

function address(p: Provider): string | null {
  const cityLine = [p.zipcode, p.city].filter(Boolean).join(' ');
  return [p.address, cityLine].filter(Boolean).join(', ') || null;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}

/** One search hit, as the caller sees it: who, where, which motive, and how to follow up. */
function presentProvider(p: Provider): Json {
  return compact({
    name: p.name,
    speciality: p.speciality,
    address: address(p),
    languages: p.languages,
    telehealth: p.telehealth || null,
    new_patients: p.accepts_new_patients,
    bookable_online: p.bookable_online ? null : false,
    motive: p.visit_motive_name,
    motive_id: p.visit_motive_id,
    profile_slug: p.profile_slug,
    booking_url: p.profile_url,
  });
}

/**
 * Search practitioners and, by default, check each one's open slots, soonest first. With
 * `availability: false` it is a plain paged search. A failed probe is counted in
 * `probe_errors` instead of failing the whole search.
 */
export async function doctolibSearch(
  client: DoctolibClient,
  args: {
    specialty: string;
    city: string;
    country: DoctolibCountry;
    availability?: boolean;
    withinDays?: number;
    limit?: number;
    page?: number;
  } & SearchFilters,
): Promise<Json> {
  const found = await searchDoctors(client, args);
  const limit = args.limit ?? 10;
  const head = compact({
    specialty: args.specialty,
    city: args.city,
    total_matching: found.total,
    hint: found.hint,
  });

  if (args.availability === false) {
    return {
      ...head,
      page: found.page,
      results: found.providers.slice(0, limit).map(presentProvider),
    };
  }

  // Probe every bookable hit on the page; `limit` only trims what is returned.
  const candidates = found.providers.filter(
    (p) => p.visit_motive_id !== null && p.agenda_ids.length && p.practice_id !== null,
  );
  const probed = await mapLimit(candidates, FAN_OUT, async (p) => {
    try {
      const av = await getAvailabilities(client, {
        visitMotiveId: p.visit_motive_id as number,
        agendaIds: p.agenda_ids,
        practiceId: p.practice_id as number,
        days: args.withinDays ?? 14,
        country: args.country,
      });
      return { p, av };
    } catch (error) {
      return { p, error: errorText(error) };
    }
  });

  const withSlots = probed
    .filter((r) => r.av?.first_slot)
    // Compare instants, not strings: slots carry UTC offsets that differ across DST.
    .sort((a, b) => Date.parse(a.av?.first_slot as string) - Date.parse(b.av?.first_slot as string));
  return {
    ...head,
    checked: candidates.length,
    with_availability: withSlots.length,
    ...(probed.some((r) => r.error) ? { probe_errors: probed.filter((r) => r.error).length } : {}),
    results: withSlots.slice(0, limit).map(({ p, av }) => ({
      ...presentProvider(p),
      next_slot: formatSlot(av?.first_slot as string),
      slots_in_window: av?.total,
      slots: slotsByDay(av?.days_with_slots ?? [], SEARCH_PREVIEW_DAYS, SEARCH_PREVIEW_TIMES),
    })),
  };
}

/**
 * One practitioner: visit motives, places and the booking link, plus — when `visitMotiveId`
 * is given — that motive's open slots. The agendas and practices the availability call needs
 * are derived from the profile, so the caller only ever passes the motive id; a motive offered
 * at several places is checked at each.
 */
export async function doctolibPractitioner(
  client: DoctolibClient,
  args: {
    profileSlug: string;
    country: DoctolibCountry;
    visitMotiveId?: number;
    startDate?: string;
    days?: number;
  },
): Promise<Json> {
  const prof = await getPractitioner(client, args);
  const motives = prof.visit_motives as Json[];
  const agendas = prof.agendas as { id: unknown; practice_id: unknown; visit_motive_ids: unknown }[];
  const places = prof.places as Json[];
  const placeFor = (practiceId: unknown): Json | undefined =>
    places.find((pl) => Array.isArray(pl.practice_ids) && pl.practice_ids.includes(practiceId));

  const out: Json = compact({
    name: prof.name,
    speciality: prof.speciality,
    // Practices ("organizations") come with an empty redirect_url. /profiles/<slug> redirects
    // to the real page for both kinds; /booking/<slug> silently lands on the homepage.
    booking_url: prof.profile_url ?? `${client.baseUrl(args.country)}/profiles/${args.profileSlug}`,
    telehealth: prof.telehealth_enabled || null,
    places: places.map((pl) => compact({ name: pl.name, address: pl.address, city: pl.city })),
    motives: motives.map((m) =>
      compact({
        id: m.id,
        name: m.name,
        telehealth: m.telehealth || null,
        new_patients: m.allow_new_patients,
      }),
    ),
  });
  if (args.visitMotiveId === undefined) {
    return out;
  }

  const motive = motives.find((m) => m.id === args.visitMotiveId);
  if (!motive) {
    throw new Error(
      `visit motive ${args.visitMotiveId} is not offered by ${args.profileSlug}; ` +
        `offered: ${motives.map((m) => `${m.id} (${m.name})`).join(', ')}`,
    );
  }
  // Group the motive's agendas by practice: availabilities.json takes one practice per call.
  const byPractice = new Map<number, number[]>();
  for (const a of agendas) {
    if (
      Array.isArray(a.visit_motive_ids) &&
      a.visit_motive_ids.includes(args.visitMotiveId) &&
      typeof a.id === 'number' &&
      typeof a.practice_id === 'number'
    ) {
      byPractice.set(a.practice_id, [...(byPractice.get(a.practice_id) ?? []), a.id]);
    }
  }
  if (!byPractice.size) {
    return { ...out, availability: { motive: motive.name, note: 'no online agenda for this motive' } };
  }

  const perPlace = await mapLimit([...byPractice], FAN_OUT, async ([practiceId, agendaIds]) => {
    const where = placeFor(practiceId);
    const label = (str(where?.name) ?? str(where?.address) ?? `practice ${practiceId}`) as string;
    try {
      const av = await getAvailabilities(client, {
        visitMotiveId: args.visitMotiveId as number,
        agendaIds,
        practiceId,
        startDate: args.startDate,
        days: args.days,
        country: args.country,
      });
      return compact({
        place: label,
        next_slot: av.first_slot ? formatSlot(av.first_slot) : null,
        slots_in_window: av.total,
        // Keep the distinction from "fully booked": the practice has not opened that far yet.
        reason: av.reason,
        slots: slotsByDay(av.days_with_slots, Number.MAX_SAFE_INTEGER, PROFILE_TIMES_PER_DAY),
      });
    } catch (error) {
      return { place: label, error: errorText(error) };
    }
  });
  return { ...out, availability: { motive: motive.name, places: perPlace } };
}
