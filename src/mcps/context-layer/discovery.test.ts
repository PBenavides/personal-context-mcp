import type { LocalCorpusIndex } from '../../connections/local-corpus.js';
import { applyExclusions, discoverCollections } from './discovery.js';

describe('applyExclusions', () => {
  const names = ['taxlaw_notion_knowledge_db', 'test-notion-context-layer', 'hr_db'];

  it('returns all names when no patterns are given', () => {
    expect(applyExclusions(names, [])).toEqual(names);
  });

  it('drops names by exact match', () => {
    expect(applyExclusions(names, ['hr_db'])).toEqual([
      'taxlaw_notion_knowledge_db',
      'test-notion-context-layer',
    ]);
  });

  it('drops names by substring', () => {
    expect(applyExclusions(names, ['test'])).toEqual([
      'taxlaw_notion_knowledge_db',
      'hr_db',
    ]);
  });

  it('drops names by regex pattern', () => {
    expect(applyExclusions(names, ['^test-'])).toEqual([
      'taxlaw_notion_knowledge_db',
      'hr_db',
    ]);
  });
});

function fakeCorpus(collectionNames: string[]): LocalCorpusIndex {
  return {
    listCollections: () => collectionNames,
    docCount: () => 0,
    totalDocCount: () => 0,
    search: () => [],
  };
}

describe('discoverCollections', () => {
  it('maps live collections to enriched listings', () => {
    const listings = discoverCollections(
      fakeCorpus(['people-ops-sensitive-demo', 'brand-new-live-collection']),
    );
    const curated = listings.find(l => l.name === 'people-ops-sensitive-demo');
    const live = listings.find(l => l.name === 'brand-new-live-collection');
    expect(curated?.curated).toBe(true);
    expect(curated?.strategy).toBe('people-operations');
    // A collection that exists only on disk is surfaced with a default strategy — no code change.
    expect(live?.curated).toBe(false);
    expect(live?.strategy).toBe('default');
  });
});
