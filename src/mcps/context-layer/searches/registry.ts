import { defaultStrategy } from './default.js';
import { peopleOperationsStrategy } from './people-operations.js';
import type { SearchStrategy } from './types.js';

/**
 * Collection → strategy map — purely optional tuning, never a requirement to expose a collection.
 * Any collection without an entry here (including ones discovered live from the local corpus)
 * falls back to {@link defaultStrategy} and is fully searchable. Add an entry only to tune the
 * payload projection for a specific collection.
 */
export const STRATEGIES: readonly SearchStrategy[] = [peopleOperationsStrategy];

const BY_COLLECTION = new Map<string, SearchStrategy>(
  STRATEGIES.filter(
    (strategy): strategy is SearchStrategy & { collection: string } =>
      typeof strategy.collection === 'string',
  ).map(strategy => [strategy.collection, strategy]),
);

/** Returns the strategy for a collection, or the generic {@link defaultStrategy} fallback. */
export function getStrategy(collection: string): SearchStrategy {
  return BY_COLLECTION.get(collection) ?? defaultStrategy;
}
