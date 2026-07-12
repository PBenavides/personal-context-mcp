# Current gaps — validation against the `mcp-server-dev` plugin

Point-in-time validation of `src/` against the `build-mcp-server` guidance for
remote streamable-HTTP MCP servers on the official TypeScript SDK — the shape
this service uses. Updated after the connection layer + `context-layer` MCP and
the runtime scaffolding landed.

## Resolved since the last review

- **`context-layer` no longer depends on Qdrant or Vertex AI.** The vector
  search + embeddings backend is replaced by a local, filesystem-backed BM25
  corpus: `src/connections/bm25.ts` (dependency-free scoring) and
  `src/connections/local-corpus.ts` (a real `Connection<LocalCorpusIndex>`,
  following the `postgres.ts` scaffold recipe). `@qdrant/js-client-rest` and
  the already-dead `google-auth-library` are removed from `package.json`. The
  demo corpus lives at `resource-files/context-layer/<collection>/*.md`
  (three collections: `general-knowledge-demo`, `people-ops-sensitive-demo`,
  `uncurated-demo` — demo content only, not real Taxfix knowledge). The
  `SearchStrategy` plugin interface lost its Vertex/Qdrant-specific fields
  (`taskType`, `buildFilter`); `searches/taxlaw.ts` was deleted as its
  Notion-payload-specific narrative no longer applies to the uniform demo
  document shape, while `people-operations.ts` was kept and repurposed to
  still demonstrate the plugin mechanism (a conservative, shorter snippet).
  `agentgateway/config.example.yaml` and `docker-compose.yaml` had their now-dead
  `/v1/embeddings`/`/vertex` routes and Vertex credential wiring removed,
  keeping only the `/context-layer` proxy route. See
  [Connections](./connections.md) and [`context-layer` MCP](./context-layer-mcp.md).
  This supersedes the Qdrant/Vertex smoke-test narrative in "Verified
  end-to-end" below and the "Search-strategy payload tuning" follow-up, which
  no longer applies.
- **Decoupled from the private `@taxfix/*` npm packages.** `createServer`/
  `createLogger` (`@taxfix/api-utils-fastify`) and the OpenAPI-driven
  management surface (`@taxfix/core-schemas-fastify`/`-sdk`) are replaced by
  `src/fastify-factory.ts`, `src/logger.ts`, `src/auth.ts`, and a plain
  `registerManagementRoutes()` in `src/routes.ts`, all built from public
  packages only. `.npmrc` is gone; `npm install`/`npm ci` need no `NPM_TOKEN`.
- **Runtime scaffolding now exists.** `package.json`, `tsconfig.json`,
  `jest.config.mjs`, ESLint/Prettier, `config/*.json`, `resource-files/`,
  `Dockerfile`/`.dockerignore`, and a wired `Makefile` are all present.
  `.env` is now gitignored (it previously held a real Qdrant key un-ignored).
- **Gap #1 — tool annotations: FIXED.** All three `context-layer` tools set
  `annotations: { readOnlyHint: true }`.
- **Gap #2 — DNS-rebinding / Origin validation: ADDRESSED.**
  `src/registry/mount.ts` now takes `MountOptions`
  (`enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins`), wired
  from `config.security` in `server.ts`. Default-off for the POC so local
  `inject()` / 127.0.0.1 callers keep working; flip on + populate the allow-lists
  for production. `mount.test.ts` still passes unchanged.
- **Gap #3 — `instructions`: FIXED.** Both MCPs pass an `instructions` one-liner
  in the `McpServer` options (second constructor arg).
- **Gap #4 — unused env vars: RESOLVED.** `QDRANT_*` and `GCP_*` are now consumed
  by the [connection layer](./connections.md); `.env.example` documents the full
  set (incl. `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEX_EMBEDDING_MODEL`).

## What matches the guidance well

- **Deployment model** — remote streamable-HTTP via `@modelcontextprotocol/sdk`,
  stateless per-request transport, structured JSON-RPC errors (not HTML 500s).
- **All three primitives** — `context-layer` implements Tools, a Resource
  (`context-layer://collections`), and a Prompt (`search-knowledge-base`).
- **Tool design** — small tool count, `readOnlyHint` on every read, compact
  (truncated) results, disambiguating descriptions, `.describe()` on every param.
- **Generalizable connection registry** — one `Connection<T>` contract, a single
  fail-fast registry; Postgres proves extension via an inert scaffold, the
  local corpus proves a real non-network implementation.

## Resolved during the first real run

Historical note: at the time, the `@taxfix/*` packages installed from the
**default npm registry** (`registry.npmjs.org`) as a private scope, requiring
an `NPM_TOKEN`. Those packages (and the token requirement) are gone — see the
decoupling entry above. Running the server surfaced and fixed several other
concrete issues along the way:

- **zod v4 is required.** The MCP SDK accepts `^3.25 || ^4`; `package.json`
  pins `zod@^4` (and the one single-arg `z.record()` was changed to the
  zod-4 two-arg form).
- **Qdrant client port.** `@qdrant/js-client-rest` defaults to Qdrant's native
  port 6333 and ignored the URL's `:443`, timing out against the HTTPS ingress.
  `qdrant.ts` now passes `port: null` + `checkCompatibility: false`.
- **`package-lock.json` generated** — commit it so CI can use `npm ci`.

## Verified end-to-end (this change)

`npm test` (full install): **72 passing**, including `server.test.ts`, all
`connections/**`, all `context-layer/**`, `config`, `mount`. The server boots
(`/health`, `/ready`, discovery lists the `context-layer` MCP), and an MCP client against
`POST /context-layer` lists the 3 tools + collections resource + prompt, and
successfully runs `search_context` live: query → Vertex `gemini-embedding-001`
(`europe-west4`) → Qdrant → relevant hits (e.g. "Werbungskosten" → `§ 9 EStG`).

## Remaining gaps / follow-ups

1. ~~Search-strategy payload tuning for the live `taxlaw` Qdrant payloads.~~
   Superseded — Qdrant is gone (see "Resolved since the last review" above).
2. **Real content population.** The current corpus under
   `resource-files/context-layer/` is demo/test content only. Populating real
   Taxfix knowledge-base content (e.g. exported from Notion) is a separate
   follow-up task.
