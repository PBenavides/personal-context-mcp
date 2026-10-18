import type { DoctolibClient, GeocodeHit } from '../../connections/doctolib.js';
import {
  doctolibPractitioner,
  doctolibSearch,
  formatSlot,
  getAvailabilities,
  normaliseProvider,
  searchDoctors,
  slotsByDay,
} from './doctolib-tools.js';

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
    // The verified slugs ride along, so recovering costs no extra tool call.
    expect(out.hint).toMatch(/zahnmedizin \(dentist\)/);
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

describe('slot formatting', () => {
  it('keeps the practice-local date and time', () => {
    expect(formatSlot('2026-10-17T18:45:00.000+02:00')).toBe('2026-10-17 18:45');
  });

  it('groups times by day, capped', () => {
    const days = [
      {
        date: '2026-10-17',
        slots: ['2026-10-17T09:00:00.000+02:00', { start_date: '2026-10-17T09:30:00.000+02:00' }],
      },
      { date: '2026-10-18', slots: ['2026-10-18T10:00:00.000+02:00'] },
    ];
    expect(slotsByDay(days, 1, 1)).toEqual({ '2026-10-17': ['09:00'] });
    expect(slotsByDay(days, 5, 5)).toEqual({ '2026-10-17': ['09:00', '09:30'], '2026-10-18': ['10:00'] });
  });
});

describe('doctolibSearch', () => {
  const slots: Record<number, string> = {
    901: '2026-08-12T09:00:00.000+02:00',
    808: '2026-08-10T15:00:00.000+02:00',
  };
  const withSlots = (call: Call): unknown => {
    if (call.path.includes('/hcp/search')) {
      return SEARCH;
    }
    const at = slots[Number(call.params?.practice_ids)];
    return { total: 1, availabilities: [{ date: at.slice(0, 10), slots: [at] }] };
  };

  it('probes only complete triples, sorts by earliest, and returns compact results', async () => {
    const out = await doctolibSearch(fakeClient(withSlots), {
      specialty: 'x',
      city: 'Berlin',
      country: 'de',
    });
    expect(out).toMatchObject({ total_matching: 3, checked: 2, with_availability: 2 });
    const results = out.results as Record<string, unknown>[];
    expect(results.map((r) => r.name)).toEqual(['Schmidt', 'Anna Müller']);
    expect(results[0]).toMatchObject({
      next_slot: '2026-08-10 15:00',
      slots: { '2026-08-10': ['15:00'] },
      profile_slug: 'dr-schmidt',
      motive_id: 66001,
      booking_url: 'https://www.doctolib.de/zahnarzt/dr-schmidt/',
    });
    // Internal ids the caller never passes back are not exposed; unknown fields are dropped.
    expect(results[0]).not.toHaveProperty('agenda_ids');
    expect(results[0]).not.toHaveProperty('practice_id');
    expect(results[0]).not.toHaveProperty('languages');
  });

  it('availability: false is a plain list with no slot calls', async () => {
    const client = fakeClient(withSlots);
    const out = await doctolibSearch(client, {
      specialty: 'x',
      city: 'Berlin',
      country: 'de',
      availability: false,
    });
    expect(client.calls).toHaveLength(1);
    expect((out.results as unknown[]).length).toBe(3);
    expect(out).not.toHaveProperty('checked');
  });

  it('counts a failed probe instead of failing the search', async () => {
    const client = fakeClient((call) => {
      if (call.path.includes('/hcp/search')) {
        return SEARCH;
      }
      throw new Error('HTTP 500');
    });
    const out = await doctolibSearch(client, { specialty: 'x', city: 'Berlin', country: 'de' });
    expect(out).toMatchObject({ checked: 2, with_availability: 0, probe_errors: 2, results: [] });
  });
});

