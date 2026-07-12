# resource-files/

Bundled, read-only data that individual MCPs load at runtime via
`getResourcePath()` (see [`src/utils/directories.ts`](../src/utils/directories.ts)).

`context-layer` is the first consumer: its demo corpus lives at
`resource-files/context-layer/<collection>/*.md`, loaded via
`getResourcePath('context-layer')` from `src/connections/local-corpus.ts` and
searched with BM25 keyword scoring (see [`docs/connections.md`](../docs/connections.md)
and [`docs/context-layer-mcp.md`](../docs/context-layer-mcp.md)). Add another
file-backed MCP's data the same way: drop it under `resource-files/<mcp-name>/`
and load it with `getResourcePath('<mcp-name>/…')`.
