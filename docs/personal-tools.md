# personal-tools MCP (`/personal-tools`)

The **action layer** of the host: tools that hit Pablo's personal SaaS accounts
(YNAB budgeting, Hevy workout tracking, Google Calendar), ported to TypeScript
from the Python/FastMCP server in
[`my-mcp-platform`](../../my-mcp-platform/) and mounted as a second MCP route
alongside `/personal-context`.

```
client ──POST /personal-tools (Bearer token)──► ynab_* (8) / hevy_* (7) / gcal_* (7)
                                                     │           │            │
                                          api.ynab.com/v1  api.hevyapp.com  googleapis.com/calendar/v3
                                          (YNAB_TOKEN)     (HEVY_API_KEY)   (OAuth refresh token)
```

## Portability verdict (the "will this only work in Python?" question)

**Nothing in the ported surface is Python-only.** The `my-mcp-platform`
implementations are thin wrappers over plain REST APIs using stdlib `urllib` —
no Python-specific SDKs:

| Integration | Auth | Portable to JS? | Status |
|---|---|---|---|
| YNAB | Static bearer token (`YNAB_TOKEN`) | ✅ trivially — plain REST | **Reshaped Sept 2026** (8 tools: 5 reads, 3 writes) |
| Hevy | Static API key (`api-key` header, `HEVY_API_KEY`) | ✅ trivially — plain REST | **Ported** (7 tools: 1 aggregation, 3 reads, 3 writes) |
| Google Calendar | Google OAuth refresh token + client id/secret | ✅ ported — plain REST + one refresh-token exchange | **Ported** (7 tools) |
| Google Sheets | Same Google OAuth token flow | ✅ possible, needs token plumbing | **Skipped** (see below) |
| Auth0 OAuth server (DCR, callback, scopes) | — | n/a | **Skipped by design** — this host uses its static bearer + Tailscale model instead |

**Why Google Sheets stays skipped:** no current tool need for it; the plumbing
below (minted refresh token → SSM SecureString → `fetch` refresh grant) is
identical to what Calendar now uses, so porting it later is mechanical.

**How Google Calendar's auth works here** (see `src/connections/google-calendar.ts`):
unlike YNAB/Hevy's static bearer, Google needs a *user* OAuth refresh token —
minted once via an interactive browser flow, same as the Python
`setup_oauth.py` — plus the OAuth client id/secret. The connection exchanges
the refresh token for a short-lived access token on first use
(`POST https://oauth2.googleapis.com/token`, `grant_type=refresh_token`) and
caches it in memory until it's near expiry. No Google SDK required — the
Python code avoided one for everything but auth, and the JS port avoids it
entirely (the refresh grant is one `fetch` POST; every Calendar call after
that is plain authenticated REST).

## Tool surface

Design goal: fewer, intent-level tools instead of the 17-tool 1:1 YNAB mapping
— filters became parameters, single-get folded into list tools, and the three
report tools merged behind a `kind` enum. The September 2026 YNAB reshape went
further: reads are pre-shaped for the questions a scheduled/hook agent asks,
and the write surface centres on assigning money, not logging transactions. Handlers live in
`src/mcps/personal-tools/tools.ts` (unit-tested against fake clients);
registration in `src/mcps/personal-tools/index.ts`.

### YNAB (`ynab_*`)

Reshaped 2026-09-13 for agents that run scheduled or on a hook (transaction
triage, weekly savings steering) and for the **one-month-ahead method** —
income received this month is assigned into next month's categories until
Ready to Assign is 0. Design record:
`docs/feat_requirements/YNAB_TOOLS_REFORMAT_SEP_13TH.md`. Conventions, enforced
by the pure `ynab-payloads.ts` module:

- **Currency units everywhere.** Reads divide milliunits by 1000; writes accept
  `250.5`, `"$250.50"`, or `"250,50 EUR"` and convert internally. Outflows are
  negative. Milliunits never reach the caller.
- **Names are first-class ids**: `category` / `account` / `payee` params take a
  name or a uuid; ambiguous names are refused with the candidates listed.
- **Months** accept `current` (default), `next`, `YYYY-MM`, or `YYYY-MM-01` —
  `next` is the one-month-ahead target.
