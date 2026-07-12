# personal-context-mcp

MCP server exposing Pablo's enriched personal context — Obsidian vault notes
and activity events, classified by the
[context-pipeline](../context-pipeline/) into a closed 14-category taxonomy —
over **streamable HTTP** with **BM25 search**.

```
s3://…/context-enriched/  ──(boot load + run_id refresh)──►  in-memory corpus
                                                                   │
client ──POST /personal-context (Bearer token)──►  search_context / get_document / list_taxonomy
```

## Tools (MCP `personal-context`, mounted at `/personal-context`)

| Tool | Purpose |
|---|---|
| `search_context({query, category?, status?, horizon?, limit?})` | BM25 over notes + events, filtered by taxonomy metadata; compact hits with `path`, `score`, `category`, `summary`, `snippet`. |
| `get_document({path, full?})` | Full document (frontmatter + body) or a bounded preview. |
| `list_taxonomy()` | Categories with document counts + taxonomy/manifest versions. |

Details: [docs/personal-context-mcp.md](docs/personal-context-mcp.md). The
hosting architecture (per-request stateless transport, MCP registry,
connection layer) is documented in [docs/](docs/).

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
