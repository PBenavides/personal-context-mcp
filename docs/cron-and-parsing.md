# Cron & parsing: how documents become ontology assertions

This document traces the *timing* (when the injector runs) and the *parsing*
(how a free-text document turns into typed nodes/edges), and answers the
specific question: **which time signals and which "other variables" are actually
considered when we build the ontology, and which are not.**

For the schema itself and the MCP tools, see
[`ontologies.md`](./ontologies.md). This doc is about the *pipeline of time and
inputs* feeding the injector.

---

## 1. The two crons (they are different jobs, on the same cadence)

There are **two independent hourly jobs**, both firing at the top of the hour,
chained end to end:

```
        ┌─ CRON A (upstream) ──────────┐      ┌─ CRON B (this service) ──────┐
Obsidian│ pipeline.timer on the droplet│      │ scheduler.ts inside the MCP  │
 vault  │ hourly, one-shot             │      │ container, fires at :00      │
   │    │                              │      │                              │
   ▼    ▼                              ▼      ▼                              ▼
 vault ─► s3://…/obsidian-vault-sync ─► classifier+embedder ─► context-enriched ─► INJECTOR ─► ontology/
   RAW        (RAW layer)               (context-pipeline)      (ENRICHED layer)   (registry)
```

- **Cron A — the pipeline** (`context-pipeline`, a systemd `pipeline.timer` on
  the DigitalOcean droplet). Fires hourly, one-shot. It pulls the vault from S3,
  runs the LLM taxonomy classifier + Titan embedder, and writes the **enriched
  layer** (`context-enriched/`) plus the S3 Vectors index. This is where a note's
  `category`, `horizon`, `status`, `salience`, `summary`, `entities`,
  `confidence`, and `situation_shape` are assigned. See
  `context-pipeline/pipeline/schema.py` for the closed vocabulary.
- **Cron B — the injector** (`src/ontology/scheduler.ts`, in-process, inside the
  MCP container). Fires at **minute :00 every hour** when
  `ONTOLOGY_SYNC_ENABLED=true`. It reads the enriched layer and writes the
  **ontology registry** (`ontology/`).

They are deliberately on the same cadence so new vault content flows all the way
to the ontology within the hour. But they are not coordinated by a shared clock —
Cron B just runs hourly and picks up whatever Cron A has already produced.

### How Cron B (the injector scheduler) actually works

`src/ontology/scheduler.ts`:

- On boot it computes `msUntilNextHour()` and `setTimeout`s to the next `:00`.
  It does **not** run immediately at startup — the first tick is the next top of
  the hour.
- The timer is `.unref()`'d, so it never keeps the process alive on its own.
- Each tick: if a sync is **already in flight** (`isSyncRunning()`), the tick is
  **skipped** and logged — it does not queue. Otherwise it runs the job, then
  reschedules for the following `:00`.
- The same job body is exposed on demand as the `ontology_sync` MCP tool. Both
  paths share one process-wide in-flight guard (`src/ontology/sync-runner.ts`,
  `running` flag) so a scheduled tick and a tool call can never overlap.
- Cost is bounded per run by `ONTOLOGY_MAX_DOCS` (default 25 documents/run).

So the scheduling model is: **at most one injector run per hour, at most one at a
time, at most 25 documents per run.** If more than 25 documents changed in an
hour, the surplus is simply picked up on the next hourly tick (change-detection,
below, keeps them queued).

---

## 2. What gets parsed each run — the selection gate

`selectDocs()` in `src/ontology/injector.ts` decides which documents a run
touches. In priority order:

1. **Human-guided documents** — anything in the current run's `guidance` map is
   always routed and sorted first (answering a parked elicitation question).
2. **Parked documents** — anything already in `manifest.pending_guidance` is
   **skipped** by scheduled runs (it stays parked until a human answers via the
   tool).
