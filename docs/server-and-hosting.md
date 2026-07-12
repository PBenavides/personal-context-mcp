# Server & hosting

This covers everything outside `src/mcps/` and `src/registry/`: how the
Fastify application is assembled, configured, and exposes its management
surface. See [MCP registry & mounting](./mcp-registry.md) for how individual
MCPs get attached to it.

## Boot sequence — `src/index.ts`

```ts
const context = createContext(appConfig);
const server = await buildServer(context);
await server.listen({ port: appConfig.port, host: '0.0.0.0' });
```

Three steps: load config, build the app context (logger), build the Fastify
instance. `buildServer` deliberately does **not** call `listen` — see below.

## Configuration — `src/config.ts`

`appConfig` is populated from the [`config`](https://www.npmjs.com/package/config)
npm package, following Taxfix's standard convention: values come from
`config/default.json` plus environment overlays and
`config/custom-environment-variables.json` (none of these files exist in the
repo yet — see [Development & operations](./development-and-operations.md)).

Three keys are read:

| Key | Type | Purpose |
|---|---|---|
| `port` | `number \| string` | HTTP listen port, coerced to `Number`. |
| `jwt.jwksUri` | `string?` | JWKS endpoint for JWT verification. Empty/unset means **auth is unenforced** — `src/config.ts` calls this out as a deliberate phase-1 state. |
| `logger.level` | `string` | Log level passed to `createLogger`. |

`AppConfig` is the single typed surface the rest of the app depends on —
nothing else touches the `config` package directly.

## App context — `src/context.ts`

`createContext(config)` builds an `AppContext { config, logger }`. The logger
is created via `src/logger.ts`'s `createLogger` (a `pino` instance, formatted
for Cloud Logging outside tests), named and
versioned from `packageInfo()` (see [Versioning](#versioning--srcversionts)
below) so log output self-identifies as this service at its current version.
`AppContext` is threaded through `buildServer` rather than each module
importing `appConfig`/a logger singleton directly — this is what makes
`server.test.ts` able to build a full server without touching global state.

## Building the Fastify instance — `src/server.ts`

`buildServer(context)` does three things, in order:

1. **`createServer()`** from `src/fastify-factory.ts` — the Taxfix-standard
   Fastify factory, built from public `@fastify/*` packages. It provides,
   out of the box: request logging, correlation-id propagation, `helmet`
   security headers, OpenTelemetry instrumentation (`@fastify/otel`), a
   shared error handler, and JWT verification wiring via `src/auth.ts`
   (driven by `context.config.jwt`; unenforced while `jwksUri` is unset).
2. **`registerManagementRoutes()`** from `src/routes.ts` — registers the
   management surface (`/health`, `/ready`, `/`) as plain Fastify routes.
3. **Mount every registered MCP** — `for (const def of getRegistry()) mountMcp(server, def)`.
   See [MCP registry & mounting](./mcp-registry.md).

`buildServer` calls `server.ready()` and returns the instance **without**
calling `listen()`. This is intentional: tests (`server.test.ts`) drive the
app via `server.inject()`, which needs a ready-but-not-listening instance;
`index.ts` is the only caller that actually binds a port.

## Management surface

The management surface is deliberately kept out of the MCP JSON-RPC world —
it's plain REST/JSON, registered directly (no OpenAPI spec generation).

### Handlers — `src/routes.ts`

`registerManagementRoutes(server)` registers three plain Fastify routes:

- `GET /health` → `{ status: 'ok' }` (pure liveness — always succeeds if the
  process is up).
- `GET /ready` → `{ status: 'ready' }` (currently equivalent to health;
  there's no dependency check yet).
- `GET /` → reads `getRegistry()` and returns each MCP's
  `name`, `version`, and `path` (prefixed with `/`) — this is how a client
  (or a human) finds out what MCPs are mounted on a given deployment without
  reading source code.

The MCP JSON-RPC endpoints (e.g. `POST /<mcp-name>`) are intentionally
**not** part of this surface — they're raw routes mounted separately, since
they speak JSON-RPC 2.0 / MCP protocol, not this service's REST conventions.

## Versioning — `src/version.ts`

`packageInfo()` reads `name`/`version` straight from the service's own
`package.json` (via `getRepoPath('package.json')`), caching the result.
`getAppVersion()` exposes just the version string. This value is used for:

- the logger's identity (`context.ts`)
- **every** mounted MCP's advertised version (see
  [MCP registry & mounting](./mcp-registry.md)) — MCPs are versioned
  service-wide, not independently, so a `package.json` bump (driven by
  release-please) updates all of them at once with no per-MCP bookkeeping.

## Path resolution — `src/utils/directories.ts`

`getRepoPath(relative)` resolves a path relative to the package root in a
way that works identically whether the code is running from `src/`
(ts-jest, during tests) or from a built `dist/` (production) — both live two
directories below the package root, so `path.join(currentDir, '..', '..', relative)`
lands in the same place either way. `getResourcePath(relative)` is a thin
wrapper for the bundled `resource-files/` directory, which is where per-MCP
data files are expected to live at runtime. This directory does not exist in
the repo yet — see [Development & operations](./development-and-operations.md).