- All tools default to the **last-used budget**. Endpoints use YNAB's
  `/plans/…` paths (the API's v1.79.0 rename of budgets); the `budget_id`
  param keeps the familiar name.

| Tool | Parameters | Purpose |
|---|---|---|
| `ynab_overview` | `budget_id?`, `month?` | **The first call for budget health.** Ready to Assign for this and next month (once assigned ahead, the future-most month is authoritative), age of money, month totals, next month's funding progress vs targets, overspent categories, bills due within 30 days, derived alerts. 3 parallel GETs. |
| `ynab_transactions` | `budget_id?`, `transaction_id?`, `account?`, `category?`, `payee?`, `since_date?`, `until_date?`, `type?`, `limit?` (30), `verbose?` | One query tool for all transaction access, newest first. Scope precedence: transaction > account > category > payee > whole budget (`since_date` then required). |
| `ynab_categories` | `budget_id?`, `category?`, `month?`, `include_hidden?` | Grouped compact list (assigned/activity/available + target progress), or one category's full target detail. |
| `ynab_report` | `kind` (`net_worth` \| `monthly_summary` \| `full`), `budget_id?`, `month?`, `months_back?` | Aggregated reports. |
| `ynab_lookup` | `entity` (`budgets` \| `accounts` \| `payees` \| `scheduled`), `budget_id?`, `id?`, `include_closed?` | Compact utility listings — the ids and names the other tools consume. |
| `ynab_assign` | `assignments[]` (each `category` + exactly one of `set` \| `adjust`), `month?`, `budget_id?`, `dry_run?` | **The budgeting write.** Set/adjust assigned amounts for a month in one call; a move is one category down + another up together; `month: "next"` is the month-ahead move. |
| `ynab_write_transaction` | `transaction_id?`, `delete?`, `scheduled?`, `account?`, `date?`, `amount?`, `payee?`, `category?`, `memo?`, `cleared?`, `approved?`, `flag_color?`, `import_id?`, `frequency?`, `splits?`, `budget_id?`, `dry_run?` | Create/update/delete; the id decides the verb. A `frequency` or future date routes to the scheduled-transaction endpoints. |
| `ynab_write_category` | `category?`, `name?`, `group?`, `note?`, `target_amount?`, `target_date?`, `target_frequency?`, `remove_target?`, `new_group?`, `rename_group_to?`, `budget_id?`, `dry_run?` | The "priorities changed" write: create/rename/move categories, manage targets, create/rename groups. |

#### Writing

Every write takes `dry_run`, and it runs the **entire** build path — name
resolution, amount parsing, validation — short-circuiting only the mutating
call, so the returned method/endpoint/payload is a real rehearsal and the
proposal artifact an agent hands a human before committing. `ynab_assign`
additionally previews before→after per category and the projected Ready to
Assign. API impossibilities are refused with the reason named, never hidden:
no deleting categories/accounts/payees, no editing splits after creation
(delete + recreate), no split scheduled transactions, no creating whole
budgets.

Mapping from the previous (2026-07) surface: `ynab_budgets` / `ynab_accounts`
/ `ynab_payees` / `ynab_scheduled` → `ynab_lookup(entity=…)`;
`ynab_create_transaction` → `ynab_write_transaction`. New: `ynab_overview`,
`ynab_assign`, `ynab_write_category`. The Python-surface mapping recorded in
earlier versions of this doc is now two generations back — see git history.

### Hevy (`hevy_*`)

Hevy models two different things and so do these tools: a **workout** is a
session that happened, a **routine** is a reusable plan.

| Tool | Parameters | Purpose |
|---|---|---|
| `hevy_recent_activity` | `days?` (default 4), `type?`, `depth?`, `specific?` | Recent training grouped by muscle group → day, plus each session's `workout_id` and duration. Warmup sets excluded. |
| `hevy_search_exercise_catalog` | `query?`, `muscle_group?`, `limit?` (20) | The exercise catalog by name and/or muscle group → `exercise_template_id`. The entry point for every write. |
| `hevy_get_workout` | `workout_id` | One logged workout with all exercises and sets. |
| `hevy_body_measurements` | `date?`, `days?`, `limit?` (10) | Logged measurements, newest first. Nulls omitted. |
| `hevy_calculate_burnt_calories` | `workout_id`, `weight_kg?`, `fat_percent?`, `lean_mass_kg?` | Estimated energy cost of one workout. Rough — see below. |
| `hevy_routines` | `routine_id?` | All routines, or one. |
| `hevy_write_routine` | `routine_id?`, `title?`, `exercises?`, `notes?`, `folder_name?`, `create_folder?`, `exercise_mode?`, `dry_run?` | Create a plan; updates when `routine_id` is passed. |

Create and update are one tool per entity rather than two, consistent with how
the YNAB surface was consolidated: the presence of an id decides the verb.

#### Estimating calories (`hevy_calculate_burnt_calories`)

The model lives in `hevy-energy.ts` — pure, no I/O, unit-tested directly. It sums
`resting_kcal_per_minute × MET × minutes` over time segments, with three
departures from the textbook MET formula:

1. **Resting rate is measured, not assumed.** The MET convention fixes 1 MET at
   3.5 mL O₂/kg/min of *total* mass, which overestimates for anyone carrying fat.
   Katch-McArdle (`370 + 21.6 × lean_mass_kg`) uses lean mass instead. At 80 kg
   and 18 % fat that is 1.24 vs 1.40 kcal/min — a ~13 % difference on every
   session. Mifflin-St Jeor is deliberately absent: it needs age/sex/height, none
   of which the Hevy API exposes.
2. **Rest is not lifting.** Session duration is mostly rest, so time is split
   into active (`duration_seconds`, else `reps × 3s`) and recovery (1.8 MET).
   Charging the whole session at a lifting MET is the biggest error in naive
   estimates.
3. **Muscle size scales the cost.** Each exercise's MET is multiplied by the
   muscle it recruits — `MUSCLE_MASS_WEIGHTS[primary] + 0.5 × Σ secondary`,
   normalized so a compound push is 1.0 and clamped to [0.6, 1.6]. Squats outrank
   presses outrank curls.

Cardio takes a different path: pace comes from `distance_meters` /
`duration_seconds`, and the ACSM walking/running equations turn it into a MET.

Everything is swappable via the `EnergyModel` interface — replace `metForSet` or
`muscleFactor` without touching the time accounting (see the last test in
`hevy-energy.test.ts`).

Degradation ladder for the resting rate, reported as `basis.resting_basis`:

| Available | Basis |
|---|---|
| `lean_mass_kg` | `katch_mcardle_measured_lean_mass` |
| `weight_kg` + `fat_percent` | `katch_mcardle_derived_lean_mass` |
| `weight_kg` only | `met_convention_total_weight` — warns |
| nothing | throws rather than inventing a body mass |

**Accuracy.** ±20-30 % at best against indirect calorimetry, and resistance
training is the weakest case. `accuracy_note` is attached to every result and
`warnings[]` carries anything odd — missing body composition, a measurement much
older than the workout, sets with neither reps nor duration, an unknown template,
a duration that contradicts the set data, or an implausible kcal/min that means
the inputs are wrong. Both are meant to be surfaced with the number, not stripped.

One deliberate inconsistency: **warmup sets are counted here**, unlike every
other Hevy aggregation in this file. The body does not honour our accounting
convention.

#### Reading recent training

`hevy_recent_activity` is the merge of what used to be two tools —
`hevy_recent_activity` (session totals) and `hevy_activity_by_muscle` (muscle
breakdown). Answering "have I trained triceps this week, and how hard?" took a
call to each plus the caller's own date arithmetic; it is now one call, because
the breakdown is keyed **by muscle group and then by day**:

```jsonc
{
  "period_days": 4, "type": "all", "depth": 0,
  "total_workouts": 2, "total_working_sets": 21, "total_volume_kg": 9557,
  "sessions": [
    {"workout_id": "b459…", "title": "Push", "date": "2026-08-04",
     "duration_minutes": 63.5, "working_sets": 21, "volume_kg": 9557}
  ],
  "muscle_groups": {
    "triceps": {
      "2026-08-04": {
        "total_sets": 20, "total_volume_kg": 9557, "as_primary": 16, "as_secondary": 4,
        "exercises_ids": {"Bench Press (Barbell)": "79D0BB3A"}
      }
    }
  }
}
```

- **`type`** — `all` (default), `muscles` (everything except cardio), or
  `cardio`. **`specific`** narrows to a single group and implies its `type`, so
  `specific: "triceps"` alone is enough.
- **`depth: 1`** replaces `exercises_ids` with `exercises_text` — each exercise's
  sets in words, e.g. `"4 sets of 10 repetitions each with min of 15kg, max of
  20kg."`, and duration/distance instead for cardio. It costs a line per
  exercise, so it is refused unless the scope is narrowed (not `type: "all"`)
  and `days <= 4`.
- Groups are ordered by volume, days newest-first. Days are UTC calendar days.
- `sessions` and the top-level totals stay **window-wide** whatever the
  breakdown is filtered to: they answer "how much did I train", while
  `muscle_groups` answers "what did I train".
- `workout_id` is exposed here and nowhere else — it is what `hevy_get_workout`
  and `hevy_calculate_burnt_calories` need.

Both this and `hevy_search_exercise_catalog` paginate `/v1/workouts` newest-first
(pages of 10), stopping at the first workout older than the window, and load all
exercise templates (pages of 100) to map `exercise_template_id` → muscle groups.
`hevy_search_exercise_catalog` covers stock and custom templates, matches on name
(exact, then prefix, then substring) and/or on `muscle_group` in either the
primary or secondary role, and returns the id as `exercise_template_id` — the
name the write tools ask for.

#### Writing

Every write follows the same three steps:

1. **Resolve** — exercises are addressed by `exercise_template_id`. Either call
   `hevy_search_exercise_catalog`, or pass `exercise: "<name>"` and let it resolve. An
   ambiguous name is refused with the candidates listed rather than guessed at.
2. **Build** — `hevy-payloads.ts` constructs and validates the body. It is pure,
   so a bad payload throws before any request is made.
3. **Submit** — POST to create, PUT to update. `dry_run: true` stops after step 2
   and returns the body that would have been sent.

Exercises are a list of objects, accepted in either form:

```jsonc
// explicit sets
{"exercise": "Bench Press (Barbell)", "sets": [
  {"type": "warmup", "reps": 10, "weight_kg": 20},
  {"reps": 8, "weight_kg": 60, "rpe": 8}
]}

// "3x8 @ 60kg" — a count plus the set fields to repeat
{"exercise_template_id": "79D0BB3A", "sets": 3, "reps": 8, "weight_kg": 60}
```

Set fields: `type` (`normal` default, or `warmup`/`failure`/`dropset`),
`weight_kg`, `reps`, `distance_meters`, `duration_seconds`, `custom_metric`;
workout sets also take `rpe`, routine sets also take `rep_range`. Exercise
fields: `notes`, `superset_id`, plus `rest_seconds` on routines. Sending a field
to the wrong target is rejected locally rather than by a Hevy 400.

#### Updates are merges, not patches

Hevy has no PATCH — `PUT` replaces the whole object, so anything missing from
the body is **deleted**. Both write tools therefore fetch the current object and
merge the caller's fields over it:

- Omit `exercises` and the existing ones are preserved.
- Pass `exercises` with `exercise_mode: "replace"` (default) to swap them, or
  `"append"` to add to the end.

Two API constraints this surfaces rather than hides:

- A routine **cannot be moved between folders** — `folder_id` is accepted only
  on create, so `folder_name` on an update is refused instead of silently
  ignored.
- Reads return `supersets_id`, writes expect `superset_id`, and reads carry
  server-assigned `index`/`title` that writes reject. The payload layer
  translates, so supersets survive a read-edit-write round trip.

There is no DELETE anywhere in the Hevy API; anything created has to be removed
in the app.

### Google Calendar (`gcal_*`)

All tools default to the **primary** calendar; pass `calendar_id` to target
another one (from `gcal_list_calendars`). Event bodies are normalized (id,
summary, description, location, `start`/`end` as a single string, `all_day`,
attendees, organizer, ...) — same shape the Python `_format_event` produced.

| Tool | Parameters | Purpose |
|---|---|---|
| `gcal_list_calendars` | `min_access_role?` | List calendars the account can see. |
| `gcal_list_events` | `calendar_id?`, `time_min?`, `time_max?`, `query?`, `max_results?` (default 50, max 2500) | List/search events, recurring events expanded, ordered by start time. |
| `gcal_get_event` | `event_id`, `calendar_id?` | Fetch one event. |
| `gcal_create_event` | `summary`, `start`, `end`, `calendar_id?`, `description?`, `location?`, `attendees?`, `all_day?`, `timezone?`, `send_notifications?` | Create an event. `all_day` events take `YYYY-MM-DD` for start/end; timed events take RFC3339 + `timezone` (default UTC). |
| `gcal_update_event` | `event_id`, `calendar_id?`, + same optional fields as create | Partial update (PATCH) — only provided fields change. |
| `gcal_delete_event` | `event_id`, `calendar_id?`, `send_notifications?` | Delete an event. |
| `gcal_free_busy` | `time_min`, `time_max`, `calendar_ids?` (default `["primary"]`) | Busy blocks per calendar in a window — use to infer free slots. |

Mapping from the Python surface: `gcal_list_calendars` /  `gcal_list_events` /
`gcal_get_event` / `gcal_create_event` / `gcal_update_event` /
`gcal_delete_event` unchanged 1:1; `gcal_find_free_slots` →
`gcal_free_busy` (renamed for symmetry with the REST endpoint name). The
`_format_event` normalization and pagination behavior are preserved exactly.

## Secrets

Same pattern as `OPENROUTER_API_KEY` — plain env vars through `node-config`
(`config/custom-environment-variables.json`), never in code or config files:

| Env var | Where to get it | Production source |
|---|---|---|
| `YNAB_TOKEN` | https://app.ynab.com/settings/developer (personal access token) | SSM `/personal-context/ynab-token` |
| `HEVY_API_KEY` | https://hevy.com/settings?developer (requires Hevy Pro) | SSM `/personal-context/hevy-api-key` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `client_id`/`client_secret` fields inside an OAuth "Desktop app" client downloaded from Google Cloud Console (Calendar API enabled). Read the two fields out of the JSON, then the file itself can be discarded — nothing here depends on it persisting anywhere | SSM `/personal-context/google-client-id`, `/personal-context/google-client-secret` |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | Mint one with `GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npx tsx scripts/setup-gcal-oauth.ts` in **this repo** (one-time interactive browser flow: opens the consent screen, catches the redirect on a local loopback server, exchanges the code for tokens) — prints `refresh_token` to the terminal, nothing written to disk | SSM `/personal-context/google-calendar-refresh-token` |

Empty value on any of the three ⇒ the connection reports "not configured" on
`/ready` and `gcal_*` tools return an `isError` result with a clear message —
the server still boots, and the rest of the host is unaffected. `YNAB_TOKEN`
and `HEVY_API_KEY` come straight from their dashboards (links above); Google's
three values come from `scripts/setup-gcal-oauth.ts` as described (never
commit any of these — they're secrets, same tier as an API key). The old
`my-mcp-platform` repo (originally the source of these tools, and previously
also of the OAuth-minting flow) is deprecated — nothing in this MCP depends on
it anymore.

### The OAuth consent screen must be "In production" (not "Testing")

The single most important gotcha when re-minting the Calendar refresh token.
While the Cloud Console project's OAuth consent screen sits in **Testing**
status, Google hard-expires every refresh token **7 days after consent**, no
matter how actively it is used — `gcal_*` silently dies a week after each
setup. Clicking **Publish app** (the button is labelled "Publish app"; the
confirmation dialog calls it pushing to production) removes that expiry.

Publishing does **not** require passing Google's verification review, despite
what the dialog implies:

- Publishing is not gated on verification — an unverified app publishes fine.
- The only costs are a "Google hasn't verified this app" interstitial during
  consent (click **Advanced → Go to \<app\> (unsafe)**) and a lifetime cap of
  100 consenting accounts. With one user, neither matters.
- "In production" does not list or expose the app publicly.
- **Publish before minting.** A token issued while still in Testing keeps its
  7-day expiry even if the status is flipped afterwards.

Mint order therefore: publish the app → run `scripts/setup-gcal-oauth.ts` →
`put-parameter` the three values → `deploy/deploy.sh`.

### Getting the values to production

The five SSM `SecureString` placeholders and the `deploy.sh`/`docker-compose.yml`
plumbing already exist in `personal-infra/context` (Terraform `main.tf`,
`deploy/deploy.sh`, `deploy/docker-compose.yml`); Terraform creates them with
the literal value `PLACEHOLDER` under `ignore_changes = [value]`, so writing a
real value is a plain `put-parameter --overwrite` and needs **no**
`terraform apply`:

```bash
aws ssm put-parameter --profile personal --region us-east-1 --type SecureString --overwrite \
  --name /personal-context/google-calendar-refresh-token --value "<token>"
```

`deploy.sh` treats a still-`PLACEHOLDER` value as empty and prints
`(google-* still PLACEHOLDER -> gcal_* tools disabled)` — that line is the
fastest way to tell a missing `put-parameter` from a deploy problem.

Because the container reads plain env vars rendered into `.env` at deploy time,
**an SSM write alone changes nothing on the droplet** — `deploy/deploy.sh` has
to re-render and restart it. Per `personal-infra`'s `CLAUDE.md`, that script is
human-run (it SSHes into the shared production droplet), as is
`terraform apply`.

## Architecture

Follows the host's existing patterns exactly (see the connection/registry docs):

- `src/connections/ynab.ts`, `src/connections/hevy.ts`,
  `src/connections/google-calendar.ts` — lazily-built, process-wide
  `Connection`s owning auth + transport only; `maybe()` returns `undefined`
  when unconfigured. Registered in `src/connections/registry.ts`, probed by
  `/ready`. `google-calendar.ts` additionally owns the OAuth refresh-token →
  access-token exchange and caches the access token in memory until near
  expiry (see `google-calendar.test.ts` for the caching/refresh behavior).
- `src/mcps/personal-tools/tools.ts` — endpoint paths, response shaping,
  pagination, report aggregation, and the Hevy write orchestration (template
  resolution, read-modify-write merge). Pure functions over an injected client ⇒
  unit-tested with fakes (`tools.test.ts`).
- `src/mcps/personal-tools/hevy-payloads.ts` — Hevy request-body construction
  and validation. No client, no I/O, so the payload rules are tested directly
  (`hevy-payloads.test.ts`) and the same builders back both create and update.
- `src/mcps/personal-tools/index.ts` — `McpDefinition` (`path:
  'personal-tools'`) building a fresh `McpServer` per request; added to
  `src/registry/registry.ts`, mounted automatically by `buildServer()` behind
  the same static-bearer `authenticate` handler as `/personal-context`.

## Point a client at it

```bash
claude mcp add --transport http personal-tools http://localhost:3000/personal-tools \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

## Verification

- `npm test` — unit tests over the handlers (compact/verbose transactions,
  scope precedence, report math, Hevy pagination cutoff + warmup exclusion +
  muscle/day grouping + depth and type guards + catalog browse by muscle group,
  Hevy payload validation + read/write shape round trip +
  create/update dispatch + merge semantics, Calendar event
  formatting/pagination/all-day inference, `google-calendar.ts` token exchange
  + caching + refresh + error surfacing).
- Live smoke (2026-07-19, real tokens): `tools/list` returned the 10 YNAB/Hevy
  tools; `ynab_report kind=net_worth` returned the real 4-account net worth;
  the muscle-group aggregation over 365 days covered 42 workouts with correct
  per-muscle ordering; unconfigured runs return clean `isError` results. That
  smoke predates the 2026-08-06 read-tool reshape (two aggregations merged into
  `hevy_recent_activity`, `hevy_search_exercises` →
  `hevy_search_exercise_catalog`), which is covered by unit tests only so far. The 2026-09-13 YNAB reshape
  (8 reshaped tools, `/plans/…` endpoints, currency-unit amounts, writes with
  `dry_run`) is likewise unit-tested only — re-smoke against the real API
  before relying on it in production.
- Hevy writes, live dry-run against the real account (2026-08-06): renaming a
  7-exercise / 28-set routine preserved all 7 and 28 with `folder_id` correctly
  absent and no read-shape keys leaking; `exercise_mode: "append"` produced 8;
  an ambiguous exercise name was refused with candidates. **No live write has
  been executed** — the create/update paths are verified only through `dry_run`
  and unit tests, because Hevy has no DELETE to undo a test record with.
- Calendar auth, verified live 2026-08-23: a refresh token minted via
  `scripts/setup-gcal-oauth.ts` (consent screen published to production first)
  exchanged successfully for an access token against
  `oauth2.googleapis.com/token`, and `calendarList` returned the real primary
  calendar. That exercised the same refresh-grant path `google-calendar.ts`
  uses, but by direct REST from the laptop — the `gcal_*` **tools** themselves
  are still unit-tested only, not yet driven through the deployed MCP.
