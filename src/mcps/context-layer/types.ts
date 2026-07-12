/**
 * Curated *enrichment* metadata for a collection — human-oriented description and a search-strategy
 * hint that layer on top of live local-corpus discovery. This is optional: a collection that exists
 * on disk but has no curated entry is still fully exposed (see {@link import('./collections.js').enrich}).
 * It is NOT an allow-list — the local corpus is the source of truth for which collections exist.
 */
export interface CollectionMeta {
  /** Collection (subdirectory) name. */
  name: string;
  /** Human-oriented description to help an agent choose the right collection. */
  description: string;
  /** Key of the {@link import('./searches/types.js').SearchStrategy} applied to this collection. */
  strategy: string;
}

/** One compact search result returned by `search_context`. */
export interface SearchHit {
  /** The document's relative path within its collection. */
  id: string;
  score: number;
  /** Payload projected (and truncated) by the collection's search strategy. */
  payload: Record<string, unknown>;
}
