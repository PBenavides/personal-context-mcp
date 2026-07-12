# Connection layer

The connection layer is the generalizable way MCPs reach external dependencies.
It lives under [`src/connections/`](../src/connections/) and is deliberately
small and uniform so new dependency kinds can be added without touching
anything that consumes them — the same "one contract, one registry, fail-fast"
shape as the [MCP registry](./mcp-registry.md).

## The contract — `src/connections/types.ts`

Every dependency is a `Connection<TClient>`:

```ts
interface Connection<TClient> {
  readonly name: string;        // unique registry key, e.g. "enriched-corpus"
  readonly kind: ConnectionKind;
  get(): TClient;                // returns the memoised client; throws if not ready
  healthCheck(): Promise<ConnectionHealth>; // never throws — reports ok:false
  close(): Promise<void>;        // release timers/pools/sockets
}
```

`ConnectionRegistry` is the set handed to consumers: a typed `enrichedCorpus`
field plus generic `all()` and `healthCheckAll()`.

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
| `enrichedCorpus` | `enriched-corpus` | `EnrichedCorpusIndex` | Loaded at boot (`load()`), refreshed in the background; `get()` throws before the first load. |

### The enriched corpus — the pipeline's output layer, in memory

[`enriched-corpus.ts`](../src/connections/enriched-corpus.ts) consumes the
contract the context-pipeline writes (`fable_plans/02_…` §"Output contract"):

```
<root>/manifest.json                             # taxonomy_version, run_id, files map
<root>/notes/<vault-relative-path>.md            # enriched frontmatter + original body
<root>/events/english-collector/<iso-date>.json  # one day of activity events
```

Two sources implement one tiny reader contract (`readText(key)`):

- **`file`** — a local directory; relative `rootDir` resolves against the
  process cwd. Used for `tests/fixtures/enriched/` so jest and the smoke
  script run with **zero AWS credentials**.
- **`s3`** — AWS SDK v3 (`@aws-sdk/client-s3`, lazily imported) against
  `CONTEXT_BUCKET`/`CONTEXT_PREFIX` in `AWS_REGION`, using the default
  credential chain (env keys, profile, or task role).

Lifecycle:

1. **Boot** — `index.ts` awaits `load()` before `listen()`: the manifest and
   every listed document are read into memory and indexed with
   [`bm25.ts`](../src/connections/bm25.ts) (a small dependency-free BM25:
   tokenizer, inverted index, `k1=1.2`/`b=0.75`). A failed load crashes the
   process (fail fast; the container restarts).
2. **Refresh** — `startRefresh()` re-reads only `manifest.json` every
   `REFRESH_SECONDS` (default 300; `0` disables) and reloads the corpus only
   when `run_id` changed, swapping the snapshot atomically. A failed refresh
   logs a warning and keeps serving the previous snapshot.
3. **Search** — `search(query, filters, limit)` scores the whole (small)
   corpus, then applies case-insensitive `category`/`status`/`horizon`
   equality filters, so a narrow filter still returns the best matches.

Document normalization: notes are split into YAML frontmatter + body
(`src/utils/frontmatter.ts`; malformed frontmatter degrades to an empty
metadata object instead of throwing). Event JSON files become one document per
day with `horizon: past`, `status: done` defaults and a text rendering of the
day's events as the searchable body.

## Adding a new connection kind

Implement the `Connection<T>` interface in a new `src/connections/<kind>.ts`,
add the `ConnectionKind` literal and a config block, register it in
`createConnections()`, and unit-test it with injected fakes (see
`enriched-corpus.test.ts` — no ESM module mocking).
