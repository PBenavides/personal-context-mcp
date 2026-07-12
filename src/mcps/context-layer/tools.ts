import type { LocalCorpusIndex } from '../../connections/local-corpus.js';
import { enrich } from './collections.js';
import {
  discoverCollectionNames,
  discoverCollections,
  type CollectionListing,
} from './discovery.js';
import { getStrategy } from './searches/registry.js';
import type { SearchArgs } from './searches/types.js';
import type { SearchHit } from './types.js';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

/** Dependencies for a search: the local corpus index. */
export interface SearchDeps {
  corpus: LocalCorpusIndex;
}

/** Structured error result shared by the tool functions. */
export interface ToolError {
  error: string;
}

/** Error for a collection that isn't present in the live corpus (or is denylisted). */
function unknownCollection(name: string, liveNames: string[]): ToolError {
  return {
    error: `Unknown collection "${name}". Call list_collections first. Known: ${liveNames.join(', ')}`,
  };
}

/**
 * Lists the collections that currently exist in the local corpus (denylist applied), each
 * enriched with curated metadata where available. This is a live view — a collection added on
 * disk appears here with no code change, and the catalog never hides or gates it.
 */
export function listCollections(corpus: LocalCorpusIndex): CollectionListing[] {
  return discoverCollections(corpus);
}

/** Live + curated detail for one collection, as returned by {@link describeCollection}. */
export interface CollectionDescription {
  name: string;
  description: string;
  strategy: string;
  strategyDetail: string;
  /** `true` if the collection has a curated catalog entry; `false` if discovered live only. */
  curated: boolean;
  live: { docCount: number };
}

/** Curated metadata + live doc count + strategy description for one live collection. */
export function describeCollection(
  corpus: LocalCorpusIndex,
  name: string,
): CollectionDescription | ToolError {
  const liveNames = discoverCollectionNames(corpus);
  if (!liveNames.includes(name)) {
    return unknownCollection(name, liveNames);
  }
  const meta = enrich(name);
  const strategy = getStrategy(name);
  return {
    name: meta.name,
    description: meta.description,
    strategy: meta.strategy,
    strategyDetail: strategy.describe(),
    curated: meta.curated,
    live: { docCount: corpus.docCount(name) },
  };
}

/** Result of a successful {@link searchContext} call. */
export interface SearchResult {
  collection: string;
  strategy: string;
  hits: SearchHit[];
}

/**
 * Runs a BM25 keyword search with the collection's strategy and returns the best-matching
 * documents with compact, strategy-projected payloads. Validates the collection against the
 * *live* corpus first (so an agent gets a helpful message instead of an empty result), resolves
 * the search strategy — which falls back to the generic default for any collection without a
 * curated one — and clamps `limit`.
 */
export function searchContext(
  deps: SearchDeps,
  args: SearchArgs,
): SearchResult | ToolError {
  const { corpus } = deps;
  if (!args.query || !args.query.trim()) {
    return { error: 'query must be a non-empty string' };
  }

  const liveNames = discoverCollectionNames(corpus);
  if (!liveNames.includes(args.collection)) {
    return unknownCollection(args.collection, liveNames);
  }

  const strategy = getStrategy(args.collection);
  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const rawHits = corpus.search(args.collection, args.query, limit);
  const hits: SearchHit[] = rawHits.map(hit => ({
    id: hit.id,
    score: hit.score,
    payload: strategy.projectPayload(hit.payload),
  }));

  return {
    collection: args.collection,
    strategy: strategy.key,
    hits,
  };
}