describe('doctolibPractitioner', () => {
  const INFO = {
    data: {
      profile: {
        id: 554433,
        name_with_title: 'Dr. Anna Müller',
        subtitle: 'Allgemeinmedizin',
        redirect_url: '/medecin/dr-anna-mueller',
      },
      visit_motives: [
        { id: 55012, name: 'Akutsprechstunde', telehealth: false, allow_new_patients: true },
        { id: 55013, name: 'Vorsorgeuntersuchung', telehealth: false, allow_new_patients: true },
      ],
      agendas: [
        { id: 101, practice_id: 901, visit_motive_ids: [55012, 55013] },
        { id: 301, practice_id: 901, visit_motive_ids: [55012] },
        { id: 401, practice_id: 902, visit_motive_ids: [55012] },
      ],
      places: [
        { id: 901, name: 'Praxis Kantstraße', address: 'Kantstr. 12', city: 'Berlin', practice_ids: [901] },
        { id: 902, name: 'Filiale', address: 'Wilmersdorfer Str. 50', city: 'Berlin', practice_ids: [902] },
      ],
    },
  };
  const client = (): ReturnType<typeof fakeClient> =>
    fakeClient((call) =>
      call.path.includes('info.json')
        ? INFO
        : {
            total: 1,
            availabilities: [
              {
                date: '2026-08-11',
                slots: [`2026-08-11T0${call.params?.practice_ids === 901 ? 8 : 9}:15:00.000+02:00`],
              },
            ],
          },
    );

  it('returns profile, motives, places and the booking link, with no slot calls', async () => {
    const c = client();
    const out = await doctolibPractitioner(c, { profileSlug: 'dr-anna-mueller', country: 'de' });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].params).toEqual({ profile_slug: 'dr-anna-mueller', locale: 'de' });
    expect(out).toMatchObject({
      name: 'Dr. Anna Müller',
      booking_url: 'https://www.doctolib.de/medecin/dr-anna-mueller',
      motives: [{ id: 55012, name: 'Akutsprechstunde', new_patients: true }, { id: 55013 }],
      places: [{ name: 'Praxis Kantstraße' }, { name: 'Filiale' }],
    });
    expect(out).not.toHaveProperty('availability');
  });

  it('derives agendas per practice from the motive and checks each place', async () => {
    const c = client();
    const out = await doctolibPractitioner(c, {
      profileSlug: 'dr-anna-mueller',
      country: 'de',
      visitMotiveId: 55012,
      startDate: '2026-08-11',
      days: 5,
    });
    const slotCalls = c.calls.filter((x) => x.path === '/availabilities.json');
    expect(slotCalls.map((x) => [x.params?.practice_ids, x.params?.agenda_ids, x.params?.limit])).toEqual([
      [901, '101-301', 5],
      [902, '401', 5],
    ]);
    expect(out.availability).toEqual({
      motive: 'Akutsprechstunde',
      places: [
        {
          place: 'Praxis Kantstraße',
          next_slot: '2026-08-11 08:15',
          slots_in_window: 1,
          slots: { '2026-08-11': ['08:15'] },
        },
        {
          place: 'Filiale',
          next_slot: '2026-08-11 09:15',
          slots_in_window: 1,
          slots: { '2026-08-11': ['09:15'] },
        },
      ],
    });
  });

  it('names the offered motives when asked for one the profile does not have', async () => {
    await expect(
      doctolibPractitioner(client(), { profileSlug: 'dr-anna-mueller', country: 'de', visitMotiveId: 1 }),
    ).rejects.toThrow(/offered: 55012 \(Akutsprechstunde\), 55013/);
  });

  it('falls back to /profiles/<slug> for a practice with no redirect_url', async () => {
    const practice = { data: { ...INFO.data, profile: { ...INFO.data.profile, redirect_url: '' } } };
    const out = await doctolibPractitioner(
      fakeClient(() => practice),
      { profileSlug: 'zahnzentrum-hohenschoenhausen-berlin', country: 'de' },
    );
    expect(out.booking_url).toBe('https://www.doctolib.de/profiles/zahnzentrum-hohenschoenhausen-berlin');
  });

  it('appends the slug when redirect_url is only the specialty/city listing', async () => {
    const listing = {
      data: { ...INFO.data, profile: { ...INFO.data.profile, redirect_url: '/zahnmedizin/berlin' } },
    };
    const out = await doctolibPractitioner(
      fakeClient(() => listing),
      { profileSlug: 'dr-anna-mueller', country: 'de' },
    );
    expect(out.booking_url).toBe('https://www.doctolib.de/zahnmedizin/berlin/dr-anna-mueller');
  });
});
