import type { DoctolibClient, GeocodeHit } from '../../connections/doctolib.js';
import {
  bookingUrl,
  findEarliestAppointment,
  getAvailabilities,
  getPractitioner,
  normaliseProvider,
  searchDoctors,
} from './tools.js';

// Payload shapes follow esinecan/doctolib-mcp's recorded fixtures.
const SEARCH = {
  total: 3,
  healthcareProviders: [
    {
      firstName: 'Anna',
      name: 'Müller',
      link: '/medecin/dr-anna-mueller?ref=search&city=berlin',
      speciality: { name: 'Hausärztliche Versorgung', slug: 'hausarztlich-tatige-internist-in' },
      languages: ['de', 'en'],
      location: { city: 'Berlin', address: 'Kantstr. 12', zipcode: '10625' },
      references: { practiceId: 901 },
      matchedVisitMotive: {
        visitMotiveId: 55012,
        name: 'Akutsprechstunde',
        agendaIds: [201],
        allowNewPatients: true,
      },
      onlineBooking: { telehealth: false, agendaIds: [101, 102] },
      services: ['onlineBooking'],
    },
    {
      name: 'Schmidt',
      link: '/zahnarzt/dr-schmidt/',
      subtitle: 'Zahnmedizin',
      location: { city: 'Berlin' },
      references: { practiceId: 808 },
      matchedVisitMotive: { visitMotiveId: 66001, name: 'Erstuntersuchung', agendaIds: [301] },
      onlineBooking: {},
      services: ['onlineBooking'],
    },
    {
      firstName: 'Leerlauf',
      name: 'Praxis',
      location: { city: 'Potsdam' },
      references: {},
      matchedVisitMotive: { visitMotiveId: 77000 },
      services: [],
    },
  ],
};

const BERLIN: GeocodeHit = {
  lat: '52.5170365',
  lon: '13.3888599',
  // Nominatim order: [south, north, west, east]
  boundingbox: ['52.3382448', '52.6755087', '13.0883450', '13.7611609'],
};

interface Call {
  method: string;
  path: string;
  params?: Record<string, string | number | undefined>;
  body?: unknown;
}

function fakeClient(handler: (call: Call) => unknown): DoctolibClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    baseUrl: () => 'https://www.doctolib.de',
    async request(_country, method, path, options = {}): Promise<unknown> {
      const call = { method, path, ...options };
      calls.push(call);
      return handler(call);
    },
    async geocode(): Promise<GeocodeHit | undefined> {
      return BERLIN;
    },
  };
}

describe('normaliseProvider', () => {
  it('extracts the availability triple, preferring onlineBooking agendas', () => {
    const p = normaliseProvider(SEARCH.healthcareProviders[0], 'https://www.doctolib.de');
    expect(p).toMatchObject({
      name: 'Anna Müller',
      profile_slug: 'dr-anna-mueller',
      profile_url: 'https://www.doctolib.de/medecin/dr-anna-mueller?ref=search&city=berlin',
      speciality: 'Hausärztliche Versorgung',
      visit_motive_id: 55012,
      agenda_ids: [101, 102],
      practice_id: 901,
      bookable_online: true,
      accepts_new_patients: true,
    });
  });

  it('falls back to motive agendas, subtitle and a trailing-slash link', () => {
    const p = normaliseProvider(SEARCH.healthcareProviders[1], 'https://www.doctolib.de');
    expect(p.agenda_ids).toEqual([301]);
    expect(p.speciality).toBe('Zahnmedizin');
    expect(p.profile_slug).toBe('dr-schmidt');
  });
});

describe('searchDoctors', () => {
  it('sends the geocoded viewport with corners mapped from Nominatim order', async () => {
    const client = fakeClient(() => SEARCH);
    await searchDoctors(client, { specialty: 'zahnarzt', city: 'Berlin', country: 'de', telehealth: false });
    const body = client.calls[0].body as {
      keyword: string;
      location: { place: { viewport: unknown } };
      filters: unknown;
    };
    expect(body.keyword).toBe('zahnarzt');
    expect(body.location.place.viewport).toEqual({
      northeast: { lat: 52.6755087, lng: 13.7611609 },
      southwest: { lat: 52.3382448, lng: 13.088345 },
    });
    // telehealth:false is meaningful and must be sent; unset filters are omitted.
    expect(body.filters).toEqual({ telehealth: false });
    expect(client.calls[0].params).toEqual({ page: 0 });
  });
});

describe('searchDoctors zero hits', () => {
  it('adds a hint, because Doctolib answers an unknown slug with an empty page, not an error', async () => {
    const out = await searchDoctors(
      fakeClient(() => ({ total: 0, healthcareProviders: [] })),
      { specialty: 'zahnarzt', city: 'Berlin', country: 'de' },
    );
    expect(out.hint).toMatch(/list_specialties/);
  });
});

