# Doctolib tools (`doctolib_*` in personal-tools)

Two tools on `POST /personal-tools` that find doctor appointments on doctolib.de / .fr
/ .it. They are a TypeScript port of the read path of
[esinecan/doctolib-mcp](https://github.com/esinecan/doctolib-mcp) (Python), rebuilt on
this host's connection pattern. The handlers are in
`src/mcps/personal-tools/doctolib-tools.ts`, and the transport is in
`src/connections/doctolib.ts`.

**Read-only.** Nothing here books or cancels. Every result carries a `booking_url`: the
user opens it and finishes in a browser.

## Tools

Two intent-level tools, consolidated the same way as the YNAB and Hevy surfaces: filters
are parameters, and the presence of an argument decides how much comes back.

| Tool | Parameters | What it does |
|---|---|---|
| `doctolib_search` | `specialty`, `city?` (Berlin), `availability?` (true), `within_days?` (14), `insurance_sector?`, `languages?`, `telehealth?`, `limit?` (10), `page?`, `country?` | Practitioners for a specialty in a city. By default it probes each bookable hit's slots (4 at a time) and returns them soonest first, each with `next_slot`, a 3-day preview of times, `booking_url`, `profile_slug` and `motive_id`. `availability: false` is the plain paged list. |
| `doctolib_practitioner` | `profile_slug`, `visit_motive_id?`, `start_date?`, `days?`, `country?` | One profile: visit motives with ids, places, `booking_url`. With `visit_motive_id`, that motive's slots per place and day for any window. The agendas and practice the slot call needs are derived from the profile. |

Responses are shaped for a model to read. Slots come as `{"2026-10-17": ["18:45", …]}`
in the practice's local time, internal ids (agendas, practices) are not exposed, and
empty fields are dropped. The verified specialty slugs are in `specialty`'s description,
so no lookup call is needed first.

## How it reaches Doctolib

There is no public API: the official one is partner-only. The connection
(`src/connections/doctolib.ts`) talks to the JSON the patient website itself uses:

```
POST /patient-health-search/api/v1/hcp/search?page=N                     practitioners
GET  /online_booking/api/slot_selection_funnel/v1/info.json?profile_slug  motives, agendas
GET  /availabilities.json                                                open slots
```

No credentials. A Chrome User-Agent plus a `Referer` gets past DataDome on these JSON
endpoints (as of 2026-10). A `403` is reported as such and is not retried; once that
starts, the fix is a real browser session, not more header guessing. Requests are
throttled per host (`DOCTOLIB_MIN_INTERVAL_MS`, default 600 ms, with jitter).

City → bounding box comes from Nominatim (OpenStreetMap, free, no key). The viewport is
what actually filters: lat/lng alone silently returns nationwide results.

## Things that bite

These were all found against the live API.

- **Specialty slugs must be exact, and fail silently.** An unknown keyword returns
  `total: 0`, not an error. There is no pattern: `urologie` and `radiologe` work, but
  `urologe` and `radiologie` do not. Upstream's list had 10 of 15 slugs returning zero
  (`zahnarzt`, `dermatologe`, `augenarzt`, `gynakologe`, `kardiologe`, …).
  `SPECIALTY_SLUGS` lists only slugs probed on 2026-10-17. They are in the tool schema,
  and a zero-hit search returns a `hint` that lists them, so an agent retries instead of
  reporting "no doctors". The old autocomplete endpoint
  (`/api/searchbar/autocomplete.json`) answers `410`.
- **English is `gb`, not `en`.** The language filter takes flag-style codes: on
  2026-10-17, public GPs in Berlin returned 0 with `en` and 464 with `gb`. Models reach
  for `en`, so it is aliased to `gb` server-side, and the description says `gb`.
- **`redirect_url` is not the profile.** For a doctor, `info.json` returns the
  specialty/city listing (`/zahnmedizin/berlin`), and the profile is that plus the slug.
  For a practice ("organization") it is empty, and `/booking/<slug>`, the upstream
  fallback, redirects to the homepage. `/profiles/<slug>` redirects to the real page for
  both kinds, so it is the fallback.
- **Names carry stray whitespace** ("…durch Oberarzt "), so they are trimmed.
- **Search answers `206`**, not 200. Both count as success.
- **`limit < 2` on availabilities is a `400`**, so the trailing window is floored at 2.
- **`reason: "not_opened_availability"`** means the practice hasn't released slots that
  far ahead. That is not the same as fully booked, and the reason is passed through.

## Not ported (yet)

Upstream's authenticated half (`my_appointments`, `session_status`, `book_appointment`,
`cancel_appointment`, `abort_booking_draft`) drives a logged-in Playwright browser
profile with CSRF-rotating in-page `fetch`. It is left out on purpose:

- it needs the user's Doctolib login in a persistent browser on the host, which doesn't
  fit a stateless, headless droplet service;
- booking and cancelling are binding real-world actions, and upstream's booking funnel
  has never run end to end.

If it's added later, keep upstream's `confirm=false` default (preview only) and put it
behind its own connection with a clean "not configured" path, like the other credentialed
integrations.

## Checking it by hand

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/personal-tools --transport http \
  --method tools/call --tool-name doctolib_search \
  --tool-arg specialty=zahnmedizin --tool-arg city=Berlin --tool-arg limit=3
```

Then `doctolib_practitioner` with a result's `profile_slug`, and again with one of its
motive ids as `visit_motive_id`.

The unit tests (`src/mcps/personal-tools/doctolib-tools.test.ts`) use a fake client built
from upstream's recorded payloads and never touch the network. The smoke script only
checks that `tools/list` on `/personal-tools` includes them, so CI never calls
doctolib.de.
