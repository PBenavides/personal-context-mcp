import { createFileSource, loadCorpus, type EnrichedCorpusIndex } from '../../connections/enriched-corpus.js';
import { getDocument, listTaxonomy, makeSnippet, searchContext, type DocumentResult, type SearchResult, type ToolError } from './tools.js';

let corpus: EnrichedCorpusIndex;

beforeAll(async () => {
  corpus = await loadCorpus(createFileSource('tests/fixtures/enriched'));
});

function asResult(value: SearchResult | ToolError): SearchResult {
  expect(value).not.toHaveProperty('error');
  return value as SearchResult;
}

describe('searchContext (keyword fallback, no vector client)', () => {
  it('rejects an empty query with a structured error', async () => {
    expect(await searchContext(corpus, undefined, { query: '  ' })).toEqual({
      error: 'query must be a non-empty string',
    });
  });

  it('returns compact hits with path, score, category, summary, snippet', async () => {
    const result = asResult(await searchContext(corpus, undefined, { query: 'knee physiotherapy' }));
    expect(result.mode).toBe('keyword');
    expect(result.hits[0]).toMatchObject({
      path: 'notes/health/knee-rehab.md',
      category: 'HealthCondition',
      status: 'active',
    });
    expect(result.hits[0].score).toBeGreaterThan(0);
    expect(result.hits[0].summary).toMatch(/knee rehabilitation/i);
    expect(result.hits[0].snippet.toLowerCase()).toContain('knee');
  });

  it('applies category, status, and horizon filters', async () => {
    const goals = asResult(await searchContext(corpus, undefined, { query: 'pipeline', category: 'Goal' }));
    expect(goals.hits.map(hit => hit.path)).toEqual(['notes/_pipeline_sentinel.md']);

    const dormant = asResult(await searchContext(corpus, undefined, { query: 'project', status: 'dormant' }));
    expect(dormant.hits.map(hit => hit.path)).toEqual(['notes/projects/old-blog.md']);

    const past = asResult(await searchContext(corpus, undefined, { query: 'english', horizon: 'past' }));
    expect(past.hits.every(hit => hit.category === 'Event')).toBe(true);
  });

  it('clamps limit', async () => {
    const result = asResult(await searchContext(corpus, undefined, { query: 'pipeline note project', limit: 1 }));
    expect(result.hits).toHaveLength(1);
  });
});

describe('searchContext (semantic, with vector client)', () => {
  it('ranks by the vector hits and hydrates documents from the corpus', async () => {
    const vector = {
      search: async () => [
        { key: 'notes/health/knee-rehab.md', score: 0.91 },
        { key: 'notes/deleted-since-embedding.md', score: 0.9 }, // stale vector — skipped
        { key: 'notes/_pipeline_sentinel.md', score: 0.42 },
      ],
    };
    const result = asResult(await searchContext(corpus, vector, { query: 'rehab' }));
    expect(result.mode).toBe('semantic');
    expect(result.hits.map(hit => hit.path)).toEqual([
      'notes/health/knee-rehab.md',
      'notes/_pipeline_sentinel.md',
    ]);
    expect(result.hits[0].score).toBeCloseTo(0.91);
  });

  it('passes filters and limit through to the vector search', async () => {
    const seen: unknown[] = [];
    const vector = {
      search: async (query: string, filters: unknown, limit: number) => {
        seen.push([query, filters, limit]);
        return [];
      },
    };
    await searchContext(corpus, vector, { query: 'q', category: 'Goal', limit: 3 });
    expect(seen).toEqual([['q', { category: 'Goal', status: undefined, horizon: undefined }, 3]]);
  });

  it('falls back to BM25 when the vector search throws', async () => {
    const vector = {
      search: async () => {
        throw new Error('bedrock unreachable');
      },
    };
    const result = asResult(await searchContext(corpus, vector, { query: 'knee physiotherapy' }));
    expect(result.mode).toBe('keyword');
    expect(result.hits[0].path).toBe('notes/health/knee-rehab.md');
  });
});

describe('getDocument', () => {
  it('returns the full raw content by default', () => {
    const doc = getDocument(corpus, { path: 'notes/_pipeline_sentinel.md' }) as DocumentResult;
    expect(doc.category).toBe('Goal');
    expect(doc.content).toContain('---'); // frontmatter included
    expect(doc.content).toContain('Sentinel goal');
    expect(doc.truncated).toBe(false);
  });

  it('returns a bounded preview when full=false', () => {
    const doc = getDocument(corpus, {
      path: 'notes/projects/context-pipeline.md',
      full: false,
    }) as DocumentResult;
    expect(doc.content).not.toContain('---');
    expect(doc.content.length).toBeLessThanOrEqual(500);
  });

  it('errors helpfully on an unknown path', () => {
    const result = getDocument(corpus, { path: 'notes/nope.md' });
    expect(result).toHaveProperty('error');
    expect((result as ToolError).error).toMatch(/Unknown document/);
  });
});

describe('listTaxonomy', () => {
  it('returns category counts sorted by count then name, plus manifest metadata', () => {
    const taxonomy = listTaxonomy(corpus);
    expect(taxonomy.taxonomy_version).toBe('fixturetax01');
    expect(taxonomy.run_id).toBe('run-fixture-001');
    expect(taxonomy.total_documents).toBe(7);
    expect(taxonomy.categories).toEqual([
      { category: 'Event', count: 2 },
      { category: 'Project', count: 2 },
      { category: 'Goal', count: 1 },
      { category: 'Habit', count: 1 },
      { category: 'HealthCondition', count: 1 },
    ]);
  });
});

describe('makeSnippet', () => {
  it('centres on the first query term occurrence', () => {
    const body = `${'x '.repeat(300)}the knee needs rest${' y'.repeat(300)}`;
    const snippet = makeSnippet(body, 'knee');
    expect(snippet).toContain('knee needs rest');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(400);
  });

  it('falls back to the head of the body when nothing matches', () => {
    const snippet = makeSnippet('short body about nothing in particular', 'zzz-no-match');
    expect(snippet).toContain('short body');
  });
});
