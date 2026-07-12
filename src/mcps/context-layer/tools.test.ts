import type { CorpusHit, LocalCorpusIndex } from '../../connections/local-corpus.js';
import {
  describeCollection,
  listCollections,
  searchContext,
  type SearchDeps,
} from './tools.js';

const COLLECTION_NAMES = [
  'people-ops-sensitive-demo',
  'general-knowledge-demo',
  'live_only_uncatalogued',
];

function fakeCorpus(
  overrides: Partial<Record<'search' | 'docCount', unknown>> = {},
): LocalCorpusIndex {
  const base: LocalCorpusIndex = {
    listCollections: () => COLLECTION_NAMES,
    docCount: () => 2,
    totalDocCount: () => COLLECTION_NAMES.length * 2,
    search: (): CorpusHit[] => [
      {
        id: 'p1',
        score: 0.91,
        payload: {
          id: 'p1',
          collection: 'people-ops-sensitive-demo',
          title: 'Deductions',
          path: 'p1.md',
          content: 'x'.repeat(1000),
        },
      },
      {
        id: 'p2',
        score: 0.82,
        payload: {
          id: 'p2',
          collection: 'people-ops-sensitive-demo',
          title: 'Filing',
          path: 'p2.md',
          content: 'short',
        },
      },
    ],
  };
  return { ...base, ...overrides } as LocalCorpusIndex;
}

describe('searchContext', () => {
  it('applies the collection strategy and returns compact hits', () => {
    const deps: SearchDeps = { corpus: fakeCorpus() };
    const result = searchContext(deps, {
      collection: 'people-ops-sensitive-demo',
      query: 'deductions',
    });

    if ('error' in result) {
      throw new Error(`unexpected error: ${result.error}`);
    }
    expect(result.strategy).toBe('people-operations');
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({ id: 'p1', score: 0.91 });
    // the people-operations strategy truncates content to a conservative snippet
    expect(String(result.hits[0]?.payload.content)).toContain('[truncated');
    expect(String(result.hits[0]?.payload.content).length).toBeLessThan(300);
  });

  it('searches a live collection with no catalog entry using the default strategy', () => {
    const result = searchContext(
      { corpus: fakeCorpus() },
      { collection: 'live_only_uncatalogued', query: 'anything' },
    );
    if ('error' in result) {
      throw new Error(`unexpected error: ${result.error}`);
    }
    expect(result.strategy).toBe('default');
  });

  it('clamps the limit and passes it to the corpus search', () => {
    let seenLimit: number | undefined;
    const deps: SearchDeps = {
      corpus: fakeCorpus({
        search: (_collection: string, _query: string, limit: number) => {
          seenLimit = limit;
          return [];
        },
      }),
    };
    searchContext(deps, {
      collection: 'general-knowledge-demo',
      query: 'q',
      limit: 999,
    });
    expect(seenLimit).toBe(25);
  });

  it('returns an error for a collection not present in the live corpus', () => {
    const result = searchContext(
      { corpus: fakeCorpus() },
      { collection: 'nope', query: 'q' },
    );
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      // the "Known:" hint lists live collection names
      expect(result.error).toContain('people-ops-sensitive-demo');
    }
  });

  it('returns an error for an empty query', () => {
    const result = searchContext(
      { corpus: fakeCorpus() },
      { collection: 'general-knowledge-demo', query: '   ' },
    );
    expect(result).toHaveProperty('error');
  });
});

describe('listCollections', () => {
  it('lists exactly the live collections, enriched from the catalog', () => {
    const listing = listCollections(fakeCorpus());
    expect(listing.map(c => c.name).sort()).toEqual([...COLLECTION_NAMES].sort());
    const peopleOps = listing.find(c => c.name === 'people-ops-sensitive-demo');
    expect(peopleOps?.curated).toBe(true);
    expect(peopleOps?.strategy).toBe('people-operations');
  });

  it('surfaces live collections that have no catalog entry with a default strategy', () => {
    const listing = listCollections(fakeCorpus());
    const liveOnly = listing.find(c => c.name === 'live_only_uncatalogued');
    expect(liveOnly).toBeDefined();
    expect(liveOnly?.curated).toBe(false);
    expect(liveOnly?.strategy).toBe('default');
  });
});

describe('describeCollection', () => {
  it('returns catalog + live doc count + strategy detail for a curated collection', () => {
    const result = describeCollection(fakeCorpus(), 'people-ops-sensitive-demo');
    if ('error' in result) {
      throw new Error(`unexpected error: ${result.error}`);
    }
    expect(result.curated).toBe(true);
    expect(result.strategy).toBe('people-operations');
    expect(result.strategyDetail).toContain('conservative');
    expect(result.live.docCount).toBe(2);
  });

  it('describes a live collection with no catalog entry (synthesized metadata)', () => {
    const result = describeCollection(fakeCorpus(), 'live_only_uncatalogued');
    if ('error' in result) {
      throw new Error(`unexpected error: ${result.error}`);
    }
    expect(result.curated).toBe(false);
    expect(result.strategy).toBe('default');
    expect(result.description).toContain('Discovered live');
    expect(result.live.docCount).toBe(2);
  });

  it('returns an error for a collection not present in the live corpus', () => {
    const result = describeCollection(fakeCorpus(), 'nope');
    expect(result).toHaveProperty('error');
  });
});
