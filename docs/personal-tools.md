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
| YNAB | Static bearer token (`YNAB_TOKEN`) | ✅ trivially — plain REST | **Ported** (8 tools) |
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
report tools merged behind a `kind` enum. Handlers live in
`src/mcps/personal-tools/tools.ts` (unit-tested against fake clients);
registration in `src/mcps/personal-tools/index.ts`.

### YNAB (`ynab_*`)

All tools default to the **last-used budget**; pass `budget_id` to override.
Raw endpoints return YNAB **milliunits** (1000 = one currency unit);
`ynab_report` converts to currency units.

| Tool | Parameters | Purpose |
|---|---|---|
| `ynab_budgets` | `budget_id?` | List budgets, or one budget in full detail. Only needed for budget discovery. |
| `ynab_accounts` | `budget_id?`, `account_id?` | Accounts with balances, or one account. |
| `ynab_transactions` | `budget_id?`, `transaction_id?`, `account_id?`, `category_id?`, `payee_id?`, `since_date?`, `type?`, `verbose?` | One query tool for all transaction access. Scope precedence: transaction > account > category > payee > whole budget (`since_date` then required). Compact view by default; `verbose=true` for full objects. |
| `ynab_create_transaction` | `account_id`, `date`, `amount` (milliunits, negative = outflow), `budget_id?`, `payee_name?`, `category_id?`, `memo?` | The only write tool. |
| `ynab_categories` | `budget_id?`, `category_id?`, `month?` | Category groups, or one category month-scoped with goal progress. |
| `ynab_payees` | `budget_id?` | All payees. |
| `ynab_scheduled` | `budget_id?` | Scheduled (recurring) transactions. |
| `ynab_report` | `kind` (`net_worth` \| `monthly_summary` \| `full`), `budget_id?`, `month?`, `months_back?` | Aggregated reports in currency units — the `reports.py` port. |

Mapping from the Python surface: `ynab_get_budget`→`ynab_budgets(budget_id)`;
`ynab_get_account`→`ynab_accounts(account_id)`; `ynab_get_transaction` /
`ynab_transactions_by_account` / `ynab_transactions_by_category` →
`ynab_transactions(...)`; `ynab_get_category_by_month`→
`ynab_categories(category_id, month)`; `ynab_net_worth` /
`ynab_monthly_summary` / `ynab_financial_report` → `ynab_report(kind=…)`.
Dropped: `ynab_get_user` (no agent value; connection health is reported on
`/ready`). The Python server's MCP *resources* and *prompts* were not ported —
this host is tools-only for now.

### Hevy (`hevy_*`)

Hevy models two different things and so do these tools: a **workout** is a
session that happened, a **routine** is a reusable plan.

| Tool | Parameters | Purpose |
|---|---|---|
| `hevy_recent_activity` | `days?` (default 4), `type?`, `depth?`, `specific?` | Recent training grouped by muscle group → day, plus each session's `workout_id` and duration. Warmup sets excluded. |
| `hevy_search_exercise_catalog` | `query?`, `muscle_group?`, `limit?` (20) | The exercise catalog by name and/or muscle group → `exercise_template_id`. The entry point for every write. |
| `hevy_get_workout` | `workout_id` | One logged workout with all exercises and sets. |
| `hevy_routines` | `routine_id?` | All routines, or one. |
| `hevy_write_workout` | `workout_id?`, `title?`, `start_time?`, `end_time?`, `exercises?`, `description?`, `is_private?`, `exercise_mode?`, `dry_run?` | Log a session; updates when `workout_id` is passed. |
| `hevy_write_routine` | `routine_id?`, `title?`, `exercises?`, `notes?`, `folder_name?`, `create_folder?`, `exercise_mode?`, `dry_run?` | Create a plan; updates when `routine_id` is passed. |
| `hevy_create_custom_exercise` | `title`, `exercise_type`, `equipment_category`, `muscle_group`, `other_muscles?`, `dry_run?` | Custom template when no stock exercise fits. |

Create and update are one tool per entity rather than two, consistent with how
the YNAB surface was consolidated: the presence of an id decides the verb.

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
  and `hevy_write_workout` need.

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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `client_id`/`client_secret` inside `my-mcp-platform/credentials/google_oauth_client.json` (an OAuth "Desktop app" client from Google Cloud Console) — reused as-is, same client already used for Sheets | SSM `/personal-context/google-client-id`, `/personal-context/google-client-secret` |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | **Needs a fresh consent** — `my-mcp-platform`'s existing `credentials/google_token.json` only carries the `spreadsheets`/`drive.file` scopes (Sheets), not `calendar`, so it can't be reused. Mint one with `uv run python servers/gcalendar/setup_oauth.py` in `my-mcp-platform` (one-time interactive browser flow), then read `refresh_token` out of the resulting `credentials/google_calendar_token.json` | SSM `/personal-context/google-calendar-refresh-token` |

Empty value on any of the three ⇒ the connection reports "not configured" on
`/ready` and `gcal_*` tools return an `isError` result with a clear message —
the server still boots, and the rest of the host is unaffected. Locally,
`YNAB_TOKEN`/`HEVY_API_KEY` can be copied from `my-mcp-platform/.env`;
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are copied from the client-secrets
JSON above; `GOOGLE_CALENDAR_REFRESH_TOKEN` requires the browser flow (never
commit any of these — they're secrets, same tier as an API key).

The five SSM `SecureString` placeholders and the `deploy.sh`/`docker-compose.yml`
plumbing already exist in `personal-infra/context` (Terraform `main.tf`,
`deploy/deploy.sh`, `deploy/docker-compose.yml`) — real values still need to
be `put-parameter`'d and `terraform apply` run once (see that repo; per its
`CLAUDE.md` these are human-run commands, not run unilaterally by an agent).

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
  `hevy_search_exercise_catalog`), which is covered by unit tests only so far.
- Hevy writes, live dry-run against the real account (2026-08-06): renaming a
  7-exercise / 28-set routine preserved all 7 and 28 with `folder_id` correctly
  absent and no read-shape keys leaking; `exercise_mode: "append"` produced 8;
  an ambiguous exercise name was refused with candidates. **No live write has
  been executed** — the create/update paths are verified only through `dry_run`
  and unit tests, because Hevy has no DELETE to undo a test record with.
- Calendar tools (`gcal_*`) are implemented and unit-tested but **not yet
  smoke-tested against a real Google account** — `GOOGLE_CALENDAR_REFRESH_TOKEN`
  needs to be minted (see Secrets above) before `tools/list`/live calls can be
  verified end-to-end.
