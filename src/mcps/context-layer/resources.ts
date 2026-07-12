import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { getConnections } from '../../connections/registry.js';
import { discoverCollections } from './discovery.js';
import { describeCollection } from './tools.js';

const CATALOG_URI = 'context-layer://collections';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Registers the collection catalog as MCP Resources — a live discovery entry point in resource form:
 *  - `context-layer://collections` — the live catalog (JSON), read from the local corpus on each request.
 *  - `context-layer://collections/{name}` — one collection's curated metadata + live doc count + strategy.
 */
export function registerResources(server: McpServer): void {
  server.registerResource(
    'collections',
    CATALOG_URI,
    {
      title: 'Available collections',
      description:
        'Live catalog of local-corpus collections searchable via this MCP (read from disk on each request). Read this first to choose a collection for search_context.',
      mimeType: 'application/json',
    },
    async uri => {
      let body: unknown;
      try {
        body = { collections: discoverCollections(getConnections().localCorpus.get()) };
      } catch (error) {
        body = { collections: [], error: `Failed to list collections: ${message(error)}` };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'collection',
    new ResourceTemplate('context-layer://collections/{name}', {
      list: async () => {
        try {
          const listings = discoverCollections(getConnections().localCorpus.get());
          return {
            resources: listings.map(listing => ({
              name: listing.name,
              uri: `context-layer://collections/${listing.name}`,
              description: listing.description,
              mimeType: 'application/json',
            })),
          };
        } catch {
          // Best-effort enumeration — return nothing rather than failing resource discovery.
          return { resources: [] };
        }
      },
    }),
    {
      title: 'Collection detail',
      description:
        'Curated metadata, live document count, and search-strategy description for a single collection.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const raw = variables.name;
      const name = Array.isArray(raw) ? (raw[0] ?? '') : raw;
      let body: unknown;
      try {
        body = describeCollection(getConnections().localCorpus.get(), name);
      } catch (error) {
        body = { error: `Failed to describe collection "${name}": ${message(error)}` };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(body, null, 2),
          },
        ],
      };
    },
  );
}
