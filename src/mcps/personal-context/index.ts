import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getConnections } from '../../connections/registry.js';
import { runSync } from '../../ontology/sync-runner.js';
import type { McpDefinition } from '../../registry/types.js';
import { getAppVersion } from '../../version.js';
import { ontologySearch, ontologyUpdate } from './ontology-tools.js';
import { getDocument, listTaxonomy, searchContext } from './tools.js';

const NAME = 'personal-context';
// Sourced from package.json — MCPs are versioned service-wide (see getAppVersion).
const VERSION = getAppVersion();

const INSTRUCTIONS =
  "Semantic search over Pablo's enriched personal context: Obsidian vault notes and " +
  'activity events, classified into a closed 14-category taxonomy (Goal, Project, Person, ' +
  'Habit, Event, …) with horizon/status/salience metadata. Call list_taxonomy to see what ' +
  'exists, search_context to find documents, then get_document for full content. ' +
  'The same taxonomy also exists as an OWL ontology (RDF/XML in S3, /visual-ontologies ' +
  'dashboard): ontology_search retrieves typed nodes+edges, ontology_update edits the graph, ' +
  'and ontology_sync routes new vault content into it — answer its pending questions by ' +
  'calling it again with `guidance`.';

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
        'Semantic (embedding) search over the enriched personal-context corpus (vault notes + ' +
        'activity events); falls back to BM25 keyword ranking if the vector index is ' +
        'unavailable. Optional exact-match filters on the taxonomy metadata: category (see ' +
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
        const { enrichedCorpus, vectorSearch } = getConnections();
        return jsonResult(await searchContext(enrichedCorpus.get(), vectorSearch.maybe(), args));
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

  const nodeInputSchema = z.object({
    id: z.string().describe('Node id: lowercase slug (a-z, 0-9, hyphens); reuse to enrich'),
    class: z.string().describe('Ontology class, e.g. Project, Person, Goal'),
    label: z.string().optional().describe('Human-readable name'),
    attributes: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
      )
      .optional()
      .describe('Datatype properties, e.g. {"summary": "...", "status": "active"}'),
  });
  const edgeInputSchema = z.object({
    subject: z.string(),
    predicate: z.string().describe('Object property, e.g. contributesTo, involvesPerson'),
    object: z.string(),
  });

  server.registerTool(
    'ontology_search',
    {
      title: 'Search the ontology',
      description:
        'Retrieval over the personal-context OWL ontology (the graph the injector builds from ' +
        'the vault). Ranks nodes by embedding similarity (keyword fallback), then expands the ' +
        'neighborhood: returns matched nodes with attributes and created/modified timestamps, ' +
        'plus surrounding edges and neighbor nodes. Params: classes (filter matches), limit ' +
        '(default 10), hops (neighbor expansion 0-2, default 1).',
      inputSchema: {
        query: z.string().describe('Natural-language query'),
        classes: z
          .array(z.string())
          .optional()
          .describe('Restrict matches to these classes, e.g. ["Project", "Goal"]'),
        limit: z.number().int().min(1).max(25).optional(),
        hops: z.number().int().min(0).max(2).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      try {
        const { ontologyStore, openRouter } = getConnections();
        return jsonResult(await ontologySearch(ontologyStore.get(), openRouter.maybe(), args));
      } catch (error) {
        return errorResult('Ontology search failed', error);
      }
    },
  );

  server.registerTool(
    'ontology_update',
    {
      title: 'Update the ontology',
      description:
        'Validated write into the ontology registry: upsert nodes (with attributes), add ' +
        'edges, set single attributes, or remove nodes/edges. The whole batch is checked ' +
        'against the OWL schema (classes, property domains/ranges, cardinalities) and applied ' +
        'all-or-nothing; success persists a new immutable RDF version to S3.',
      inputSchema: {
        nodes: z.array(nodeInputSchema).optional(),
        edges: z.array(edgeInputSchema).optional(),
        attributes: z
          .array(z.object({ nodeId: z.string(), property: z.string(), value: z.union([z.string(), z.number()]) }))
          .optional()
          .describe('Single-attribute upserts on existing nodes'),
        removeNodes: z.array(z.string()).optional(),
        removeEdges: z.array(edgeInputSchema).optional(),
      },
    },
    async args => {
      try {
        const { ontologyStore, openRouter } = getConnections();
        return jsonResult(await ontologyUpdate(ontologyStore.get(), openRouter.maybe(), args));
      } catch (error) {
        return errorResult('Ontology update failed', error);
      }
    },
  );

  server.registerTool(
    'ontology_sync',
    {
      title: 'Sync vault content into the ontology',
      description:
        'Runs the injector now (the same job the hourly cron runs): routes new/changed ' +
        'enriched vault documents into the ontology via an LLM discovery loop (max 5 ' +
        'iterations per document). Documents the loop cannot place land in pending_guidance ' +
        'with a question — the elicitation mechanism. Answer by calling this tool again with ' +
        'guidance: [{path, instruction}]. force=true re-routes everything.',
      inputSchema: {
        guidance: z
          .array(z.object({ path: z.string(), instruction: z.string() }))
          .optional()
          .describe('Answers to pending_guidance questions, keyed by document path'),
        force: z.boolean().optional().describe('Re-route all documents, ignoring processed hashes'),
      },
    },
    async args => {
      try {
        const guidance = Object.fromEntries(
          (args.guidance ?? []).map(g => [g.path, g.instruction]),
        );
        return jsonResult(
          await runSync({
            guidance: Object.keys(guidance).length ? guidance : undefined,
            force: args.force,
          }),
        );
      } catch (error) {
        return errorResult('Ontology sync failed', error);
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
