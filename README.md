# txf-context-mcp — documentation

`txf-context-mcp` is Taxfix's central **Model Context Protocol (MCP) hosting
service**, owned by `@taxfix/ai-engineering` (domain `tech-foundation`, see
[`catalog-info.yaml`](../catalog-info.yaml)). It is one deployable Fastify
application that hosts many independent, self-contained MCP servers behind a
shared management surface (health, readiness, discovery).

## Why this exists

Coding agents need access to various pieces of Taxfix-specific knowledge via
the Model Context Protocol. Rather than standing up a separate deployable per
knowledge domain, this service hosts them all: each MCP is added as a small,
isolated module and mounted at its own URL path. Operational concerns (auth,
logging, health checks, discovery) are handled once, centrally, so each MCP
only has to implement its own tools and data.

## Architecture at a glance

```
                     ┌─────────────────────────────────────────┐
                     │              Fastify host                │
                     │  (src/fastify-factory.ts createServer)    │
                     │                                           │
  GET /health ───────┤  management surface (plain routes)       │
  GET /ready  ───────┤  - registered in src/routes.ts            │
  GET /       ───────┤                                           │
                     │                                           │
  POST /<mcp-a> ─────┤  MCP routes (raw JSON-RPC, one per        │
  POST /<mcp-b> ─────┤  registered MCP, mounted by                │
  POST /<mcp-…> ─────┤  src/registry/mount.ts)                    │
                     └─────────────────────────────────────────┘
```

Two things define the shape of this codebase:

1. **One host, many MCPs.** [`src/registry/registry.ts`](../src/registry/registry.ts)
   is the single list of MCPs mounted on the server. Each MCP lives under
   `src/mcps/<name>/` and knows nothing about the others or about the host —
   see [MCP registry & mounting](./mcp-registry.md). Currently mounted:
   [`context-layer`](./context-layer-mcp.md) (local BM25 keyword search).
2. **Stateless, per-request MCP servers.** There is no session affinity: a
   fresh `McpServer` + transport is built for *every* incoming request. Only
   read-only cached data and shared connection clients are reused across
   requests. See [Server & hosting](./server-and-hosting.md).
3. **Generalizable connection layer.** External dependencies (a local
   filesystem corpus and a Postgres scaffold) are reached through a uniform
   `Connection<T>` registry — see [Connection layer](./connections.md).

## Current state (important context)

This repository was generated from Taxfix's standard service template and then
had a TypeScript implementation added under `src/` (currently on the
`ts-implementation` branch, not yet merged). The runtime scaffolding now exists:
`package.json`, `tsconfig.json`, `jest.config.mjs`, ESLint/Prettier,
`config/*.json`, `resource-files/`, `Dockerfile`/`.dockerignore`, and a
wired `Makefile`.

All dependencies are public — `npm ci`/`build`/`test` need no `NPM_TOKEN` or
private-registry credentials. See [Current gaps](./current-gaps.md) for the
full validation history.

## Reading order

- [Server & hosting](./server-and-hosting.md) — the Fastify host, config,
  context, logging, the management surface.
- [MCP registry & mounting](./mcp-registry.md) — how MCPs are declared,
  validated, and mounted as stateless JSON-RPC routes; how to add a new one.
- [Connection layer](./connections.md) — the generalizable `Connection<T>`
  registry (local corpus, Postgres scaffold); how to add a kind.
- [`context-layer` MCP](./context-layer-mcp.md) — the local BM25 keyword-search
  MCP; Tools/Resource/Prompt, the evolvable `searches/` folder.
- [Development & operations](./development-and-operations.md) — Makefile,
  CI/CD, versioning/release-please, ownership, and known gaps.
- [Current gaps](./current-gaps.md) — validation against the `mcp-server-dev`
  plugin's guidance; what's fixed and what's still outstanding.
