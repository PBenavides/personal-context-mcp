import type { NeonClient, SqlRow, SqlStatement } from '../../connections/neon.js';
import {
  focusQuality,
  webtimeBrowsing,
  webtimeFocus,
  webtimeOverview,
  webtimeQuery,
} from './webtime-tools.js';

/** Fake Neon client: returns canned result sets in order and records each batch. */
function fakeNeon(results: SqlRow[][]): NeonClient & { batches: SqlStatement[][] } {
  const batches: SqlStatement[][] = [];
  return {
    batches,
    async read(statements) {
      batches.push(statements);
      return statements.map((_, i) => results[i] ?? []);
    },
  };
}

/** Postgres only binds as many parameters as the statement references. */
function expectParamsMatchPlaceholders(statements: SqlStatement[]): void {
  for (const { query, params = [] } of statements) {
    const used = Math.max(0, ...[...query.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    expect(params).toHaveLength(used);
  }
}

describe('focusQuality', () => {
  it.each([
    [3_600_000, 0, 5, 0],
    [3_600_000, 2, 4, 2],
    [1_800_000, 2, 3, 4],
    [3_600_000, 7, 2, 7],
    [3_600_000, 8, 1, 8],
  ])('%i ms with %i distractions -> %i stars', (ms, distractions, stars, perHour) => {
    expect(focusQuality(ms, distractions)).toEqual({
      distractions_per_hour: perHour,
      quality_stars: stars,
    });
  });

  it('has no quality for zero focused time', () => {
    expect(focusQuality(0, 3)).toEqual({ distractions_per_hour: null, quality_stars: null });
  });
});

describe('webtimeOverview', () => {
  it('shapes totals, shares and focus quality', async () => {
    const client = fakeNeon([
      [{ from: '2026-11-12', to: '2026-11-18', timezone: 'Europe/Berlin', ms: 7_200_000, active_ms: 3_600_000, sessions: 9, days_with_browsing: 3 }],
      [
        { site: 'youtube.com', ms: 5_400_000, sessions: 6, active_ms: null },
        { site: 'github.com', ms: 1_800_000, sessions: 3, active_ms: '900000' },
      ],
      [{ day: '2026-11-18', browsing_ms: 7_200_000, focus_ms: 5_400_000, focus_sessions: 2 }],
      [
        { category: 'Programming', ms: 3_600_000, sessions: 1, distractions: 1, abandoned: 0 },
        { category: 'Reading', ms: 1_800_000, sessions: 1, distractions: 2, abandoned: 1 },
      ],
      [{ name: 'MacBook', timezone: 'Europe/Berlin', last_sync: '2026-11-18 21:00', minutes_since_sync: 4 }],
    ]);

    const result = (await webtimeOverview(client, {})) as Record<string, unknown>;

    expect(result.range).toEqual({ from: '2026-11-12', to: '2026-11-18', timezone: 'Europe/Berlin' });
    expect(result.browsing).toEqual({
      minutes: 120,
      engaged_minutes: 60,
      sessions: 9,
      days_with_data: 3,
      top_sites: [
        { site: 'youtube.com', minutes: 90, share: 0.75, sessions: 6, engaged_minutes: null },
        { site: 'github.com', minutes: 30, share: 0.25, sessions: 3, engaged_minutes: 15 },
      ],
    });
    // 3 distractions over 1.5 focused hours = 2/h -> 4 stars.
    expect(result.focus).toMatchObject({
      minutes: 90,
      sessions: 2,
      distractions: 3,
      distractions_per_hour: 2,
      quality_stars: 4,
    });
    const { by_category: byCategory } = result.focus as { by_category: unknown[] };
    expect(byCategory[1]).toEqual({
      category: 'Reading',
      sessions: 1,
      distractions: 2,
      abandoned: 1,
      minutes: 30,
      distractions_per_hour: 4,
      quality_stars: 3,
    });
    expect(result.by_day).toEqual([
      { day: '2026-11-18', browsing_minutes: 120, focus_minutes: 90, focus_sessions: 2 },
    ]);
    expect(result.note).toBeUndefined();

    const [batch] = client.batches;
    expect(batch).toHaveLength(5);
    expect(batch[0].params).toEqual([null, null, 7]);
    expectParamsMatchPlaceholders(batch);
  });

  it('notes when nothing has synced yet', async () => {
    const result = (await webtimeOverview(fakeNeon([[{ ms: 0, sessions: 0 }]]), {})) as Record<string, unknown>;
    expect(result.browsing).toMatchObject({ minutes: 0 });
    expect(result.focus).toMatchObject({ quality_stars: null });
    expect(result.note).toMatch(/No device has synced/);
  });

  it('passes an explicit range and rejects an inverted one', async () => {
    const client = fakeNeon([]);
    await webtimeOverview(client, { from: '2026-11-01', to: '2026-11-30' });
    expect(client.batches[0][0].params).toEqual(['2026-11-01', '2026-11-30', 7]);
    await expect(webtimeOverview(client, { from: '2026-11-30', to: '2026-11-01' })).rejects.toThrow(/after/);
  });
});

describe('webtimeBrowsing', () => {
  it('groups by site by default and converts to minutes', async () => {
    const client = fakeNeon([
      [{ from: '2026-11-12', to: '2026-11-18', ms: 600_000 }],
      [{ site: 'youtube.com', ms: 600_000, sessions: 2, active_ms: null, days: 1 }],
    ]);
    const result = await webtimeBrowsing(client, { site: 'youtube' });
    expect(result).toEqual({
      range: { from: '2026-11-12', to: '2026-11-18' },
      group_by: 'site',
      total_minutes: 10,
      rows: [{ site: 'youtube.com', sessions: 2, days: 1, minutes: 10, engaged_minutes: null }],
      truncated: false,
    });
    const [totals, rows] = client.batches[0];
    expect(totals.params).toEqual([null, null, 7, 'youtube', null]);
    expect(rows.params).toEqual([null, null, 7, 'youtube', null, 26]);
    expect(rows.query).toMatch(/group by s\.site/);
    expectParamsMatchPlaceholders(client.batches[0]);
  });

  it('lists raw sessions without grouping and flags truncation', async () => {
    const sessions = [1, 2, 3].map(i => ({ started: `2026-11-18 10:0${i}`, site: 'a.com', ms: 60_000, active_ms: 30_000 }));
    const client = fakeNeon([[{ ms: 180_000 }], sessions]);
    const result = await webtimeBrowsing(client, { groupBy: 'session', limit: 2, search: 'docs' });
    expect(result).toMatchObject({
      rows: [{ started: '2026-11-18 10:01', site: 'a.com', minutes: 1, engaged_minutes: 0.5 }, {}],
      truncated: true,
    });
    const rowsQuery = client.batches[0][1];
    expect(rowsQuery.query).not.toMatch(/group by/);
    expect(rowsQuery.params?.[4]).toBe('docs');
    expect(rowsQuery.params?.[5]).toBe(3);
  });

  it.each(['day', 'hour', 'title'] as const)('builds a %s grouping', async groupBy => {
    const client = fakeNeon([]);
    expect(await webtimeBrowsing(client, { groupBy })).toMatchObject({ group_by: groupBy });
    expect(client.batches[0][1].query).toMatch(/group by/);
    expectParamsMatchPlaceholders(client.batches[0]);
  });
});

describe('webtimeFocus', () => {
  it('adds quality and focus span to each lock-in', async () => {
    const client = fakeNeon([
      [{ from: '2026-11-18', to: '2026-11-18' }],
      [
        {
          id: 'f1',
          name: 'Chapter 5',
          category: 'Reading',
          status: 'completed',
          ms: 3_000_000,
          paused_minutes: 2,
          distractions: 1,
          distraction_times: ['10:20'],
        },
      ],
    ]);
    const result = (await webtimeFocus(client, { groupBy: 'session', days: 1, status: 'completed' })) as {
      rows: unknown[];
    };
    expect(result.rows[0]).toEqual({
      id: 'f1',
      name: 'Chapter 5',
      category: 'Reading',
      status: 'completed',
      paused_minutes: 2,
      distractions: 1,
      distraction_times: ['10:20'],
      minutes: 50,
      distractions_per_hour: 1.2,
      quality_stars: 5,
      avg_focus_span_minutes: 25,
    });
    const [range, rows] = client.batches[0];
    expect(range.params).toEqual([null, null, 1]);
    expect(rows.params).toEqual([null, null, 1, null, null, 'completed', 26]);
    expectParamsMatchPlaceholders(client.batches[0]);
  });

  it.each(['category', 'day', 'hour'] as const)('aggregates by %s', async groupBy => {
    const client = fakeNeon([[{}], [{ category: 'Programming', ms: 3_600_000, sessions: 2, distractions: 4 }]]);
    const result = (await webtimeFocus(client, { groupBy, category: 'prog' })) as {
      rows: Record<string, unknown>[];
    };
    expect(result.rows[0]).toMatchObject({ minutes: 60, quality_stars: 3 });
    expect(result.rows[0].avg_focus_span_minutes).toBeUndefined();
    expect(client.batches[0][1].query).toMatch(/group by/);
    expectParamsMatchPlaceholders(client.batches[0]);
  });
});

describe('webtimeQuery', () => {
  it('runs the statement as given, minus a trailing semicolon, and caps rows', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ i }));
    const client = fakeNeon([rows]);
    const result = await webtimeQuery(client, { sql: '  select * from devices;  ', maxRows: 3 });
    expect(client.batches[0]).toEqual([{ query: 'select * from devices' }]);
    expect(result).toEqual({ row_count: 5, rows: rows.slice(0, 3), truncated: true });
  });

  it('refuses an empty statement', async () => {
    await expect(webtimeQuery(fakeNeon([]), { sql: ' ; ' })).rejects.toThrow(/empty/);
  });
});