3. **`force: true`** — re-routes every document regardless of state (tool-only).
4. **Change detection (the normal case)** — a document is routed only when its
   `body_hash` differs from `manifest.processed[path].body_hash`. Unchanged
   documents are skipped.

Then the list is capped at `maxDocsPerRun`.

**This is the primary "time" signal that actually drives parsing: not a
clock/date, but a *content delta*.** We route a document because its body changed
since we last saw it, not because of when it was written or what period it
describes. Re-running on identical content is a no-op.

---

## 3. How one document is parsed into the graph

Per selected document, `routeDocument()` runs a **discovery loop of at most 5
iterations** (`MAX_ITERATIONS`):

1. **Prompt** the OpenRouter chat model (`docPrompt()`) with:
   - the vocabulary catalog (classes, properties, cardinalities);
   - the document — **`path`, `category`, `summary`, `entities`, and a body
     excerpt capped at 3500 chars** (`BODY_EXCERPT`);
   - the 8 most keyword-related existing nodes (so it reuses ids instead of
     minting duplicates);
   - from iteration 2 on, the validator errors of the previous attempt, verbatim;
   - any `HUMAN GUIDANCE` for this path, prepended and marked as overriding.
2. **Model answers** with a JSON graph update (`nodes` + `edges`) or
   `{"action":"needs_guidance","question":…}`.
3. **Validate** against the OWL schema (`applyUpdate` in `src/ontology/model.ts`):
   unknown class/property, wrong domain/range, closed-vocabulary values,
   cardinality (e.g. `milestoneOf` max 1), malformed slug ids. Applied
   **all-or-nothing** — an invalid batch never touches the graph.
4. On validation failure the errors feed back into the next iteration. After 5
   failed iterations (or an explicit `needs_guidance`), the document **parks** in
   `pending_guidance` with a concrete question rather than corrupting the graph.

After all documents: changed nodes are re-embedded (best-effort; embedding
failure never loses routed graph data), and the run persists **at most one new
immutable version** of `data.rdf` + `versions/v<n>.rdf` + `manifest.json`.

---

## 4. Time: what we consider, and what we don't

This is the crux of "are we considering time and other variables?" The honest
answer is **we track time at the mechanical/provenance level, but we do not model
the document's own timeline as data.**

### Time signals we DO use

| Signal | Where | What it does |
|---|---|---|
| Hourly cadence | `scheduler.ts` | when the injector runs (top of each hour) |
| `body_hash` delta | `selectDocs()` | *whether* a document is re-parsed (content changed since last run) |
| Assertion timestamps | `applyUpdate()` in `model.ts` | every node, edge, and attribute carries its own `dcterms:created` / `dcterms:modified`, stamped with the **injection time** (`new Date().toISOString()`), only bumped when a value actually changes |
| `manifest.processed[*].updated_at` | injector | when each document was last successfully routed |
| Recent-change rings (< 72 h) | dashboard | visual "what changed lately", read from the reified timestamps |
| `enriched_at` | enriched-corpus manifest | when the pipeline last enriched a doc (informational) |

So "when did this fact enter or change in the ontology" is fully answerable. The
timestamps reflect **processing time, not event time.**

### Time signals we do NOT use (important gaps)

- **The document's own dates.** A note that says "knee surgery on 2025-03-10" or
  "goal deadline Q3" is passed to the model only as free-text body; there is **no
  temporal property in the OWL schema** (no `occurredOn`, `dueDate`,
  `startedAt`). Dates survive only if the model happens to fold them into a
  `summary` string. They are not queryable as time.
- **`horizon`** — the pipeline's per-document time-horizon
  (`closing / near / mid / far / standing / deferred / cadence / past`) is
  computed in the enriched layer and is available on `EnrichedDocument`, **but
  `docPrompt()` does not pass it to the injector.** So the ontology has no notion
  of how time-urgent/temporal a node is, even though upstream computed it.
- **Event `occurred_at`.** Activity events (English Collector) carry
  `occurred_at`, but it is flattened into the events *body text*
  (`eventsToBody`), not modeled as a typed timestamp on an `Event` node.
