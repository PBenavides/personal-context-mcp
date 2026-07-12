import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConnections } from '../../connections/registry.js';
import type { McpDefinition } from '../../registry/types.js';
import { getAppVersion } from '../../version.js';
import { getDocument, listTaxonomy, searchContext } from './tools.js';

const NAME = 'personal-context';
// Sourced from package.json — MCPs are versioned service-wide (see getAppVersion).
const VERSION = getAppVersion();

const INSTRUCTIONS =
  "Keyword (BM25) search over Pablo's enriched personal context: Obsidian vault notes and " +
  'activity events, classified into a closed 14-category taxonomy (Goal, Project, Person, ' +
  'Habit, Event, …) with horizon/status/salience metadata. Call list_taxonomy to see what ' +
  'exists, search_context to find documents, then get_document for full content.';

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
 * Builds a fresh personal-context MCP server. Tools run BM25 search over the in-memory enriched
 * corpus; the connection is a shared module-scoped singleton (see `getConnections`), so building
 * per request stays cheap under the stateless transport. Handler logic lives in `./tools.js`
 * (unit-tested with fixture corpora); registration here stays thin.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: NAME, version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'search_context',
    {
      title: 'Search personal context',
      description:
        'Keyword (BM25) search over the enriched personal-context corpus (vault notes + activity ' +
        'events). Optional exact-match filters on the taxonomy metadata: category (see ' +
        'list_taxonomy), status (proposed|active|dormant|done), horizon ' +
        '(closing|near|mid|far|standing|deferred|cadence|past). Returns compact hits — follow up ' +
        'with get_document for full content.',
      inputSchema: {
        query: z.string().describe('Natural-language search query'),
        category: z.string().optional().describe('Filter to one taxonomy category, e.g. Goal'),
        status: z.string().optional().describe('Filter by status, e.g. active'),
        horizon: z.string().optional().describe('Filter by horizon, e.g. standing'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('Max results (default 10, max 25)'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(searchContext(getConnections().enrichedCorpus.get(), args));
      } catch (error) {
        return errorResult('Search failed', error);
      }
    },
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get document',
      description:
        'Fetch one enriched document by path (from search_context results). full=true (default) ' +
        'returns the complete content including frontmatter; full=false returns a bounded body preview.',
      inputSchema: {
        path: z.string().describe('Document path, e.g. notes/foo.md'),
        full: z.boolean().optional().describe('Full content (default) vs. bounded preview'),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        return jsonResult(getDocument(getConnections().enrichedCorpus.get(), args));
      } catch (error) {
        return errorResult('Failed to get document', error);
      }
    },
  );

  server.registerTool(
    'list_taxonomy',
    {
      title: 'List taxonomy',
      description:
        'The taxonomy as materialized in the current corpus: each category with its document ' +
        'count, plus the taxonomy version and manifest run id. Cheap — call it first to form queries.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return jsonResult(listTaxonomy(getConnections().enrichedCorpus.get()));
      } catch (error) {
        return errorResult('Failed to list taxonomy', error);
      }
    },
  );

  return server;
}

export const personalContextDefinition: McpDefinition = {
  path: NAME,
  name: NAME,
  version: VERSION,
  build: buildServer,
};
