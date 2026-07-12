import type { AppConfig } from '../config.js';
import {
  createConnections,
  getConnections,
  resetConnections,
  validateConnections,
} from './registry.js';
import type { Connection, ConnectionKind } from './types.js';

function stub(name: string, kind: ConnectionKind = 'local-corpus'): Connection<unknown> {
  return {
    name,
    kind,
    get: () => ({}),
    healthCheck: async () => ({ name, kind, ok: true }),
    close: async () => undefined,
  };
}

const configuredConfig: AppConfig['connections'] = {
  localCorpus: { rootDir: '' },
  postgres: { url: '' },
};

describe('validateConnections', () => {
  it('throws on duplicate names', () => {
    expect(() =>
      validateConnections([stub('a'), stub('a', 'postgres')]),
    ).toThrow(/Duplicate connection name: a/);
  });

  it('throws on an empty name', () => {
    expect(() => validateConnections([stub('')])).toThrow(/empty name/);
  });

  it('accepts unique, non-empty names', () => {
    expect(() =>
      validateConnections([stub('a'), stub('b', 'postgres')]),
    ).not.toThrow();
  });
});

describe('createConnections', () => {
  it('returns both connections with the correct kinds', () => {
    const registry = createConnections(configuredConfig);
    expect(registry.localCorpus.kind).toBe('local-corpus');
    expect(registry.postgres.kind).toBe('postgres');
  });

  it('all() returns exactly the two registered connections', () => {
    const registry = createConnections(configuredConfig);
    const all = registry.all();
    expect(all).toHaveLength(2);
    expect(all).toEqual(
      expect.arrayContaining([registry.localCorpus, registry.postgres]),
    );
  });

  it('healthCheckAll() returns two health results', async () => {
    // Use an unconfigured config so no real filesystem/network access happens.
    const registry = createConnections({
      localCorpus: { rootDir: '' },
      postgres: { url: '' },
    });
    const results = await registry.healthCheckAll();
    expect(results).toHaveLength(2);
    expect(results.map(r => r.kind)).toEqual(
      expect.arrayContaining(['local-corpus', 'postgres']),
    );
    // Both unconfigured, so both report ok:false.
    expect(results.every(r => r.ok === false)).toBe(true);
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
    expect(first).not.toBe(second);
  });
});
