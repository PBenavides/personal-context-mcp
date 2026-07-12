# `context-layer` MCP

The `context-layer` MCP ([`src/mcps/context-layer/`](../src/mcps/context-layer/))
exposes BM25 keyword search over a local file corpus. It is the first
MCP to exercise the [connection layer](./connections.md) and the first to
implement all three MCP feature primitives — **Tools, Resources, and Prompts** —
per the [MCP server concepts](https://modelcontextprotocol.io/docs/learn/server-concepts).

Mounted at `POST /context-layer` via the [MCP registry](./mcp-registry.md).

## Retrieval flow

```
query text ──tokenize + BM25 score──> local corpus (resource-files/context-layer/<collection>)
                                              │
                                              ▼
                                strategy-projected hits
```

The corpus connection comes from `getConnections()`; the MCP itself holds no
credentials and makes no network calls.

## The collections — a live view of the local corpus

**The filesystem is the source of truth for what exists.** Collections are
discovered live as subdirectories of the corpus root (via
`corpus.listCollections()` in
[`discovery.ts`](../src/mcps/context-layer/discovery.ts)), so a collection
added on disk is immediately exposed — listable, describable, and searchable
— with **no code change**, though the corpus is baked into the Docker image so
adding one does need a redeploy. A client discovers them two ways:

- **Tool** `list_collections` — the live set of collections right now (each
  with a description and a `curated` flag).
- **Resource** `context-layer://collections` — the same live catalog as JSON,
  plus a per-collection template `context-layer://collections/{name}`.

[`collections.ts`](../src/mcps/context-layer/collections.ts) is **optional
enrichment, not an allow-list**: it adds a human description and a search-strategy
hint for collections we've curated. A live collection without a curated entry is
still fully exposed — it gets a synthesized description and the generic `default`
strategy (`curated: false`). The curated collections today (all demo content —
see [Current gaps](./current-gaps.md)):

| Collection | Strategy |
|---|---|
| `general-knowledge-demo` | `default` |
| `people-ops-sensitive-demo` (sensitive-data example) | `people-operations` |

`uncurated-demo` also ships in the corpus with no `COLLECTIONS` entry, to
demonstrate the live-discovery-only path.

### Hiding collections — the denylist

Because discovery is live, *every* collection (including test/system ones) is
exposed by default. To hide some without a code change, set
`CONTEXT_LAYER_EXCLUDE_COLLECTIONS` (comma-separated; each entry matches a
collection name by substring or regex) — see `contextLayer.excludeCollections`
in [`config.ts`](../src/config.ts). Excluded collections disappear from
`list_collections`, the resources, and search.

### Known limitations (BM25 v1)

No stemming ("deduction" and "deductions" are distinct terms), no fuzzy
matching, and no semantic/embeddings-based search — keyword overlap only. An
embeddings signal could be added later as a second connection kind if needed;
nothing in this design speculatively builds toward that.

## Primitives

### Tools (all `readOnlyHint: true`)

- `list_collections` — orient: which collections exist live and their descriptions.
- `describe_collection` — curated metadata + live document count + the
  collection's search-strategy description.
- `search_context` — BM25 keyword search, returning the best-matching
  documents with compact, strategy-projected payloads. Args: `collection`,
  `query`, `limit?` (default 5, max 25). Unknown collections and empty
  queries return a helpful error result instead of a raw failure.

Kept to three tools (well under the 15-tool guidance). The pure handler logic
lives in [`tools.ts`](../src/mcps/context-layer/tools.ts) and is unit-tested
with injected fakes; [`index.ts`](../src/mcps/context-layer/index.ts) stays a
thin registration layer with an `instructions` one-liner on the server.

### Resource

`context-layer://collections` (+ `.../{name}`) — the collection catalog as JSON,
so hosts that browse resources can discover what's searchable without a tool call.

### Prompt

`search-knowledge-base` (`question`, optional `collection`) — a reusable
template that walks the model through the intended workflow: choose a collection
(via `list_collections`) then call `search_context`, and ground the answer in the
returned payloads.

## Evolvable search — `searches/`

The requirement that search logic "grow over time per document type" is met by
[`searches/`](../src/mcps/context-layer/searches/), where each collection can
have a dedicated `SearchStrategy`:

```ts
interface SearchStrategy {
  key: string;
  collection?: string;
  describe(): string;
  projectPayload(payload): Record<...>;     // trim/shape hits for the context window
}
```

- `default.ts` — generic fallback: size-bounded full-payload projection (long
  strings truncated, arrays capped).
- `people-operations.ts` — example: a shorter, conservative content snippet
  (200 chars vs. the default's 500) for sensitive collections.
- `registry.ts` — maps collection → strategy, falling back to `default`.

To specialise a collection's search: add a strategy file, register it in
`searches/registry.ts`. The tools pick it up automatically — no tool changes.

## The live-discovery principle (applies beyond the local corpus)

The rule this MCP follows: **the data source is the source of truth for what
exists; curated code is only enrichment, never an allow-list.** New targets are
exposed with zero code change. Any future data source should follow the same
shape — e.g. a Postgres MCP should enumerate tables live from `information_schema`
(gated only by an optional denylist), treat any hand-written per-table metadata
as enrichment, and never require a code entry to expose a table. The Postgres
connection today is an inert scaffold ([`postgres.ts`](../src/connections/postgres.ts));
when it's implemented, it should adopt this pattern.

## Testing

`tools.test.ts`, `discovery.test.ts`, `searches/registry.test.ts`, and
`collections.test.ts` cover the logic with a fake `LocalCorpusIndex` (no real
filesystem access needed at this layer), including live-only (uncurated)
collections and the denylist. `src/connections/bm25.test.ts` and
`src/connections/local-corpus.test.ts` cover the BM25 scoring and real
filesystem discovery separately. They run today as part of the suite — see
[Development & operations](./development-and-operations.md).
