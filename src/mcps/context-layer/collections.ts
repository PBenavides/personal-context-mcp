import type { CollectionMeta } from './types.js';

/**
 * Curated *enrichment* for known local-corpus collections — NOT the source of truth for what
 * exists.
 *
 * This MCP is a live view of the local corpus: `list_collections`, `describe_collection` and
 * `search_context` discover collections from the filesystem (see `./discovery.ts`). This catalog
 * only adds human-oriented descriptions and a {@link import('./searches/types.js').SearchStrategy}
 * hint on top, for collections we have curated. A collection present on disk but absent here is
 * still fully exposed — it just gets a synthesized default description and the generic `default`
 * strategy (see {@link enrich}). Adding an entry here is optional tuning, never a requirement to
 * expose a collection, and never restricts which collections appear.
 */
export const COLLECTIONS: readonly CollectionMeta[] = [
  {
    name: 'general-knowledge-demo',
    description:
      'General-purpose demo knowledge base (curated, default strategy) — company-facts-style documents for exercising BM25 keyword search.',
    strategy: 'default',
  },
  {
    name: 'people-ops-sensitive-demo',
    description:
      'People-operations demo knowledge base (curated, sensitive). Illustrates a conservative projection strategy for sensitive content.',
    strategy: 'people-operations',
  },
];

/** Curated metadata for a collection, or `undefined` if it has no curated entry. */
export function getCollectionMeta(name: string): CollectionMeta | undefined {
  return COLLECTIONS.find(collection => collection.name === name);
}

/**
 * Metadata for a collection with a flag distinguishing curated entries from ones discovered live.
 */
export interface EnrichedMeta extends CollectionMeta {
  /** `true` if this collection has a curated {@link COLLECTIONS} entry; `false` if synthesized. */
  curated: boolean;
}

/**
 * Returns curated metadata for a collection when present, otherwise a synthesized default so any
 * live collection is describable and searchable (with the generic `default` strategy) with no
 * code change.
 */
export function enrich(name: string): EnrichedMeta {
  const meta = getCollectionMeta(name);
  if (meta) {
    return { ...meta, curated: true };
  }
  return {
    name,
    description: 'Discovered live from the local corpus — no curated description.',
    strategy: 'default',
    curated: false,
  };
}
