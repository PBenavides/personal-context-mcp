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
  it('returns the enriched-corpus connection with the correct kind', () => {
    const registry = createConnections(configuredConfig);
    expect(registry.enrichedCorpus.kind).toBe('enriched-corpus');
    expect(registry.all()).toEqual([registry.enrichedCorpus]);
  });

  it('healthCheckAll() reports not-loaded before load()', async () => {
    const registry = createConnections(configuredConfig);
    const results = await registry.healthCheckAll();
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toMatch(/not loaded/);
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
