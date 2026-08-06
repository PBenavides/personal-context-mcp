import { tokenize } from '../connections/bm25.js';
import type { OpenRouterClient } from '../connections/openrouter.js';
import type { OntologySnapshot } from '../connections/ontology-store.js';
import type { OntologyEdge, OntologyNode } from './model.js';
import { nodeText } from './model.js';

/**
 * Retrieval over the ontology graph: dense ranking of nodes (OpenRouter embeddings, cosine)
 * with a keyword-overlap fallback, then bounded neighborhood expansion so results come back
 * as a subgraph — matched nodes plus the edges (and endpoint nodes) around them. Ontology
 * retrieval best practice in miniature: rank entities, return context.
 */

export interface RankedNode {
  node: OntologyNode;
  score: number;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Token-overlap scoring used when embeddings are unavailable (no key, or no vectors yet). */
export function keywordRank(
  nodes: OntologyNode[],
  query: string,
  limit: number,
): RankedNode[] {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) {
    return [];
  }
  return nodes
    .map(node => {
      const tokens = tokenize(nodeText(node));
      let hits = 0;
      for (const token of tokens) {
        if (terms.has(token)) {
          hits += 1;
        }
      }
      return { node, score: tokens.length ? hits / Math.sqrt(tokens.length) : 0 };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface OntologySearchParams {
  query: string;
  /** Restrict matches to these classes (neighbors are exempt — context stays visible). */
  classes?: string[];
  limit?: number;
  /** Neighborhood expansion depth: 0 = matches only, 1 (default) = adjacent nodes/edges. */
  hops?: number;
}

export interface OntologySearchResult {
  query: string;
  mode: 'semantic' | 'keyword';
  version: number;
  total: number;
  matches: {
    id: string;
    class: string;
    label: string;
    score: number;
    created: string;
    modified: string;
    attributes: { property: string; value: string | number; modified: string }[];
  }[];
  /** Edges within the expanded neighborhood, timestamps included. */
  edges: OntologyEdge[];
  /** Non-matched nodes pulled in by expansion, compact form. */
  neighbors: { id: string; class: string; label: string; modified: string }[];
}

export async function searchOntology(
  snapshot: OntologySnapshot,
  openRouter: OpenRouterClient | undefined,
  params: OntologySearchParams,
): Promise<OntologySearchResult> {
  const limit = Math.min(Math.max(1, params.limit ?? 10), 25);
  const hops = Math.min(Math.max(0, params.hops ?? 1), 2);
  const classFilter = params.classes?.length
    ? new Set(params.classes.map(c => c.toLowerCase()))
    : undefined;
  const nodes = [...snapshot.graph.nodes.values()].filter(
    node => !classFilter || classFilter.has(node.class.toLowerCase()),
  );

  let ranked: RankedNode[] = [];
  let mode: 'semantic' | 'keyword' = 'keyword';
  if (openRouter && Object.keys(snapshot.embeddings).length > 0) {
    try {
      const [queryVector] = await openRouter.embed([params.query]);
      ranked = nodes
        .flatMap(node => {
          const vector = snapshot.embeddings[node.id];
          return vector ? [{ node, score: cosine(queryVector, vector) }] : [];
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      mode = 'semantic';
    } catch {
      ranked = [];
    }
  }
  if (ranked.length === 0) {
    ranked = keywordRank(nodes, params.query, limit);
    mode = 'keyword';
  }

  // Neighborhood expansion over the full graph (class filter applies to matches only).
  const inScope = new Set(ranked.map(r => r.node.id));
  let frontier = new Set(inScope);
  const edges: OntologyEdge[] = [];
  const seenEdges = new Set<string>();
  for (let hop = 0; hop < hops; hop++) {
    const next = new Set<string>();
    for (const edge of snapshot.graph.edges) {
      const touches = frontier.has(edge.subject) || frontier.has(edge.object);
      const key = `${edge.subject}|${edge.predicate}|${edge.object}`;
      if (touches && !seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push(edge);
        for (const id of [edge.subject, edge.object]) {
          if (!inScope.has(id)) {
            inScope.add(id);
            next.add(id);
          }
        }
      }
    }
    frontier = next;
  }

  const matchedIds = new Set(ranked.map(r => r.node.id));
  const neighbors = [...inScope]
    .filter(id => !matchedIds.has(id))
    .flatMap(id => {
      const node = snapshot.graph.nodes.get(id);
      return node
        ? [{ id: node.id, class: node.class, label: node.label, modified: node.modified }]
        : [];
    });

  return {
    query: params.query,
    mode,
    version: snapshot.manifest.version,
    total: ranked.length,
    matches: ranked.map(({ node, score }) => ({
      id: node.id,
      class: node.class,
      label: node.label,
      score: Number(score.toFixed(4)),
      created: node.created,
      modified: node.modified,
      attributes: node.attributes.map(a => ({
        property: a.property,
        value: a.value,
        modified: a.modified,
      })),
    })),
    edges,
    neighbors,
  };
}
