# Ontologies layer

The taxonomy that classifies the vault also exists as a **formal OWL ontology**: the
14 categories become OWL classes, notes become typed individuals, and relationships
become object-property edges — all persisted as **RDF/XML** (`.owl` / `.rdf`),
versioned in S3, searchable through MCP tools, and visualized at
[`/visual-ontologies`](#dashboard--visual-ontologies).

```
Obsidian vault ──cron──► s3://…/obsidian-vault-sync/          [RAW]
                              │  context-pipeline (existing)
                              ▼
                s3://…/context-enriched/                       [ENRICHED]
                              │
                              │  INJECTOR (this repo): hourly cron at :00
                              │  + on-demand via the ontology_sync tool.
                              │  LLM discovery loop (max 5 iterations/doc),
                              │  validated against the OWL schema; failures
                              │  park in a pending-guidance (elicitation) queue.
                              ▼
                s3://…/ontology/                               [ONTOLOGY REGISTRY]
                   ├── schema.owl          OWL TBox (RDF/XML)
                   ├── data.rdf            current ABox (RDF/XML)
                   ├── versions/v<n>.rdf   immutable snapshot per version
                   ├── manifest.json       version history, processed hashes,
                   │                       pending_guidance queue
                   └── embeddings.json     node id → OpenRouter embedding
                              │
              ┌───────────────┼──────────────────┐
              ▼               ▼                  ▼
      ontology_search   ontology_update   GET /visual-ontologies
      (MCP tool)        (MCP tool)        (dashboard, parses data.rdf)
```

## The OWL schema (TBox)

Single source of truth: [`src/ontology/vocabulary.ts`](../src/ontology/vocabulary.ts).
`schema.owl` is regenerated from it on every save; everything below is expressed in
standard OWL constructs in RDF/XML.

- **Classes** — `pc:PersonalEntity` root; the 14 taxonomy categories
  (`Value, Person, HealthCondition, Skill, Constraint, Habit, FinancialItem, Tool,
  Goal, Project, Milestone, Decision, Situation, Event`) as `owl:Class`,
  each `rdfs:subClassOf pc:PersonalEntity`. Same closed vocabulary as
  `context-pipeline/pipeline/schema.py` — the injector can never invent classes.
- **Datatype properties** — `summary`, `status`, `horizon`, `salience`,
  `situationShape` (Situation-only), `sourcePath` (provenance, multi-valued),
  `note`. Single-valued ones are declared `owl:FunctionalProperty`; `status` /
  `horizon` / `situationShape` carry the pipeline's closed value sets.
- **Object properties with cardinalities** — `relatesTo`, `involvesPerson`,
  `contributesTo` (Project→Goal), `milestoneOf` (Milestone→Project, **max 1**,
  declared via an `owl:Restriction` / `owl:maxCardinality` block on `Milestone`),
  `motivatedBy` (→Value), `constrainedBy` (→Constraint), `usesTool` (→Tool),
  `requiresSkill` (→Skill), `supportsGoal` (Habit→Goal), `informedBy`
  (Decision→…), `concerns` (Event→…). Domains and ranges are enforced on every
  write.

Namespace: `https://pbenavides.dev/ontology/personal-context#` (prefix `pc:`).
A node with id `knee-rehabilitation` has IRI `pc:knee-rehabilitation`.

## Timestamps: when did a node / edge / attribute change

Every assertion carries its own `dcterms:created` / `dcterms:modified`, **inside the
RDF** so any consumer (including the dashboard) can read them:

- **Nodes** — typed element carries `dcterms:created/modified` (node `modified`
  also bumps when one of its attributes or incident edges changes).
- **Edges and attributes** — one reified `rdf:Statement`
  (`rdf:subject/predicate/object` + `dcterms:created/modified`) per assertion.

`applyUpdate` (in [`src/ontology/model.ts`](../src/ontology/model.ts)) only bumps
`modified` when a value actually changes — re-asserting the same fact is a no-op.

## Persistence & versioning

[`src/connections/ontology-store.ts`](../src/connections/ontology-store.ts).
Backends: `s3` (production, prefix `ontology/` in `personal-pbenavides`) and `file`
(dev/tests, default `data/ontology/`, gitignored). Every persisted mutation bumps
`manifest.version`, rewrites `data.rdf`, and writes an immutable
`versions/v<n>.rdf` snapshot with a note (`sync: 6 routed, 1 parked`,
`ontology_update: +2n +1e`). Writers are serialized through an in-process lock —
the hourly sync and a tool update can't interleave.

## Injector layer (Obsidian → ontology registry)

[`src/ontology/injector.ts`](../src/ontology/injector.ts). Input is the enriched
corpus (already synced from Obsidian and taxonomy-classified), gated by body hash:
only new/changed documents are routed.

Per document, a **discovery loop with a hard cap of 5 iterations**:

1. Prompt the OpenRouter chat model with: the vocabulary catalog (classes,
   properties, cardinalities), the document (path, category, summary, entities,
   bounded body excerpt), the most-related existing nodes (so it reuses ids
   instead of minting duplicates), and — from iteration 2 — the validator errors
   of its previous attempt, verbatim.
2. The model answers with a JSON graph update (`nodes` + `edges`) or with
   `{"action": "needs_guidance", "question": …}`.
3. The update is validated against the OWL schema (unknown class/property, wrong
   domain/range, closed-vocabulary values, cardinality violations, malformed ids)
   and applied **all-or-nothing**.

**Elicitation.** When the loop exhausts its 5 iterations, or the model asks for
help, the document is parked in `manifest.pending_guidance` with a concrete
question. The MCP transport is stateless JSON (no server-initiated requests), so
elicitation is surfaced *through* the `ontology_sync` tool: its report lists the
open questions, and the caller answers by invoking the tool again with
`guidance: [{path, instruction}]` — the instruction is prepended to the prompt as
`HUMAN GUIDANCE` and the document re-enters the loop. Parked documents are
skipped by scheduled runs until answered. The dashboard shows the queue as an
"awaiting guidance" badge.

Changed nodes are re-embedded (OpenRouter embeddings) at the end of the run;
embedding failure never loses routed graph data (keyword search covers the gap).
One sync run persists at most one new version.

## Cron

Upstream, the existing laptop cron syncs the vault to S3 hourly. In this service,
[`src/ontology/scheduler.ts`](../src/ontology/scheduler.ts) fires the injector at
**every top of the hour (minute 00)** when `ONTOLOGY_SYNC_ENABLED=true`. The
`ontology_sync` tool runs the identical job on demand; a shared in-flight guard
prevents overlap. Cost is bounded by `ONTOLOGY_MAX_DOCS` (default 25 docs/run).

## MCP tools

| Tool | Purpose |
|---|---|
| `ontology_search({query, classes?, limit?, hops?})` | Dense retrieval over nodes (OpenRouter embeddings + cosine; keyword-overlap fallback when unconfigured/unavailable), then neighborhood expansion (`hops` 0–2, default 1). Returns matched nodes with attributes + timestamps, surrounding edges (with timestamps), and neighbor nodes. |
| `ontology_update({nodes?, edges?, attributes?, removeNodes?, removeEdges?})` | Validated upsert/removal. Whole batch checked against the schema, applied all-or-nothing, persisted as a new immutable version; changed nodes re-embedded. |
| `ontology_sync({guidance?, force?})` | Runs the injector now (same job as the cron). Report includes `pending_guidance` — answer via `guidance: [{path, instruction}]`. `force` re-routes everything. |

## Dashboard — /visual-ontologies

[`src/visual-ontologies/`](../src/visual-ontologies/). A single self-contained
HTML page (no external assets, CSP-locked to same-origin fetches + its own inline
script) that **fetches `/visual-ontologies/ontology.rdf` and parses the RDF/XML
client-side** — it consumes the persisted datasource directly, reified timestamps
included. Features: force-directed canvas graph (drag, pan, zoom), 8 validated
categorical hues × 2 shapes for the 14 classes (identity never color-alone),
class legend with counts and toggles, text filter, recent-change rings (< 72 h),
hover tooltip with "updated X ago", and a detail panel showing per-attribute and
per-edge `created`/`modified`. Sibling endpoints: `ontology.rdf`, `schema.owl`,
`meta.json` (version history + pending guidance). Like `/health`, the surface is
unauthenticated — ingress is Tailscale-gated; the bearer token protects the MCP
tool routes.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `ONTOLOGY_SOURCE` | `file` | `file` (local `ONTOLOGY_ROOT`, default `data/ontology`) or `s3` |
| `ONTOLOGY_BUCKET` / `ONTOLOGY_PREFIX` | — / `ontology/` | S3 location (use `personal-pbenavides`) |
| `ONTOLOGY_SYNC_ENABLED` | `false` | hourly injector cron at :00 |
| `ONTOLOGY_MAX_DOCS` | `25` | per-run LLM cost bound |
| `OPENROUTER_API_KEY` | — | **secret**; empty disables injector + dense search (keyword fallback stays) |
| `OPENROUTER_CHAT_MODEL` | `openai/gpt-4o-mini` | injector routing model |
| `OPENROUTER_EMBED_MODEL` | `openai/text-embedding-3-small` | must stay consistent with stored `embeddings.json` |

The key lives in `.env` locally (gitignored) and in SSM
(`/personal-context/openrouter-api-key`) in production, injected as
`OPENROUTER_API_KEY` by the deploy — never in code, config files, or Terraform.

## Failure modes

- **No OpenRouter key** — service boots and serves; `ontology_sync` reports itself
  unconfigured, `ontology_search` uses keyword ranking.
- **Embedding call fails mid-sync** — routed graph is persisted anyway; search
  falls back to keywords for the affected nodes until the next successful run.
- **Invalid LLM proposals** — never touch the graph (all-or-nothing validation);
  after 5 iterations the document parks with a question instead of poisoning the
  registry.
- **Concurrent writes** — serialized by the store's writer lock.
