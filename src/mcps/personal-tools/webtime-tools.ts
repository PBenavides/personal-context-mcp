import type { NeonClient, SqlParam, SqlRow } from '../../connections/neon.js';

/**
 * Web Time Tracker tool handlers: pure functions over an injected {@link NeonClient}, so tests
 * run against a fake. They read the Neon mirror the Chrome extension
 * (`chrome-personal-plugins/web-time-tracker`) pushes every 15 minutes:
 *
 *   devices            one per Chrome profile that syncs (name, timezone, last_sync_at)
 *   browsing_sessions  one stretch of attention on one site: started_at, ended_at, day, site,
 *                      host, url, title, duration_ms, active_ms (+ keys/clicks/scrolls/pointer)
 *   focus_sessions     one finished lock-in: name, category_name, started_at, ended_at,
 *                      duration_ms (focused time, pauses excluded), paused_ms,
 *                      distraction_count, distractions (jsonb epoch ms), status
 *   focus_categories   lock-in categories; deleted ones keep a row with deleted_at
 *
 * `day` is the extension's local day key, so day ranges filter on it directly. Times are
 * rendered in the recording device's timezone. Every query is parameterised; the only SQL
 * assembled from arguments is picked from the fixed fragment tables below.
 */

/** Default window when neither `from` nor `to` is given: the last 7 days, today included. */
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 25;
const DEFAULT_QUERY_ROWS = 200;
export const MAX_QUERY_ROWS = 2000;

export const BROWSING_GROUPS = ['site', 'day', 'hour', 'title', 'session'] as const;
export const FOCUS_GROUPS = ['category', 'day', 'hour', 'session'] as const;
export const FOCUS_STATUSES = ['completed', 'abandoned'] as const;

export type BrowsingGroup = (typeof BROWSING_GROUPS)[number];
export type FocusGroup = (typeof FOCUS_GROUPS)[number];
export type FocusStatus = (typeof FOCUS_STATUSES)[number];

export interface DayRange {
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  /** YYYY-MM-DD, inclusive; defaults to today in the home timezone. */
  to?: string;
  /** Window length when `from` is omitted (default 7). */
  days?: number;
}

/**
 * CTEs every range-bound query opens with. `home.tz` is the timezone of the most recently
 * synced device — "today" for the default window. Params: $1 from, $2 to, $3 days.
 */
const RANGE_CTE = `home as (
  select coalesce(
    (select timezone from devices where timezone is not null
      order by last_sync_at desc nulls last limit 1),
    'UTC') as tz
),
bounds as (
  select coalesce($1::date, coalesce($2::date, (now() at time zone tz)::date) - ($3::int - 1)) as from_day,
         coalesce($2::date, (now() at time zone tz)::date) as to_day,
         tz
  from home
)`;

function rangeParams(range: DayRange): SqlParam[] {
  if (range.from && range.to && range.from > range.to) {
    throw new Error(`from (${range.from}) is after to (${range.to})`);
  }
  return [range.from ?? null, range.to ?? null, range.days ?? DEFAULT_DAYS];
}

/** Milliseconds (bigint, numeric or text from Postgres) to minutes, one decimal. */
function minutes(ms: unknown): number {
  return Math.round((Number(ms) || 0) / 6000) / 10;
}

/**
 * Lock-in focus quality, the extension's own bands (`src/lib/focus.js`): distractions per
 * focused hour, < 2 = 5 stars, < 4 = 4, < 6 = 3, < 8 = 2, otherwise 1.
 */
export function focusQuality(
  durationMs: number,
  distractions: number,
): { distractions_per_hour: number | null; quality_stars: number | null } {
  if (!(durationMs > 0)) {
    return { distractions_per_hour: null, quality_stars: null };
  }
  const perHour = distractions / (durationMs / 3_600_000);
  const stars = perHour < 2 ? 5 : perHour < 4 ? 4 : perHour < 6 ? 3 : perHour < 8 ? 2 : 1;
  return { distractions_per_hour: Math.round(perHour * 10) / 10, quality_stars: stars };
}

/** Adds `minutes`, `distractions_per_hour` and `quality_stars` to a row carrying ms + distractions. */
function shapeFocusRow(row: SqlRow): SqlRow {
  const { ms, ...rest } = row;
  const durationMs = Number(ms) || 0;
  return {
    ...rest,
    minutes: minutes(durationMs),
    ...focusQuality(durationMs, Number(row.distractions) || 0),
  };
}

