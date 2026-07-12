import type { LocalCorpusIndex } from '../../connections/local-corpus.js';
import { appConfig } from '../../config.js';
import { enrich } from './collections.js';

/**
 * Live discovery of local-corpus collections — the source of truth for what this MCP exposes.
 *
 * Tools, resources, and the prompt all go through here so the surface is a true live view: whatever
 * exists on disk under the corpus root (minus the configured denylist) is exposed, enriched with
 * curated metadata where available. No code change is needed to expose a newly-added collection
 * (subdirectory).
 */

/** One collection as surfaced to clients — live by construction, enriched where curated. */
export interface CollectionListing {
  name: string;
  description: string;
  strategy: string;
  /** `true` if the collection has a curated catalog entry; `false` if discovered live only. */
  curated: boolean;
}

/** Whether a single denylist pattern matches a collection name (substring, then regex fallback). */
function matches(name: string, pattern: string): boolean {
  if (name === pattern || name.includes(pattern)) {
    return true;
  }
  try {
    return new RegExp(pattern).test(name);
  } catch {
    return false;
  }
}

/** Removes names matching any denylist pattern. Pure and network-free — the unit of the denylist logic. */
export function applyExclusions(names: string[], patterns: string[]): string[] {
  if (patterns.length === 0) {
    return names;
  }
  return names.filter(name => !patterns.some(pattern => matches(name, pattern)));
}

/**
 * Lists the live local-corpus collections (denylist applied), each enriched with curated metadata
 * where present and a synthesized default otherwise. This is an in-memory read (no I/O) once the
 * corpus index has been built, so it never throws — the entry point never falls back to a stale
 * static list because there's no stale state to fall back from.
 */
export function discoverCollections(corpus: LocalCorpusIndex): CollectionListing[] {
  const names = applyExclusions(
    corpus.listCollections(),
    appConfig.contextLayer.excludeCollections,
  );
  return names.map(name => {
    const meta = enrich(name);
    return {
      name: meta.name,
      description: meta.description,
      strategy: meta.strategy,
      curated: meta.curated,
    };
  });
}

/** Live collection names (denylist applied) — thin wrapper for prompts and existence checks. */
export function discoverCollectionNames(corpus: LocalCorpusIndex): string[] {
  return discoverCollections(corpus).map(listing => listing.name);
}
