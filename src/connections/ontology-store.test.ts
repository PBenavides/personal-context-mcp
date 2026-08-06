import { applyUpdate } from '../ontology/model.js';
import {
  createOntologyStoreConnection,
  type OntologyBackend,
} from './ontology-store.js';

function memoryBackend(): OntologyBackend & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    describe: () => 'memory',
    async read(key) {
      return files.get(key);
    },
    async write(key, body) {
      files.set(key, body);
    },
  };
}

const CONFIG = {
  source: 'file' as const,
  rootDir: 'unused',
  bucket: '',
  prefix: 'ontology/',
  region: 'us-east-1',
  syncEnabled: false,
  maxDocsPerRun: 25,
};

describe('ontology store', () => {
  it('bootstraps an empty snapshot when the backend has no manifest', async () => {
    const store = createOntologyStoreConnection(CONFIG, { backend: memoryBackend() }).get();
    const snapshot = await store.snapshot();
    expect(snapshot.manifest.version).toBe(0);
    expect(snapshot.graph.nodes.size).toBe(0);
  });

  it('persists on mutate and reloads the same state from the backend', async () => {
    const backend = memoryBackend();
    const store = createOntologyStoreConnection(CONFIG, { backend }).get();

    await store.mutate(async snapshot => {
      const result = applyUpdate(
        snapshot.graph,
        { nodes: [{ id: 'goal-a', class: 'Goal', label: 'A', attributes: { summary: 'a goal' } }] },
        '2026-07-19T10:00:00.000Z',
      );
      expect(result.ok).toBe(true);
      snapshot.embeddings['goal-a'] = [0.1, 0.2];
      return { persist: true, note: 'test', result: undefined };
    });

    expect(backend.files.has('schema.owl')).toBe(true);
    expect(backend.files.has('data.rdf')).toBe(true);
    expect(backend.files.has('versions/v1.rdf')).toBe(true);
    expect(backend.files.get('data.rdf')).toBe(backend.files.get('versions/v1.rdf'));

    // A second store over the same backend sees the persisted state.
    const reloaded = createOntologyStoreConnection(CONFIG, { backend }).get();
    const snapshot = await reloaded.snapshot();
    expect(snapshot.manifest.version).toBe(1);
    expect(snapshot.manifest.versions).toHaveLength(1);
    expect(snapshot.graph.nodes.get('goal-a')?.label).toBe('A');
    expect(snapshot.embeddings['goal-a']).toEqual([0.1, 0.2]);
  });

  it('bumps the version per persisted mutation and keeps every snapshot file', async () => {
    const backend = memoryBackend();
    const store = createOntologyStoreConnection(CONFIG, { backend }).get();
    for (const id of ['a', 'b']) {
      await store.mutate(async snapshot => {
        applyUpdate(
          snapshot.graph,
          { nodes: [{ id: `goal-${id}`, class: 'Goal', label: id }] },
          '2026-07-19T10:00:00.000Z',
        );
        return { persist: true, result: undefined };
      });
    }
    expect(backend.files.has('versions/v1.rdf')).toBe(true);
    expect(backend.files.has('versions/v2.rdf')).toBe(true);
    const snapshot = await store.snapshot();
    expect(snapshot.manifest.version).toBe(2);
  });

  it('does not persist when the mutation opts out', async () => {
    const backend = memoryBackend();
    const store = createOntologyStoreConnection(CONFIG, { backend }).get();
    await store.mutate(async () => ({ persist: false, result: undefined }));
    expect(backend.files.size).toBe(0);
  });

  it('serializes concurrent mutations (no interleaved read-modify-write)', async () => {
    const backend = memoryBackend();
    const store = createOntologyStoreConnection(CONFIG, { backend }).get();
    await Promise.all(
      ['x', 'y', 'z'].map(id =>
        store.mutate(async snapshot => {
          applyUpdate(
            snapshot.graph,
            { nodes: [{ id: `goal-${id}`, class: 'Goal', label: id }] },
            '2026-07-19T10:00:00.000Z',
          );
          return { persist: true, result: undefined };
        }),
      ),
    );
    const snapshot = await store.snapshot();
    expect(snapshot.graph.nodes.size).toBe(3);
    expect(snapshot.manifest.version).toBe(3);
  });
});
