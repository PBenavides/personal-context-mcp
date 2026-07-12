import {
  createVectorSearchConnection,
  toVectorFilter,
  type VectorBackend,
} from './vector-search.js';

const CONFIG = {
  bucket: 'personal-context-vectors',
  index: 'context-notes',
  region: 'us-east-1',
  embedModelId: 'amazon.titan-embed-text-v2:0',
};

describe('toVectorFilter', () => {
  it('lowercases values to match what the pipeline wrote', () => {
    expect(toVectorFilter({ category: 'Goal', status: 'Active' })).toEqual({
      category: 'goal',
      status: 'active',
    });
  });

  it('drops empty and undefined filters, returning undefined when nothing remains', () => {
    expect(toVectorFilter({ category: '  ', status: undefined })).toBeUndefined();
    expect(toVectorFilter({})).toBeUndefined();
  });
});

describe('createVectorSearchConnection', () => {
  it('is inert when bucket/index are unset: maybe() undefined, get() throws, health ok', async () => {
    const conn = createVectorSearchConnection({ ...CONFIG, bucket: '', index: '' });
    expect(conn.maybe()).toBeUndefined();
    expect(() => conn.get()).toThrow(/not configured/);
    const health = await conn.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toMatch(/BM25/);
  });

  it('embeds the query, forwards the lowercased filter, and maps distance → score', async () => {
    const calls: unknown[] = [];
    const backend: VectorBackend = {
      async embedQuery(text) {
        calls.push(['embed', text]);
        return [0.1, 0.2];
      },
      async queryVectors(vector, filter, topK) {
        calls.push(['query', vector, filter, topK]);
        return [
          { key: 'notes/a.md', distance: 0.09 },
          { key: 'notes/b.md', distance: 0.44 },
        ];
      },
    };
    const conn = createVectorSearchConnection(CONFIG, { backend });
    const hits = await conn.get().search('mother health', { category: 'Person' }, 5);
    expect(calls).toEqual([
      ['embed', 'mother health'],
      ['query', [0.1, 0.2], { category: 'person' }, 5],
    ]);
    expect(hits).toEqual([
      { key: 'notes/a.md', score: 1 - 0.09 },
      { key: 'notes/b.md', score: 1 - 0.44 },
    ]);
  });

  it('omits the filter entirely when no filters are set', async () => {
    let seenFilter: unknown = 'sentinel';
    const backend: VectorBackend = {
      embedQuery: async () => [0],
      async queryVectors(_v, filter) {
        seenFilter = filter;
        return [];
      },
    };
    const conn = createVectorSearchConnection(CONFIG, { backend });
    await conn.get().search('anything', {}, 10);
    expect(seenFilter).toBeUndefined();
  });
});
