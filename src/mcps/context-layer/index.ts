import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConnections } from '../../connections/registry.js';
import type { McpDefinition } from '../../registry/types.js';
import { getAppVersion } from '../../version.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { describeCollection, listCollections, searchContext } from './tools.js';

const NAME = 'context-layer';
// Sourced from package.json — MCPs are versioned service-wide (see getAppVersion).
const VERSION = getAppVersion();

const INSTRUCTIONS =
  'Keyword (BM25) search over Taxfix knowledge bases stored in a local corpus. Start with ' +
  'list_collections (or the context-layer://collections resource) to choose a collection, then ' +
  'call search_context with a natural-language query.';

interface TextResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function textResult(text: string, isError = false): TextResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

function jsonResult(data: unknown): TextResult {
  return textResult(JSON.stringify(data, null, 2));
}

function errorResult(prefix: string, error: unknown): TextResult {
  return textResult(
    `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    true,
  );
}

/**
 * Builds a fresh context-layer MCP server. Tools run BM25 keyword search over the local corpus;
 * the connection is a shared module-scoped singleton (see `getConnections`), so building per
 * request stays cheap under the stateless transport. Handler logic lives in `./tools.js`
 * (unit-tested with injected fakes); registration here stays thin.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_collections',
    {
      title: 'List collections',
      description:
        'List the local corpus collections currently available for search, read live from disk (each with a short description). Call this first to choose a collection for search_context.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return jsonResult(listCollections(getConnections().localCorpus.get()));
      } catch (error) {
        return errorResult('Failed to list collections', error);
      }
    },
  );

  server.registerTool(
    'describe_collection',
    {
      title: 'Describe collection',
      description:
        'Return catalog metadata, live document count, and the search-strategy description for one collection.',
      inputSchema: {
        collection: z.string().describe('Collection name from list_collections'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ collection }) => {
      try {
        return jsonResult(
          describeCollection(getConnections().localCorpus.get(), collection),
        );
      } catch (error) {
        return errorResult('Failed to describe collection', error);
      }
    },
  );

  server.registerTool(
    'search_context',
    {
      title: 'Search context',
      description:
        'Keyword (BM25) search within a collection: returns the best-matching documents with compact payloads. Pick the collection with list_collections first.',
      inputSchema: {
        collection: z
          .string()
          .describe('Target collection name (see list_collections)'),
        query: z.string().describe('Natural-language search query'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Max results (default 5, max 25)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ collection, query, limit }) => {
      try {
        return jsonResult(
          searchContext(
            { corpus: getConnections().localCorpus.get() },
            { collection, query, limit },
          ),
        );
      } catch (error) {
        return errorResult('Search failed', error);
      }
    },
  );

  registerResources(server);
  registerPrompts(server);
  return server;
}

export const contextLayerDefinition: McpDefinition = {
  path: NAME,
  name: NAME,
  version: VERSION,
  build: buildServer,
};