// ---------------------------------------------------------------------------
// webtime_overview
// ---------------------------------------------------------------------------

export async function webtimeOverview(client: NeonClient, range: DayRange): Promise<unknown> {
  const params = rangeParams(range);
  const inRange = 'day between (select from_day from bounds) and (select to_day from bounds)';
  const [[window], sites, byDay, categories, devices] = await client.read([
    {
      query: `with ${RANGE_CTE}
        select b.from_day::text as from, b.to_day::text as to, b.tz as timezone,
               coalesce(sum(s.duration_ms), 0)::float8 as ms,
               sum(s.active_ms)::float8 as active_ms,
               count(s.started_at)::int as sessions,
               count(distinct s.day)::int as days_with_browsing
        from bounds b
        left join browsing_sessions s on s.day between b.from_day and b.to_day
        group by b.from_day, b.to_day, b.tz`,
      params,
    },
    {
      query: `with ${RANGE_CTE}
        select site, sum(duration_ms)::float8 as ms, count(*)::int as sessions,
               sum(active_ms)::float8 as active_ms
        from browsing_sessions where ${inRange}
        group by site order by sum(duration_ms) desc limit 10`,
      params,
    },
    {
      query: `with ${RANGE_CTE},
        br as (select day, sum(duration_ms) as ms from browsing_sessions where ${inRange} group by day),
        fo as (select day, sum(duration_ms) as ms, count(*) as n from focus_sessions where ${inRange} group by day)
        select d.day::date::text as day,
               coalesce(br.ms, 0)::float8 as browsing_ms,
               coalesce(fo.ms, 0)::float8 as focus_ms,
               coalesce(fo.n, 0)::int as focus_sessions
        from bounds b
        cross join generate_series(b.from_day, b.to_day, interval '1 day') as d(day)
        left join br on br.day = d.day::date
        left join fo on fo.day = d.day::date
        order by d.day`,
      params,
    },
    {
      query: `with ${RANGE_CTE}
        select coalesce(category_name, '(none)') as category,
               sum(duration_ms)::float8 as ms, count(*)::int as sessions,
               sum(distraction_count)::int as distractions,
               (count(*) filter (where status = 'abandoned'))::int as abandoned
        from focus_sessions where ${inRange}
        group by 1 order by sum(duration_ms) desc`,
      params,
    },
    {
      query: `select name, timezone,
               to_char(last_sync_at at time zone coalesce(timezone, 'UTC'), 'YYYY-MM-DD HH24:MI') as last_sync,
               round(extract(epoch from now() - last_sync_at) / 60)::int as minutes_since_sync
        from devices order by last_sync_at desc nulls last`,
    },
  ]);

  const browsingMs = Number(window?.ms) || 0;
  const focusMs = categories.reduce((sum, row) => sum + (Number(row.ms) || 0), 0);
  const focusDistractions = categories.reduce((sum, row) => sum + (Number(row.distractions) || 0), 0);
  const focusSessions = categories.reduce((sum, row) => sum + (Number(row.sessions) || 0), 0);

  return {
    range: { from: window?.from, to: window?.to, timezone: window?.timezone },
    browsing: {
      minutes: minutes(browsingMs),
      engaged_minutes: window?.active_ms == null ? null : minutes(window.active_ms),
      sessions: window?.sessions ?? 0,
      days_with_data: window?.days_with_browsing ?? 0,
      top_sites: sites.map(row => ({
        site: row.site,
        minutes: minutes(row.ms),
        share: browsingMs ? Math.round((Number(row.ms) / browsingMs) * 1000) / 1000 : 0,
        sessions: row.sessions,
        engaged_minutes: row.active_ms == null ? null : minutes(row.active_ms),
      })),
    },
    focus: {
      minutes: minutes(focusMs),
      sessions: focusSessions,
      distractions: focusDistractions,
      ...focusQuality(focusMs, focusDistractions),
      by_category: categories.map(shapeFocusRow),
    },
    by_day: byDay.map(row => ({
      day: row.day,
      browsing_minutes: minutes(row.browsing_ms),
      focus_minutes: minutes(row.focus_ms),
      focus_sessions: row.focus_sessions,
    })),
    devices,
    ...(devices.length === 0
      ? { note: 'No device has synced to Neon yet — enable Neon sync in the extension.' }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// webtime_browsing
// ---------------------------------------------------------------------------

export interface BrowsingArgs extends DayRange {
  groupBy?: BrowsingGroup;
  /** Substring of the tracked site or hostname, e.g. "youtube". */
  site?: string;
  /** Substring of the page title or URL. */
  search?: string;
  limit?: number;
}

/** Local timestamp of a session column in its device's timezone. */
const localTime = (column: string): string =>
  `to_char(${column} at time zone coalesce(d.timezone, b.tz), 'YYYY-MM-DD HH24:MI')`;

const BROWSING_SELECT: Record<BrowsingGroup, { select: string; group?: string; order: string }> = {
  site: {
    select: `s.site, sum(s.duration_ms)::float8 as ms, count(*)::int as sessions,
             sum(s.active_ms)::float8 as active_ms, count(distinct s.day)::int as days`,
    group: 's.site',
    order: 'sum(s.duration_ms) desc',
  },
  day: {
    select: `s.day::text as day, sum(s.duration_ms)::float8 as ms, count(*)::int as sessions,
             sum(s.active_ms)::float8 as active_ms, count(distinct s.site)::int as sites`,
    group: 's.day',
    order: 's.day desc',
  },
  hour: {
    select: `extract(hour from s.started_at at time zone coalesce(d.timezone, b.tz))::int as hour,
             sum(s.duration_ms)::float8 as ms, count(*)::int as sessions,
             sum(s.active_ms)::float8 as active_ms`,
    group: '1',
    order: '1',
  },
  title: {
    select: `s.site, s.title, sum(s.duration_ms)::float8 as ms, count(*)::int as sessions,
             sum(s.active_ms)::float8 as active_ms,
             to_char(max(s.ended_at) at time zone b.tz, 'YYYY-MM-DD HH24:MI') as last_seen`,
    group: 's.site, s.title, b.tz',
    order: 'sum(s.duration_ms) desc',
  },
  session: {
    select: `${localTime('s.started_at')} as started, ${localTime('s.ended_at')} as ended,
             s.site, s.title, s.url, s.duration_ms::float8 as ms, s.active_ms::float8 as active_ms,
             s.keys, s.clicks, s.scrolls`,
    order: 's.started_at desc',
  },
};

export async function webtimeBrowsing(client: NeonClient, args: BrowsingArgs): Promise<unknown> {
  const groupBy = args.groupBy ?? 'site';
  const limit = args.limit ?? DEFAULT_LIMIT;
  const shape = BROWSING_SELECT[groupBy];
  // Postgres rejects a bind with more parameters than the statement uses, so the totals
  // statement gets the filters ($1–$5) and the rows statement adds the limit ($6).
  const filters = [...rangeParams(args), args.site ?? null, args.search ?? null];
  const from = `bounds b
    join browsing_sessions s on s.day between b.from_day and b.to_day
    left join devices d on d.id = s.device_id
    where ($4::text is null or s.site ilike '%' || $4 || '%' or s.host ilike '%' || $4 || '%')
      and ($5::text is null or s.title ilike '%' || $5 || '%' or s.url ilike '%' || $5 || '%')`;

  const [[window], rows] = await client.read([
    {
      query: `with ${RANGE_CTE}
        select b.from_day::text as from, b.to_day::text as to,
               (select coalesce(sum(s.duration_ms), 0)::float8 from ${from}) as ms
        from bounds b`,
      params: filters,
    },
    {
      query: `with ${RANGE_CTE}
        select ${shape.select}
        from ${from}
        ${shape.group ? `group by ${shape.group}` : ''}
        order by ${shape.order}
        limit $6::int`,
      params: [...filters, limit + 1],
    },
  ]);

  return {
    range: { from: window?.from, to: window?.to },
    group_by: groupBy,
    total_minutes: minutes(window?.ms),
    rows: rows.slice(0, limit).map(({ ms, active_ms, ...rest }) => ({
      ...rest,
      minutes: minutes(ms),
      engaged_minutes: active_ms == null ? null : minutes(active_ms),
    })),
    truncated: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------
// webtime_focus
// ---------------------------------------------------------------------------

export interface FocusArgs extends DayRange {
  groupBy?: FocusGroup;
  /** Substring of the category name. */
  category?: string;
  /** Substring of the lock-in name. */
  search?: string;
  status?: FocusStatus;
  limit?: number;
}

const FOCUS_AGGREGATES = `sum(f.duration_ms)::float8 as ms, count(*)::int as sessions,
  sum(f.distraction_count)::int as distractions,
  round(sum(f.paused_ms) / 60000.0, 1)::float8 as paused_minutes,
  round(avg(f.duration_ms) / 60000.0, 1)::float8 as avg_session_minutes,
  (count(*) filter (where f.status = 'abandoned'))::int as abandoned`;

const FOCUS_SELECT: Record<FocusGroup, { select: string; group?: string; order: string }> = {
  category: {
    select: `coalesce(f.category_name, '(none)') as category, ${FOCUS_AGGREGATES}`,
    group: '1',
    order: 'sum(f.duration_ms) desc',
  },
  day: {
    select: `f.day::text as day, ${FOCUS_AGGREGATES}`,
    group: 'f.day',
    order: 'f.day desc',
  },
  hour: {
    select: `extract(hour from f.started_at at time zone coalesce(d.timezone, b.tz))::int as hour,
             ${FOCUS_AGGREGATES}`,
    group: '1',
    order: '1',
  },
  session: {
    select: `f.id, f.name, f.category_name as category, f.status,
             ${localTime('f.started_at')} as started, ${localTime('f.ended_at')} as ended,
             f.duration_ms::float8 as ms, round(f.paused_ms / 60000.0, 1)::float8 as paused_minutes,
             f.distraction_count as distractions,
             (select coalesce(json_agg(
                to_char(to_timestamp((x #>> '{}')::numeric / 1000) at time zone coalesce(d.timezone, b.tz), 'HH24:MI')
                order by (x #>> '{}')::numeric), '[]'::json)
              from jsonb_array_elements(f.distractions) as x) as distraction_times`,
    order: 'f.started_at desc',
  },
};

export async function webtimeFocus(client: NeonClient, args: FocusArgs): Promise<unknown> {
  const groupBy = args.groupBy ?? 'category';
  const limit = args.limit ?? DEFAULT_LIMIT;
  const shape = FOCUS_SELECT[groupBy];
  const range = rangeParams(args);
  const params = [
    ...range,
    args.category ?? null,
    args.search ?? null,
    args.status ?? null,
    limit + 1,
  ];

  const [[window], rows] = await client.read([
    {
      query: `with ${RANGE_CTE}
        select b.from_day::text as from, b.to_day::text as to from bounds b`,
      params: range,
    },
    {
      query: `with ${RANGE_CTE}
        select ${shape.select}
        from bounds b
        join focus_sessions f on f.day between b.from_day and b.to_day
        left join devices d on d.id = f.device_id
        where ($4::text is null or f.category_name ilike '%' || $4 || '%')
          and ($5::text is null or f.name ilike '%' || $5 || '%')
          and ($6::text is null or f.status = $6)
        ${shape.group ? `group by ${shape.group}` : ''}
        order by ${shape.order}
        limit $7::int`,
      params,
    },
  ]);

  const shaped = rows.slice(0, limit).map(row => {
    const out = shapeFocusRow(row);
    if (groupBy === 'session') {
      // Average stretch between distractions, the extension's "focus span".
      out.avg_focus_span_minutes = minutes((Number(row.ms) || 0) / ((Number(row.distractions) || 0) + 1));
    }
    return out;
  });

  return {
    range: { from: window?.from, to: window?.to },
    group_by: groupBy,
    rows: shaped,
    truncated: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------
// webtime_query
// ---------------------------------------------------------------------------

export async function webtimeQuery(
  client: NeonClient,
  args: { sql: string; maxRows?: number },
): Promise<unknown> {
  const sql = args.sql.trim().replace(/;\s*$/, '');
  if (!sql) {
    throw new Error('sql is empty');
  }
  const maxRows = Math.min(args.maxRows ?? DEFAULT_QUERY_ROWS, MAX_QUERY_ROWS);
  const [rows] = await client.read([{ query: sql }]);
  return {
    row_count: rows.length,
    rows: rows.slice(0, maxRows),
    truncated: rows.length > maxRows,
  };
}