describe('getAvailabilities', () => {
  it('walks long horizons in 15-day windows and floors the trailing limit at 2', async () => {
    const client = fakeClient(() => ({ total: 0, availabilities: [] }));
    await getAvailabilities(client, {
      visitMotiveId: 1,
      agendaIds: [10, 11],
      practiceId: 2,
      startDate: '2026-08-05',
      days: 16,
      country: 'de',
    });
    expect(client.calls.map((c) => [c.params?.start_date, c.params?.limit])).toEqual([
      ['2026-08-05', 15],
      ['2026-08-20', 2],
    ]);
    expect(client.calls[0].params?.agenda_ids).toBe('10-11');
  });

  it('keeps only days with slots and passes not_opened_availability through', async () => {
    const client = fakeClient(() => ({
      total: 1,
      reason: 'not_opened_availability',
      availabilities: [
        { date: '2026-08-10', slots: [] },
        { date: '2026-08-11', slots: [{ start_date: '2026-08-11T08:15:00.000+02:00' }] },
      ],
    }));
    const out = await getAvailabilities(client, {
      visitMotiveId: 1,
      agendaIds: [10],
      practiceId: 2,
      startDate: '2026-08-10',
      country: 'de',
    });
    expect(out.days_with_slots.map((d) => d.date)).toEqual(['2026-08-11']);
    expect(out.first_slot).toBe('2026-08-11T08:15:00.000+02:00');
    expect(out.reason).toBe('not_opened_availability');
  });
});

describe('findEarliestAppointment', () => {
  it('probes only complete triples and sorts by earliest slot', async () => {
    const slots: Record<number, string> = {
      901: '2026-08-12T09:00:00.000+02:00',
      808: '2026-08-10T15:00:00.000+02:00',
    };
    const client = fakeClient((call) => {
      if (call.path.includes('/hcp/search')) {
        return SEARCH;
      }
      const at = slots[Number(call.params?.practice_ids)];
      return { total: 1, availabilities: [{ date: at.slice(0, 10), slots: [at] }] };
    });
    const out = await findEarliestAppointment(client, { specialty: 'x', city: 'Berlin', country: 'de' });
    expect(out.searched).toBe(2); // the third hit has no agendas/practice
    expect((out.results as { practice_id: number }[]).map((r) => r.practice_id)).toEqual([808, 901]);
  });

  it('counts a failed probe instead of failing the search', async () => {
    const client = fakeClient((call) => {
      if (call.path.includes('/hcp/search')) {
        return SEARCH;
      }
      throw new Error('HTTP 500');
    });
    const out = await findEarliestAppointment(client, { specialty: 'x', city: 'Berlin', country: 'de' });
    expect(out).toMatchObject({ searched: 2, with_availability: 0, errors: 2 });
  });
});

describe('getPractitioner / bookingUrl', () => {
  const INFO = {
    data: {
      profile: {
        id: 554433,
        name_with_title: 'Dr. Anna Müller',
        subtitle: 'Allgemeinmedizin',
        redirect_url: '/medecin/dr-anna-mueller',
      },
      visit_motives: [{ id: 55012, name: 'Akutsprechstunde', telehealth: false, allow_new_patients: true }],
      agendas: [{ id: 101, practice_id: 901, visit_motive_ids: [55012] }],
      places: [
        { id: 901, name: 'Praxis Kantstraße', address: 'Kantstr. 12', city: 'Berlin', practice_ids: [901] },
      ],
    },
  };

  it('shapes the slot-selection info payload', async () => {
    const client = fakeClient(() => INFO);
    const p = await getPractitioner(client, { profileSlug: 'dr-anna-mueller', country: 'de' });
    expect(client.calls[0].params).toEqual({ profile_slug: 'dr-anna-mueller', locale: 'de' });
    expect(p).toMatchObject({ profile_id: 554433, name: 'Dr. Anna Müller', visit_motives: [{ id: 55012 }] });
  });

  it('appends the slug when redirect_url is only the specialty/city listing', async () => {
    const listing = {
      data: { ...INFO.data, profile: { ...INFO.data.profile, redirect_url: '/zahnmedizin/berlin' } },
    };
    const out = await bookingUrl(
      fakeClient(() => listing),
      { profileSlug: 'dr-anna-mueller', country: 'de' },
    );
    expect(out.booking_url).toBe('https://www.doctolib.de/zahnmedizin/berlin/dr-anna-mueller');
  });

  it('returns the profile URL as the booking link', async () => {
    const out = await bookingUrl(
      fakeClient(() => INFO),
      { profileSlug: 'dr-anna-mueller', country: 'de' },
    );
    expect(out.booking_url).toBe('https://www.doctolib.de/medecin/dr-anna-mueller');
  });
});
