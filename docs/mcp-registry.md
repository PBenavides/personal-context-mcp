# MCP registry & mounting

This is the mechanism that turns "a folder under `src/mcps/`" into a live
`POST /<path>` JSON-RPC endpoint. It's intentionally small and generic —
nothing here knows anything about the specifics of any individual MCP.

## The contract — `src/registry/types.ts`

Every MCP is described by an `McpDefinition`:

```ts
interface McpDefinition {
  readonly path: string;              // URL segment, e.g. "context-layer"
  readonly name: string;              // advertised during MCP `initialize`
  readonly version: string;           // advertised during MCP `initialize`
  readonly build: () => McpServer;    // factory — NOT a singleton
}
```

The key design choice is `build` being a **factory**. In stateless
Streamable HTTP mode (see below), a fresh `McpServer` instance is required
per request; if MCPs exposed a pre-built singleton instead, concurrent
requests would interleave JSON-RPC protocol state on the same object.

## The registry — `src/registry/registry.ts`

```ts
const definitions: readonly McpDefinition[] = [someMcpDefinition];
validateDefinitions(definitions);
export function getRegistry(): readonly McpDefinition[] { return definitions; }
```

`definitions` is the **single list** of every MCP mounted on this host.
`validateDefinitions` runs once at module load (i.e. at process boot) and
throws immediately if:

- any definition has an empty `path`, or
- two definitions share the same `path`.

This is a fail-fast guard: a misconfigured registry crashes the process on
startup rather than silently shadowing routes or mounting something at `/`.

### Adding a new MCP

1. Create `src/mcps/<name>/index.ts` exporting an `McpDefinition`: a
   `buildServer()` function that constructs and configures a fresh
   `McpServer` (registering whatever tools that MCP needs), plus a
   definition object using `getAppVersion()` for the version.
2. Add the import and the definition to the `definitions` array in
   `src/registry/registry.ts`.

That's the entire integration surface — the host (`server.ts`) and mounting
logic (`mount.ts`) never change when an MCP is added.

## Mounting — `src/registry/mount.ts`

`mountMcp(server, def)` registers three routes at `/<def.path>`:

- **`POST`** — the actual JSON-RPC endpoint. Per request:
  1. `reply.hijack()` — hands response control to the raw Node `res`, since
     the MCP SDK's transport writes directly to it; Fastify must not also
     send a reply.
  2. `def.build()` — a **fresh** `McpServer` for this request only.
  3. A new `StreamableHTTPServerTransport` with
     `sessionIdGenerator: undefined` (stateless — no session ID negotiation)
     and `enableJsonResponse: true` (respond with a single JSON body rather
     than an SSE stream).
  4. `mcp.connect(transport)`, then `transport.handleRequest(request.raw, reply.raw, request.body)`.
  5. Teardown (`transport.close()` + `mcp.close()`) is registered on the raw
     response's `'close'` event, guarded by a `closed` flag so it only runs
     once — this is what frees the per-request `McpServer`/transport
     regardless of how the request ends.
  6. Errors during any of this are caught, logged with the MCP name, and —
     only if headers haven't already been sent — answered with a JSON-RPC
     `-32603` ("Internal server error") over a raw `500` write.
- **`GET`** and **`DELETE`** — both return `405` with a JSON-RPC `-32000`
  ("Method not allowed") body. Stateless mode has no SSE stream to `GET` and
  no session to tear down via `DELETE`, so these methods are simply
  unsupported (as opposed to stateful MCP transports, which use them for
  server-push and session cleanup respectively).

### Why stateless

Each request is fully self-contained: no session affinity, no shared
in-flight protocol state between requests, so any instance of this service
can handle any request — a plain, horizontally-scalable HTTP service.
Building a full `McpServer` per request sounds expensive, but the convention
is for each MCP's underlying data to be loaded once and cached at module
scope, so `build()` itself stays cheap — it just wires already-loaded data
into tool handlers.

## Discovery

`getRegistry()` is also what powers the `GET /` discovery endpoint
(`src/routes.ts`) — the management surface and the MCP mounting mechanism
share the exact same source of truth, so discovery can never drift from
what's actually mounted.
