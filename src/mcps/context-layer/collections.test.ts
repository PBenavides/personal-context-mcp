import { COLLECTIONS, enrich, getCollectionMeta } from './collections.js';

describe('collections catalog (enrichment)', () => {
  it('curates the two demo collections', () => {
    expect(COLLECTIONS.map(c => c.name).sort()).toEqual(
      ['general-knowledge-demo', 'people-ops-sensitive-demo'].sort(),
    );
  });

  it('gives every curated collection a strategy', () => {
    for (const meta of COLLECTIONS) {
      expect(meta.strategy).toBeTruthy();
    }
  });

  it('looks up curated metadata by name and returns undefined for unknowns', () => {
    expect(getCollectionMeta('people-ops-sensitive-demo')?.strategy).toBe(
      'people-operations',
    );
    expect(getCollectionMeta('nope')).toBeUndefined();
  });
});

describe('enrich', () => {
  it('marks curated collections and preserves their metadata', () => {
    const meta = enrich('people-ops-sensitive-demo');
    expect(meta.curated).toBe(true);
    expect(meta.strategy).toBe('people-operations');
    expect(meta.description).toContain('sensitive');
  });

  it('synthesizes a default for a collection with no catalog entry', () => {
    const meta = enrich('uncurated-demo');
    expect(meta.curated).toBe(false);
    expect(meta.name).toBe('uncurated-demo');
    expect(meta.strategy).toBe('default');
    expect(meta.description).toContain('Discovered live');
  });
});
