# The personal-context MCP

Mounted at `POST /personal-context` (streamable HTTP, stateless JSON mode).
It exposes the enriched personal-context corpus — Obsidian vault notes and
English Collector activity events, classified by the context-pipeline into the
closed 14-category taxonomy — through three read-only tools.

## Tools

### `search_context({ query, category?, status?, horizon?, limit? })`

BM25 keyword search over every document (notes + events). The optional filters
are case-insensitive exact matches on the pipeline's frontmatter:

- `category` — one of the taxonomy categories (`Goal`, `Project`, `Person`,
  `Habit`, `Event`, …; `list_taxonomy` shows what actually exists),
- `status` — `proposed | active | dormant | done`,
- `horizon` — `closing | near | mid | far | standing | deferred | cadence | past`.

`limit` defaults to 10 (max 25). Every hit is compact:

```json
{ "path": "notes/health/knee-rehab.md", "score": 3.1, "category": "HealthCondition",
  "horizon": "standing", "status": "active", "summary": "…", "snippet": "…" }
```

The snippet is a short body excerpt centred on the first query-term match.
Filtering happens **after** scoring the whole corpus, so a narrow filter
returns the best matches rather than an accidentally-empty page.

### `get_document({ path, full? })`

Fetches one document by its manifest path (as returned in search hits).
`full: true` (the default) returns the complete original content — for notes
that includes the enriched frontmatter; `full: false` returns a bounded body
preview plus the metadata fields.

### `list_taxonomy()`

The taxonomy as materialized in the current corpus: each category with its
document count, plus `taxonomy_version`, the manifest `run_id`, and
`generated_at`. Cheap — clients call it first to form good filters.

## Where the data comes from

All tools read the shared `enriched-corpus` connection
([docs/connections.md](./connections.md)): the corpus is loaded into memory at
boot from S3 (production) or a local directory (tests/fixtures), and refreshed
in the background when the pipeline publishes a new manifest `run_id`.

## Handler layering

`src/mcps/personal-context/index.ts` registers the tools (zod schemas, JSON
text results) and stays thin; the logic lives in `./tools.ts` as pure functions
over an `EnrichedCorpusIndex`, unit-tested against the fixture corpus. Errors
come back as structured `{ error }` payloads with a hint about what to call
instead — an agent-friendly failure mode.

## Future work (deliberately not built)

- **Semantic search** — POC is BM25-only (per the plan). If added, embeddings
  are computed by the pipeline into the enriched layer, never at serve time.
- **Write tools / multi-user auth** — out of scope; the server is single-user
  behind a static bearer token on a Tailscale-only network.
