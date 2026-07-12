import { defaultStrategy } from './default.js';
import { getStrategy } from './registry.js';

describe('getStrategy', () => {
  it('returns the specialized strategy for a known collection', () => {
    expect(getStrategy('people-ops-sensitive-demo').key).toBe(
      'people-operations',
    );
  });

  it('falls back to the default strategy for an unmapped collection', () => {
    expect(getStrategy('general-knowledge-demo')).toBe(defaultStrategy);
    expect(getStrategy('anything-else')).toBe(defaultStrategy);
  });

  it('specialized strategies declare their target collection', () => {
    const peopleOps = getStrategy('people-ops-sensitive-demo');
    expect(peopleOps.collection).toBe('people-ops-sensitive-demo');
  });
});
