import type { OpenRouterClient } from '../../connections/openrouter.js';
import type { OntologyStoreClient } from '../../connections/ontology-store.js';
import type { AttributeInput, EdgeInput, NodeInput } from '../../ontology/model.js';
import { applyUpdate, nodeText } from '../../ontology/model.js';
import { searchOntology, type OntologySearchResult } from '../../ontology/search.js';
import type { ToolError } from './tools.js';

/**
 * Handler logic for the ontology tools (`ontology_search`, `ontology_update`; `ontology_sync`
 * runs through `src/ontology/sync-runner.ts`). Registration stays in `./index.ts`, mirroring
 * the corpus tools split.
 */

export async function ontologySearch(
  store: OntologyStoreClient,
  openRouter: OpenRouterClient | undefined,
  args: { query: string; classes?: string[]; limit?: number; hops?: number },
): Promise<OntologySearchResult | ToolError> {
  if (!args.query || !args.query.trim()) {
    return { error: 'query must be a non-empty string' };
  }
  const snapshot = await store.snapshot();
  return searchOntology(snapshot, openRouter, args);
}

export interface OntologyUpdateResult {
  version: number;
  nodesCreated: number;
  nodesUpdated: number;
  nodesRemoved: number;
  edgesCreated: number;
  edgesRemoved: number;
  totalNodes: number;
  totalEdges: number;
}

/**
 * Validated upsert into the ontology registry. All-or-nothing per call; a rejected batch
 * returns every validation error and persists nothing. On success a new immutable version
 * is written and changed nodes are re-embedded (best effort).
 */
export async function ontologyUpdate(
  store: OntologyStoreClient,
  openRouter: OpenRouterClient | undefined,
  args: {
    nodes?: NodeInput[];
    edges?: EdgeInput[];
    attributes?: AttributeInput[];
    removeNodes?: string[];
    removeEdges?: EdgeInput[];
  },
): Promise<OntologyUpdateResult | ToolError> {
  const hasWork =
    (args.nodes?.length ?? 0) +
      (args.edges?.length ?? 0) +
      (args.attributes?.length ?? 0) +
      (args.removeNodes?.length ?? 0) +
      (args.removeEdges?.length ?? 0) >
    0;
  if (!hasWork) {
    return { error: 'nothing to update: provide nodes, edges, attributes, or removals' };
  }

  return store.mutate<OntologyUpdateResult | ToolError>(async snapshot => {
    const result = applyUpdate(snapshot.graph, args, new Date().toISOString());
    if (!result.ok) {
      return {
        persist: false,
        result: { error: `validation failed:\n- ${result.errors.join('\n- ')}` },
      };
    }
    if (openRouter && result.changedNodeIds.length > 0) {
      try {
        const ids = result.changedNodeIds.filter(id => snapshot.graph.nodes.has(id));
        const vectors = await openRouter.embed(
          ids.map(id => nodeText(snapshot.graph.nodes.get(id)!)),
        );
        ids.forEach((id, i) => {
          snapshot.embeddings[id] = vectors[i];
        });
      } catch {
        // embeddings refresh is best-effort; keyword fallback covers the gap
      }
    }
    for (const id of args.removeNodes ?? []) {
      delete snapshot.embeddings[id];
    }
    return {
      persist: true,
      note: `ontology_update: +${result.nodesCreated}n +${result.edgesCreated}e`,
      result: {
        version: snapshot.manifest.version + 1,
        nodesCreated: result.nodesCreated,
        nodesUpdated: result.nodesUpdated,
        nodesRemoved: result.nodesRemoved,
        edgesCreated: result.edgesCreated,
        edgesRemoved: result.edgesRemoved,
        totalNodes: snapshot.graph.nodes.size,
        totalEdges: snapshot.graph.edges.length,
      },
    };
  });
}
