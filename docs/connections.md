# Connection layer

The connection layer is the generalizable way MCPs reach external dependencies
(a local corpus, relational DBs). It lives under
[`src/connections/`](../src/connections/) and is deliberately small and uniform
so new dependency kinds can be added without touching anything that consumes
them — the same "one contract, one registry, fail-fast" shape as the
[MCP registry](./mcp-registry.md).

## The contract — `src/connections/types.ts`

Every dependency is a `Connection<TClient>`:

```ts
interface Connection<TClient> {
  readonly name: string;        // unique registry key, e.g. "local-corpus"
  readonly kind: ConnectionKind; // 'local-corpus' | 'postgres'
  get(): TClient;                // build once (memoised); throws if unconfigured
  healthCheck(): Promise<ConnectionHealth>; // never throws — reports ok:false
  close(): Promise<void>;        // release pools/sockets; no-op for HTTP/in-memory clients
}
```

`ConnectionRegistry` is the set handed to consumers: typed `localCorpus` /
`postgres` fields plus generic `all()` and `healthCheckAll()`.

## The registry — `src/connections/registry.ts`

```ts
getConnections(): ConnectionRegistry  // lazy, process-wide singleton from appConfig
```

`getConnections()` builds the registry **once** from `appConfig.connections` and
caches it at module scope. `createConnections(config)` is the pure builder (used
by tests); `validateConnections()` throws on empty/duplicate `name` at build
time, mirroring `validateDefinitions()` in the MCP registry.

Why module-scoped rather than dependency-injected through `build()`: the MCP
transport creates a fresh `McpServer` **per request**, but the underlying
corpus index is read once and expensive to rebuild, so it is memoised and
shared across requests. `resetConnections()` exists for tests only.

## The connections

| Connection | `kind` | Client | Notes |
|---|---|---|---|
| `localCorpus` | `local-corpus` | `LocalCorpusIndex` | `get()` throws if `rootDir` is missing/nonexistent; `healthCheck` reports collection/document counts. |
| `postgres` | `postgres` | — | **Scaffold.** `get()` always throws; the file is the annotated template for adding a new kind. |

### The local corpus — BM25 keyword search over files

[`local-corpus.ts`](../src/connections/local-corpus.ts) reads a directory of
markdown/text files: one subdirectory per collection, recursed for `.md`/`.txt`
files. The corpus is static and baked into the Docker image, so the index
(built by [`bm25.ts`](../src/connections/bm25.ts), a small dependency-free BM25
implementation — tokenizer, inverted index, `k1=1.2`/`b=0.75` scoring) is
built **once**, on first `get()`, with no file-watching or hot-reload.

- **`rootDir` resolution** — relative paths resolve against `resource-files/`
  (via `getResourcePath()`); absolute paths (e.g. a test's temp fixture
  directory) are used as-is. The production default (`config/default.json`)
  is `"context-layer"`, resolving to `resource-files/context-layer/`.
- **Document shape** — every document is uniform: `{ id, collection, title,
  path, content }`. `title` comes from the first markdown `# heading`, else
  the filename. There is no per-document-type payload schema to account for
  (unlike Qdrant's per-collection payloads previously).
- **`healthCheck`** — reports `ok: true` with collection/document counts once
  the corpus root exists and is a directory (even if it currently has zero
  collections — an empty corpus is valid, not a misconfiguration); `ok: false,
  detail: 'not configured'` if `rootDir` is empty/nonexistent/not a directory.
- **No embeddings, no external AI provider (v1).** Retrieval is BM25 keyword
  scoring only — no stemming, no fuzzy matching, no semantic search. This may
  be added later as a second connection kind if needed; nothing here builds
  toward that speculatively.

### Testability

Every factory takes an optional `deps` bag with sane defaults (`readCorpus`
for the local corpus) so tests inject fakes without ESM module mocking. See
`*.test.ts` next to each module. `local-corpus.test.ts` also exercises the
real filesystem via `fs.mkdtempSync` fixtures for the discovery/indexing paths
that are cheap and deterministic to run for real.

## Adding a new connection kind

`postgres.ts` documents the full recipe. In short: copy it, add the
`ConnectionKind` literal in `types.ts`, add a config block in `config.ts` +
`config/*.json`, implement `get()`/`healthCheck()`/`close()`, register it in
`createConnections()`, and (if callers need typed access) add a field to
`ConnectionRegistry`. Add DI-based unit tests.

## Configuration

Read from `appConfig.connections` (see [Server & hosting](./server-and-hosting.md)),
which the `config` package populates from `config/default.json` +
`config/custom-environment-variables.json` (env vars
`CONTEXT_LAYER_CORPUS_ROOT`, `DATABASE_URL`). Secrets come from the
environment (`.env` locally, which is gitignored; k8s secrets in production).
