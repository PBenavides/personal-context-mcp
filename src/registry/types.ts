import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Describes a single logical MCP server mounted on the central server.
 *
 * `build` is a factory, never a singleton: in stateless Streamable HTTP mode a
 * fresh {@link McpServer} is created per request, so sharing one instance across
 * concurrent requests would interleave JSON-RPC state.
 */
export interface McpDefinition {
  /** URL base path segment, e.g. `context-layer` → mounted at `/context-layer`. */
  readonly path: string;
  /** MCP server name advertised during `initialize`. */
  readonly name: string;
  /** Semantic version advertised during `initialize`. */
  readonly version: string;
  /** Factory returning a fresh, fully-configured server for a single request. */
  readonly build: () => McpServer;
}
