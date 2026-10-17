# Doctolib MCP

`POST /doctolib`: finds doctor appointments on doctolib.de / .fr / .it. It is a
TypeScript port of the read path of
[esinecan/doctolib-mcp](https://github.com/esinecan/doctolib-mcp) (Python), rebuilt on
this host's connection + MCP registry pattern.

**Read-only.** Nothing here books or cancels. The way to book is `booking_url`: the
user opens it and finishes in a browser.

## Tools

| Tool | What it does |
|---|---|
| `find_earliest_appointment` | The main tool. Searches a specialty in a city, probes each hit's availability (4 at a time, up to `scan`), returns soonest first. |
| `search_doctors` | Search without availability. Each hit carries `visit_motive_id`, `agenda_ids`, `practice_id` and `profile_slug`. |
| `get_practitioner` | All visit motives / agendas / places for a profile, for when search matched the wrong motive. |
| `get_availabilities` | Slots for one motive/agenda/practice triple, walked in ≤15-day windows. |
| `list_specialties` | Specialty slugs verified against the live API. |
| `booking_url` | The profile page a human books from. |

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

These were all found against the live API while validating with MCP Inspector.

- **Specialty slugs must be exact, and fail silently.** An unknown keyword returns
  `total: 0`, not an error. There is no pattern: `urologie` and `radiologe` work, but
  `urologe` and `radiologie` do not. Upstream's list had 10 of 15 slugs returning zero
  (`zahnarzt`, `dermatologe`, `augenarzt`, `gynakologe`, `kardiologe`, …). `SPECIALTY_SLUGS` in
  `tools.ts` lists only slugs probed on 2026-10-17, and a zero-hit search returns a `hint`
  pointing at `list_specialties`, so an agent retries instead of reporting "no doctors".
  The old autocomplete endpoint (`/api/searchbar/autocomplete.json`) answers `410`.
- **`redirect_url` is not the profile.** `info.json` returns the specialty/city listing
  (`/zahnmedizin/berlin`). The profile is that plus the slug. Upstream's `booking_url`
  links to the listing; this one appends the slug.
- **English is `gb`, not `en`.** The language filter takes flag-style codes: on
  2026-10-17, public GPs in Berlin returned 0 with `en` and 464 with `gb`. The agent
  eval caught this because the original tool description said `"en"`. The description
  now says `gb`, and `en` is aliased to `gb` server-side.
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
npx @modelcontextprotocol/inspector --cli http://localhost:3000/doctolib --transport http \
  --method tools/call --tool-name find_earliest_appointment \
  --tool-arg specialty=zahnmedizin --tool-arg city=Berlin --tool-arg limit=3
```

## Agent evals

Inspector shows that the tools work. Agent evals show whether a model *uses* them well.
`npm run eval` puts any OpenRouter model in front of the running endpoint, with the
server's own instructions and tool schemas, and scores each run with deterministic
checks (no LLM judge): which tools it called, with which arguments, how many calls, and
regexes over the final answer. Cases live in `src/evals/cases/doctolib.ts`. Each one
targets one failure mode: tool choice, filter mapping, the silent slug trap, claiming a
booking it can't make, and calling tools for an unrelated question.

```bash
# OPENROUTER_API_KEY in .env, host running on :3000
npm run eval -- --mcp doctolib --dry-run                       # validate cases, no LLM
npm run eval -- --mcp doctolib --model <openrouter-model-id> --repeat 3
```

LLM API failures (rate limits, overloaded providers) are retried with backoff and, if
they persist, reported as `ERR` and left out of the pass rate: they say nothing about
the model's tool use. On free models they are common. On 2026-10-17 Gemma 4 31B and
Nemotron 3 Ultra were both unusable for this reason, and `nvidia/nemotron-3-super-120b-a12b:free`
worked. It scored 4/5 on the first run; the one failure was the `en`/`gb` bug above.
After the fix it used `gb` every time, but one of two repeats still overran the call
budget by re-running the same search.

### Native vs prompted tool calling

`--tool-mode prompted` sends no `tools` parameter. The signatures go into the system
prompt in the Hermes function-calling format, and calls are parsed out of plain text as
`<tool_call>{"name", "arguments"}</tool_call>` blocks (`src/evals/hermes-format.ts`),
with results returned as `<tool_response>` blocks. This is how to evaluate models served
without native tool calling: every Nous Hermes model on OpenRouter reports
`tools: false`. Running the same model in both modes also separates the model's tool
judgement from the provider's tool-calling layer. Calls that can't be parsed (bad JSON,
missing tags) are counted as `formatErrors` in both modes, and the parse error is fed
back so the model can retry.

First comparison (Nemotron 3 Super, free, 2026-10-17, one run per case):

| | native | prompted |
|---|---|---|
| earliest-dentist | pass | pass |
| english-gp-public | fail (call budget, before the `gb` fix) | fail: last turn was an untagged tool call, not an answer |
| dermatologist-hamburg | pass | pass, after recovering from one malformed call |
| book-request / out-of-scope | pass / pass | not run (free daily cap) |

The prompted run exposed three harness bugs, all fixed:
- A correct date written with U+2011 hyphens failed the ASCII answer regex; answers are
  now normalised before matching.
- An untagged tool call was accepted as the final answer; it is now a format error.
- The free tier's daily cap was being retried.

A Hermes pass costs about $0.06 to $0.10 (≈17k input and 0.8k output tokens per case):
```bash
npm run eval -- --mcp doctolib --model nousresearch/hermes-3-llama-3.1-70b --tool-mode prompted
```

`--rescore <results.json>` re-applies the current checks to saved traces with no LLM or
MCP calls. Use it after changing a case or a check, to see how old runs would score.

Use `--repeat`, because tool use varies from run to run, so report pass rates rather than
one green run. Full traces land in `eval-results/` (gitignored). Comparing models, or a
tool-description change before and after, on the same cases is how the descriptions get
tuned. The cases hit the live API, so results also move when Doctolib does.

The unit tests (`src/mcps/doctolib/tools.test.ts`) use a fake client built from
upstream's recorded payloads and never touch the network. The smoke script only checks
`tools/list` on `/doctolib`, so CI never calls doctolib.de.
