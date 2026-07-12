import { pickFields, truncateString } from './default.js';
import type { SearchStrategy } from './types.js';

/**
 * EXAMPLE of a collection-specific strategy — demonstrates the plugin mechanism (add a strategy
 * file, register it in registry.ts, no tool changes) using the "sensitive data" narrative: a
 * shorter, conservative content snippet instead of the default strategy's full-length copy.
 */
const SNIPPET_LENGTH = 200; // shorter than the default's MAX_STRING_LENGTH (500)

export const peopleOperationsStrategy: SearchStrategy = {
  key: 'people-operations',
  collection: 'people-ops-sensitive-demo',
  describe: () =>
    'People-operations demo collection (sensitive): returns a conservative, shortened content snippet instead of the full document body.',
  projectPayload(payload) {
    const picked = pickFields(payload, ['id', 'collection', 'title', 'path'] as const);
    if (typeof payload.content === 'string') {
      picked.content = truncateString(payload.content, SNIPPET_LENGTH);
    }
    return picked;
  },
};
