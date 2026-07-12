import { buildBm25Index, tokenize } from './bm25.js';

describe('tokenize', () => {
  it('lowercases, strips punctuation, and drops stopwords', () => {
    expect(tokenize('The Quick, Fox!')).toEqual(['quick', 'fox']);
  });

  it('returns an empty array for a stopword-only or blank string', () => {
    expect(tokenize('the a an')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });
});

describe('buildBm25Index', () => {
  it('returns no results for an empty corpus', () => {
    const index = buildBm25Index([]);
    expect(index.docCount).toBe(0);
    expect(index.search('anything', 5)).toEqual([]);
  });

  it('never throws on a corpus containing a zero-length (empty) document', () => {
    const index = buildBm25Index([
      { id: 'empty', text: '' },
      { id: 'real', text: 'cat dog' },
    ]);
    expect(() => index.search('cat', 5)).not.toThrow();
    const hits = index.search('cat', 5);
    expect(hits.map(h => h.id)).toEqual(['real']);
  });

  it('returns no results for a query with only stopwords', () => {
    const index = buildBm25Index([{ id: 'd1', text: 'cat dog' }]);
    expect(index.search('the a an', 5)).toEqual([]);
  });

  it('returns no results when no document contains any query term', () => {
    const index = buildBm25Index([{ id: 'd1', text: 'cat dog' }]);
    expect(index.search('elephant', 5)).toEqual([]);
  });

  it('excludes documents that do not match any query term (no zero-score hits)', () => {
    const index = buildBm25Index([
      { id: 'd1', text: 'cat dog' },
      { id: 'd2', text: 'fish bird' },
    ]);
    const hits = index.search('cat', 5);
    expect(hits.map(h => h.id)).toEqual(['d1']);
  });

  it('ranks a document with a higher term frequency above one with a lower frequency', () => {
    const index = buildBm25Index([
      { id: 'once', text: 'cat bird bird bird' },
      { id: 'twice', text: 'cat cat dog' },
    ]);
    const hits = index.search('cat', 5);
    expect(hits.map(h => h.id)).toEqual(['twice', 'once']);
  });

  it('matches the documented BM25 formula (k1=1.2, b=0.75) on a hand-computed 3-doc corpus', () => {
    // docs: d1 "cat cat dog" (len 3), d2 "cat bird bird bird" (len 4), d3 "fish fish fish" (len 3)
    // avgdl = 10/3. query "cat": df=2, N=3 -> idf = ln((3-2+0.5)/(2+0.5)+1) = ln(1.6) ~= 0.470004
    // d1: tf=2, lengthNorm=0.75*3/(10/3)=0.675, denom=2+1.2*(0.925)=3.11, score=idf*4.4/3.11 ~= 0.665
    // d2: tf=1, lengthNorm=0.75*4/(10/3)=0.9,   denom=1+1.2*(1.15)=2.38, score=idf*2.2/2.38 ~= 0.434
    // d3: no "cat" -> excluded entirely
    const index = buildBm25Index([
      { id: 'd1', text: 'cat cat dog' },
      { id: 'd2', text: 'cat bird bird bird' },
      { id: 'd3', text: 'fish fish fish' },
    ]);
    const hits = index.search('cat', 5);
    expect(hits.map(h => h.id)).toEqual(['d1', 'd2']);
    expect(hits.find(h => h.id === 'd1')?.score).toBeCloseTo(0.665, 2);
    expect(hits.find(h => h.id === 'd2')?.score).toBeCloseTo(0.434, 2);
  });

  it('favors a document containing a rarer term over one containing only a common term', () => {
    // "common" appears in every doc; "rare" appears in only one. A query for both terms should
    // rank the doc containing "rare" first, since rare terms carry far more IDF weight.
    const index = buildBm25Index([
      { id: 'has-rare', text: 'common rare' },
      { id: 'common-only-a', text: 'common filler filler' },
      { id: 'common-only-b', text: 'common filler filler' },
    ]);
    const hits = index.search('common rare', 5);
    expect(hits[0]?.id).toBe('has-rare');
  });

  it('breaks score ties by ascending document id for deterministic ordering', () => {
    const index = buildBm25Index([
      { id: 'zzz', text: 'cat dog' },
      { id: 'aaa', text: 'cat dog' },
    ]);
    const hits = index.search('cat dog', 5);
    expect(hits.map(h => h.id)).toEqual(['aaa', 'zzz']);
  });

  it('truncates results to the requested limit, keeping the top scorers', () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`,
      text: 'cat '.repeat(i + 1),
    }));
    const index = buildBm25Index(docs);
    const hits = index.search('cat', 2);
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.id)).toEqual(['d4', 'd3']);
  });
});
