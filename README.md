# personal-context-mcp

MCP server exposing Pablo's enriched personal context — Obsidian vault notes
and activity events, classified by the
[context-pipeline](../context-pipeline/) into a closed 14-category taxonomy —
over **streamable HTTP** with **BM25 search**.

```
s3://…/context-enriched/  ──(boot load + run_id refresh)──►  in-memory corpus
                                                                   │
client ──POST /personal-context (Bearer token)──►  search_context / get_document / list_taxonomy
client ──POST /personal-tools   (Bearer token)──►  ynab_* / hevy_*  ──►  YNAB + Hevy REST APIs
```

## Tools (MCP `personal-context`, mounted at `/personal-context`)

| Tool | Purpose |
|---|---|
| `search_context({query, category?, status?, horizon?, limit?})` | BM25 over notes + events, filtered by taxonomy metadata; compact hits with `path`, `score`, `category`, `summary`, `snippet`. |
| `get_document({path, full?})` | Full document (frontmatter + body) or a bounded preview. |
| `list_taxonomy()` | Categories with document counts + taxonomy/manifest versions. |
| `ontology_search({query, classes?, limit?, hops?})` | Dense retrieval over the OWL ontology graph + neighborhood expansion (keyword fallback without OpenRouter). |
| `ontology_update({nodes?, edges?, attributes?, …})` | Schema-validated upsert into the ontology; persists a new immutable RDF version. |
| `ontology_sync({guidance?, force?})` | Runs the injector on demand (same job as the hourly cron); surfaces + accepts elicitation guidance. |

The ontology layer (OWL/RDF-XML registry in S3, LLM injector, hourly cron,
`/visual-ontologies` dashboard) is documented in
[docs/ontologies.md](docs/ontologies.md).

Details: [docs/personal-context-mcp.md](docs/personal-context-mcp.md). The
hosting architecture (per-request stateless transport, MCP registry,
connection layer) is documented in [docs/](docs/).

## Tools (MCP `personal-tools`, mounted at `/personal-tools`)

The action layer, ported from the Python `my-mcp-platform` server: 8 `ynab_*`
tools (budgets, accounts, unified transaction queries, categories, payees,
scheduled, one write, aggregated reports) and 2 `hevy_*` workout-analytics
tools. Requires `YNAB_TOKEN` / `HEVY_API_KEY`; unset keys disable the
corresponding tools cleanly. Full surface, design rationale, and the
Google-integrations status: [docs/personal-tools.md](docs/personal-tools.md).

## Run it

```bash
npm ci
npm run dev            # serves the test fixture corpus on :3000, no credentials needed
```

Against the real enriched layer:

```bash
CORPUS_SOURCE=s3 CONTEXT_BUCKET=personal-pbenavides CONTEXT_PREFIX=context-enriched/ \
AWS_PROFILE=personal MCP_BEARER_TOKEN=… npm run dev
```

Point a client at it:

```bash
claude mcp add --transport http personal-context http://localhost:3000/personal-context \
  --header "Authorization: Bearer $MCP_BEARER_TOKEN"
```

Shipping a change to production (Terraform root, ECR release, droplet
deploy, verification): [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Configuration

Via `config/*.json` + env overrides (`config/custom-environment-variables.json`).
See [.env.example](.env.example) for the full list:

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `MCP_BEARER_TOKEN` | *(empty = unauthenticated!)* | Static bearer required on MCP routes; `/health`+`/ready` stay open. |
| `CORPUS_SOURCE` | `file` | `file` or `s3`. |
| `CORPUS_ROOT` | `tests/fixtures/enriched` | Root directory for the `file` source. |
| `CONTEXT_BUCKET` / `CONTEXT_PREFIX` | — / `context-enriched/` | S3 location for the `s3` source (default AWS credential chain). |
| `REFRESH_SECONDS` | `300` | Manifest `run_id` re-check interval; `0` disables. |
| `ONTOLOGY_SOURCE` / `ONTOLOGY_BUCKET` / `ONTOLOGY_PREFIX` | `file` / — / `ontology/` | Where the RDF ontology registry lives (see docs/ontologies.md). |
| `ONTOLOGY_SYNC_ENABLED` | `false` | Hourly injector cron at minute :00. |
| `OPENROUTER_API_KEY` | *(empty = injector off, keyword search)* | Secret; `.env` locally, SSM `/personal-context/openrouter-api-key` in prod. |
| `YNAB_TOKEN` | *(empty = ynab_* tools off)* | Secret; `.env` locally, SSM `/personal-context/ynab-token` in prod (see docs/personal-tools.md). |
| `HEVY_API_KEY` | *(empty = hevy_* tools off)* | Secret; `.env` locally, SSM `/personal-context/hevy-api-key` in prod (see docs/personal-tools.md). |

## Verify

```bash
make verify   # typecheck + lint + jest + template-scrub grep + streamable-HTTP smoke test
```

`scripts/mcp_smoke.sh` starts the server against fixtures (or targets
`MCP_URL`) and asserts the `initialize` → `tools/list` → `tools/call
search_context` flow end to end — Workstream F reuses it with the production
URL and real token.

## Deploy (Workstream E hook)

`make build` produces the Docker image; the container reads everything from
env (see above), serves `/health` for probes, and needs only S3 read access to
the enriched prefix (task role or `AWS_*` keys).
