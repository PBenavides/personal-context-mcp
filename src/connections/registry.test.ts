import type { AppConfig } from '../config.js';
import {
  createConnections,
  getConnections,
  resetConnections,
  validateConnections,
} from './registry.js';
import type { Connection, ConnectionKind } from './types.js';

function stub(name: string, kind: ConnectionKind = 'enriched-corpus'): Connection<unknown> {
  return {
    name,
    kind,
    get: () => ({}),
    healthCheck: async () => ({ name, kind, ok: true }),
    close: async () => undefined,
  };
}

const configuredConfig: AppConfig['connections'] = {
  enrichedCorpus: {
    source: 'file',
    rootDir: 'tests/fixtures/enriched',
    bucket: '',
    prefix: '',
    region: 'us-east-1',
    refreshSeconds: 0,
  },
  vectorSearch: {
    bucket: '',
    index: '',
    region: 'us-east-1',
    embedModelId: 'amazon.titan-embed-text-v2:0',
  },
};

describe('validateConnections', () => {
  it('throws on duplicate names', () => {
    expect(() => validateConnections([stub('a'), stub('a')])).toThrow(
      /Duplicate connection name: a/,
    );
  });

  it('throws on an empty name', () => {
    expect(() => validateConnections([stub('')])).toThrow(/empty name/);
  });

  it('accepts unique, non-empty names', () => {
    expect(() => validateConnections([stub('a'), stub('b')])).not.toThrow();
  });
});

describe('createConnections', () => {
  it('returns both connections with the correct kinds', () => {
    const registry = createConnections(configuredConfig);
    expect(registry.enrichedCorpus.kind).toBe('enriched-corpus');
    expect(registry.vectorSearch.kind).toBe('vector-search');
    expect(registry.all()).toEqual([registry.enrichedCorpus, registry.vectorSearch]);
  });

  it('healthCheckAll() reports corpus not-loaded before load(), vector search inert', async () => {
    const registry = createConnections(configuredConfig);
    const results = await registry.healthCheckAll();
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toMatch(/not loaded/);
    expect(results[1].ok).toBe(true);
    expect(results[1].detail).toMatch(/BM25/);
  });

  it('healthCheckAll() reports ok after load()', async () => {
    const registry = createConnections(configuredConfig);
    await registry.enrichedCorpus.load();
    const results = await registry.healthCheckAll();
    expect(results[0].ok).toBe(true);
    expect(results[0].detail).toMatch(/documents/);
  });
});

describe('getConnections / resetConnections', () => {
  afterEach(() => {
    resetConnections();
  });

  it('returns the same instance on repeated calls', () => {
    const first = getConnections();
    const second = getConnections();
    expect(first).toBe(second);
  });

  it('rebuilds after resetConnections()', () => {
    const first = getConnections();
    resetConnections();
    const second = getConnections();
    expect(second).not.toBe(first);
  });
});