- **No decay / recency weighting.** Salience and recency don't influence routing
  order or retention. An old, stale node and a fresh one are treated identically.

---

## 5. "Other variables": what the pipeline computes vs. what the injector reads

The classifier produces a rich set of variables per document. The injector
**only forwards a subset** into the graph. This table makes the gap explicit:

| Variable | Produced by pipeline? | On `EnrichedDocument`? | Passed to injector prompt? | Modeled in ontology? |
|---|---|---|---|---|
| `category` | ✅ | ✅ | ✅ | ✅ → OWL class |
| `summary` | ✅ | ✅ | ✅ | ✅ → `summary` attribute |
| `entities` | ✅ | ✅ | ✅ | ⚠️ hint only (nudges node reuse; not stored as-is) |
| `body` | (source) | ✅ | ✅ (3500-char excerpt) | ⚠️ source material, not stored verbatim |
| `path` | (source) | ✅ | ✅ | ✅ → `sourcePath` (provenance) |
| `status` | ✅ | ✅ | ❌ **not passed** | ✅ schema supports it, but only if the model invents it |
| `horizon` | ✅ | ✅ | ❌ **not passed** | ✅ schema supports it, but not fed |
| `salience` | ✅ | ✅ | ❌ **not passed** | ❌ no schema property |
| `confidence` | ✅ | ❌ (dropped) | ❌ | ❌ |
| `situation_shape` | ✅ (Situations) | ❌ (dropped) | ❌ | ✅ `situationShape` exists, but not fed |

**Takeaway.** Of the classifier's variables, only `category`, `summary`,
`entities`, `body`, and `path` reach the model. `status`, `horizon`, `salience`,
`confidence`, and `situation_shape` are **computed upstream but never handed to
the injector** — the ontology's `status` / `horizon` / `situationShape`
attributes only get populated if the LLM independently decides to, from the body
text. This is the biggest lever if we want the ontology to be more
time/variable-aware.

---

## 6. If we want to "consider time and other variables" more

Concrete, low-risk changes, roughly in order of value:

1. **Forward the enriched variables into `docPrompt()`.** Add `status`,
   `horizon`, and (for Situations) `situation_shape` to the prompt so the model
   can set the matching attributes deterministically instead of guessing. Cheap;
   no schema change (`status` / `horizon` / `situationShape` already exist in the
   vocabulary).
2. **Add temporal datatype properties to the OWL schema** (e.g. `occurredOn`,
   `dueDate`, `startedAt` as `xsd:date`), and instruct the injector to extract
   them. Makes the ontology answer "what's due / what happened when."
3. **Model event time.** Promote `occurred_at` from event body text to a typed
   timestamp on `Event` nodes.
4. **Use `salience` for ordering/retention.** Route higher-salience changed docs
   first within the `maxDocsPerRun` cap; optionally surface low-salience/stale
   nodes for pruning.
5. **Recency in search.** Weight `ontology_search` by `dcterms:modified` so
   recently-touched nodes rank higher.

Items 1 and 5 require no schema migration; 2–4 change the OWL TBox
(`src/ontology/vocabulary.ts`) and would need the S3 contract review noted in the
workspace `CLAUDE.md`.

---

## Source map

| Concern | File |
|---|---|
| Injector scheduler (Cron B) | `src/ontology/scheduler.ts` |
| In-flight guard / shared entry point | `src/ontology/sync-runner.ts` |
| Selection gate + discovery loop | `src/ontology/injector.ts` |
| Validation + timestamp stamping | `src/ontology/model.ts` |
| Enriched document shape | `src/connections/enriched-corpus.ts` |
| Persistence / versioning | `src/connections/ontology-store.ts` |
| Closed vocabulary (upstream) | `context-pipeline/pipeline/schema.py` |
| Upstream cron (Cron A) | `fable_plans/DEPLOY_AND_HOSTING.md` |
