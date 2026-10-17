# Personal context MCP

A Fastify host that serves **multiple MCP servers** over streamable HTTP, deployed
on a DigitalOcean droplet. It is the read/act surface over Pablo's personal data:
an Obsidian vault classified into a 14-category taxonomy (plus an OWL ontology of
the same), and his personal SaaS accounts.

Three MCPs are mounted today:

| Route | What it exposes |
|---|---|
| `POST /personal-context` | The enriched corpus — vault notes + activity events. Semantic search (S3 Vectors) with a BM25 fallback, plus ontology tools. |
| `POST /personal-tools` | The action layer — YNAB, Hevy, Google Calendar. |
| `POST /doctolib` | Read-only Doctolib appointment search (no credentials). See [`docs/doctolib.md`](docs/doctolib.md). |

This repo is one of four in the `Project2026` workspace. The pipeline that
*produces* the data lives in `context-pipeline/`, the AWS resources in
`personal-infra/context/`, and the plans and decision records in `fable_plans/`.
**Read `fable_plans/00_MASTER_PLAN.md` before changing anything cross-repo**, and
don't change the S3/API contracts unilaterally.

## Start here

Pick the doc for the layer you're touching — each is the authority for its area.

| Doc | Answers |
|---|---|
| [`docs/mcp-registry.md`](docs/mcp-registry.md) | How a folder under `src/mcps/` becomes a live endpoint. **Read this first if you're adding an MCP.** |
| [`docs/connections.md`](docs/connections.md) | How MCPs reach external dependencies; the `Connection` contract and registry. Read before adding a dependency. |
| [`docs/personal-context-mcp.md`](docs/personal-context-mcp.md) | The corpus MCP: tools, search behaviour, corpus shape. |
| [`docs/personal-tools.md`](docs/personal-tools.md) | The action MCP: YNAB / Hevy / Google Calendar tool surface and write semantics. |
| [`docs/ontologies.md`](docs/ontologies.md) | The OWL layer — classes, individuals, RDF/XML persistence, versioning. |
| [`docs/cron-and-parsing.md`](docs/cron-and-parsing.md) | When the ontology injector runs and how documents become typed assertions. |
| [`docs/server-and-hosting.md`](docs/server-and-hosting.md) | Everything outside the MCPs: app assembly, config, auth, management routes. |
| [`docs/CICD.md`](docs/CICD.md) | How a change reaches production. Nothing lands on `main` except via PR. |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Release process and the link to the Terraform root. |

## Directory map

```
src/
  index.ts, server.ts, fastify-factory.ts   app entry, assembly, wiring
  routes.ts        /health, /ready, MCP discovery at /
  config.ts        typed config; see config/ below
  auth.ts          static bearer guard on MCP routes (empty token = off, local dev)
  connections/     one module per external dependency (enriched corpus, vector
                   search, BM25, ontology store, YNAB, Hevy, Calendar,
                   OpenRouter) + the registry that builds and probes them
  mcps/            one folder per MCP: index.ts registers tools, tools.ts holds
                   the handlers as pure functions over an injected client
  registry/        turns an mcps/ folder into a mounted JSON-RPC route
  ontology/        OWL model, RDF/XML (de)serialization, search, injector, hourly scheduler
  visual-ontologies/  GET /visual-ontologies — browser view of the graph
  utils/           frontmatter parsing, path helpers

config/    node-config layer: default.json + custom-environment-variables.json
           (env var → config key mapping) + test.json. Secrets come from env
           (SSM in production), never from code.
data/      committed ontology artifacts (schema.owl, data.rdf, versions/)
docs/      the table above
scripts/   mcp_smoke.sh (endpoint smoke test), roll_image.sh
tests/     shared fixtures; unit tests live next to their source as *.test.ts
```

## Conventions

- **Tests sit beside the code** (`foo.ts` → `foo.test.ts`) and run against fakes,
  not the network. Handlers take their client as an argument for exactly this
  reason — keep new ones that way.
- **Connections own auth and transport only.** Endpoint paths, pagination and
  response shaping belong in the MCP's `tools.ts`.
- **Unconfigured dependencies degrade cleanly**: an empty credential disables its
  tools rather than crashing the host, so credential-free dev runs work.
- ESM with NodeNext — relative imports carry a `.js` extension even in TypeScript.

## Commands

```bash
npm run dev        # watch mode
make verify        # typecheck + lint + test + smoke — the CI gate; run before a PR
```

`make verify` is what CI runs. Its `smoke` step boots the server on :3999 against
the fixture corpus and drives it over real JSON-RPC, so it needs no credentials
and never touches S3 or the droplet. Individual steps are available as
`npm run typecheck` / `npm run lint` / `npm test` / `npm run build`.

## Operational care

`terraform apply` and `deploy/deploy.sh` mutate the live AWS account and write to
the shared production droplet. Surface the exact command for a human to run
rather than working around a denial. `make release`, SSM reads, `terraform plan`
and laptop-side batch runs are fine to run directly.

Tools that write to a third-party account (`hevy_write_routine`, `ynab_assign`,
`ynab_write_transaction`, `ynab_write_category`, `gcal_create_event`) affect real
records. Several of those APIs have no delete. Prefer `dry_run` where a tool
offers it, and confirm before committing a write.
