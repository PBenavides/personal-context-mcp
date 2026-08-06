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
  ontology: {
    source: 'file',
    rootDir: 'tests/fixtures/ontology',
    bucket: '',
    prefix: 'ontology/',
    region: 'us-east-1',
    syncEnabled: false,
    maxDocsPerRun: 25,
  },
  openRouter: {
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatModel: 'openai/gpt-4o-mini',
    embedModel: 'openai/text-embedding-3-small',
  },
  ynab: {
    token: '',
    baseUrl: 'https://api.ynab.com/v1',
  },
  hevy: {
    apiKey: '',
    baseUrl: 'https://api.hevyapp.com',
  },
  googleCalendar: {
    refreshToken: '',
    clientId: '',
    clientSecret: '',
    baseUrl: 'https://www.googleapis.com/calendar/v3',
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
  it('returns all connections with the correct kinds', () => {
    const registry = createConnections(configuredConfig);
    expect(registry.enrichedCorpus.kind).toBe('enriched-corpus');
    expect(registry.vectorSearch.kind).toBe('vector-search');
    expect(registry.ontologyStore.kind).toBe('ontology-store');
    expect(registry.openRouter.kind).toBe('openrouter');
    expect(registry.ynab.kind).toBe('ynab');
    expect(registry.hevy.kind).toBe('hevy');
    expect(registry.googleCalendar.kind).toBe('google-calendar');
    expect(registry.all()).toEqual([
      registry.enrichedCorpus,
      registry.vectorSearch,
      registry.ontologyStore,
      registry.openRouter,
      registry.ynab,
      registry.hevy,
      registry.googleCalendar,
    ]);
  });

  it('healthCheckAll() reports corpus not-loaded before load(), the rest inert', async () => {
    const registry = createConnections(configuredConfig);
    const results = await registry.healthCheckAll();
    expect(results).toHaveLength(7);
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toMatch(/not loaded/);
    expect(results[1].ok).toBe(true);
    expect(results[1].detail).toMatch(/BM25/);
    expect(results[2].ok).toBe(true);
    expect(results[3].ok).toBe(true);
    expect(results[3].detail).toMatch(/not configured/);
    expect(results[4].ok).toBe(true);
    expect(results[4].detail).toMatch(/not configured/);
    expect(results[5].ok).toBe(true);
    expect(results[5].detail).toMatch(/not configured/);
    expect(results[6].ok).toBe(true);
    expect(results[6].detail).toMatch(/not configured/);
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
