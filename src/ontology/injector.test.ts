import type { FastifyBaseLogger } from 'fastify';
import type {
  CorpusManifest,
  EnrichedCorpusIndex,
  EnrichedDocument,
} from '../connections/enriched-corpus.js';
import {
  createOntologyStoreConnection,
  type OntologyBackend,
  type OntologyStoreClient,
} from '../connections/ontology-store.js';
import type { OpenRouterClient } from '../connections/openrouter.js';
import { MAX_ITERATIONS, runOntologySync } from './injector.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => logger,
  level: 'silent',
} as unknown as FastifyBaseLogger;

function fakeCorpus(docs: Record<string, { body: string; category: string }>): EnrichedCorpusIndex {
  const manifest: CorpusManifest = {
    taxonomy_version: 't1',
    run_id: 'r1',
    run_mode: 'batch',
    generated_at: '2026-07-19T00:00:00Z',
    files: Object.fromEntries(
      Object.entries(docs).map(([path, d]) => [
        path,
        { body_hash: `hash-${d.body.length}`, category: d.category, enriched_at: '2026-07-19' },
      ]),
    ),
  };
  const byPath = new Map<string, EnrichedDocument>(
    Object.entries(docs).map(([path, d]) => [
      path,
      {
        path,
        category: d.category,
        summary: d.body.slice(0, 50),
        entities: [],
        body: d.body,
        raw: d.body,
      },
    ]),
  );
  return {
    manifest,
    docCount: () => byPath.size,
    search: () => [],
    getDocument: path => byPath.get(path),
    categoryCounts: () => ({}),
  };
}

function memoryStore(): OntologyStoreClient {
  const files = new Map<string, string>();
  const backend: OntologyBackend = {
    describe: () => 'memory',
    read: async key => files.get(key),
    write: async (key, body) => void files.set(key, body),
  };
  return createOntologyStoreConnection(
    {
      source: 'file',
      rootDir: 'unused',
      bucket: '',
      prefix: '',
      region: 'us-east-1',
      syncEnabled: false,
      maxDocsPerRun: 25,
    },
    { backend },
  ).get();
}

/** Scripted LLM: returns each response in order, then repeats the last one. */
function scriptedLlm(responses: unknown[]): OpenRouterClient & { calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    async chatJson({ user }) {
      calls.push(user);
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    },
    async embed(texts) {
      return texts.map(() => [0.5, 0.5]);
    },
  };
}

const GOOD_PROPOSAL = {
  action: 'update',
  nodes: [
    {
      id: 'goal-debt-free',
      class: 'Goal',
      label: 'Debt free',
      attributes: { summary: 'Become debt free', status: 'active', sourcePath: 'notes/goal.md' },
    },
  ],
  edges: [],
};

describe('runOntologySync', () => {
  it('reports unconfigured when OpenRouter is absent', async () => {
    const report = await runOntologySync(
      { corpus: fakeCorpus({}), store: memoryStore(), openRouter: undefined, logger },
      { maxDocsPerRun: 25 },
    );
    expect(report.ran).toBe(false);
    expect(report.reason).toMatch(/OPENROUTER_API_KEY/);
  });

  it('routes a document first try and persists one new version with embeddings', async () => {
    const store = memoryStore();
    const llm = scriptedLlm([GOOD_PROPOSAL]);
    const report = await runOntologySync(
      { corpus: fakeCorpus({ 'notes/goal.md': { body: 'I want to be debt free', category: 'Goal' } }), store, openRouter: llm, logger },
      { maxDocsPerRun: 25 },
    );
    expect(report.ran).toBe(true);
    expect(report.processed).toEqual(['notes/goal.md']);
    expect(report.version).toBe(1);
    const snapshot = await store.snapshot();
    expect(snapshot.graph.nodes.get('goal-debt-free')?.class).toBe('Goal');
    expect(snapshot.manifest.processed['notes/goal.md']).toBeDefined();
    expect(snapshot.embeddings['goal-debt-free']).toEqual([0.5, 0.5]);
  });

  it('feeds validation errors back and succeeds on a corrected retry', async () => {
    const store = memoryStore();
    const llm = scriptedLlm([
      { action: 'update', nodes: [{ id: 'goal-x', class: 'Wish' }] }, // invalid class
      GOOD_PROPOSAL,
    ]);
    const report = await runOntologySync(
      { corpus: fakeCorpus({ 'notes/goal.md': { body: 'debt free', category: 'Goal' } }), store, openRouter: llm, logger },
      { maxDocsPerRun: 25 },
    );
    expect(report.processed).toEqual(['notes/goal.md']);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]).toMatch(/unknown class "Wish"/);
  });

  it('parks a document after MAX_ITERATIONS failures with an elicitation question', async () => {
    const store = memoryStore();
    const llm = scriptedLlm([{ action: 'update', nodes: [{ id: 'x', class: 'Nope' }] }]);
    const report = await runOntologySync(
      { corpus: fakeCorpus({ 'notes/odd.md': { body: 'strange', category: 'Situation' } }), store, openRouter: llm, logger },
      { maxDocsPerRun: 25 },
    );
    expect(llm.calls).toHaveLength(MAX_ITERATIONS);
    expect(report.processed).toEqual([]);
    expect(report.pending_guidance).toHaveLength(1);
    expect(report.pending_guidance[0].question).toMatch(/How should this document be modeled/);
    expect(report.failed[0].errors.join('\n')).toMatch(/unknown class/);
  });

  it('parks immediately when the model asks for guidance, and skips the doc next run', async () => {
    const store = memoryStore();
    const corpus = fakeCorpus({ 'notes/odd.md': { body: 'strange', category: 'Situation' } });
    const llm = scriptedLlm([{ action: 'needs_guidance', question: 'Is this a Project or a Situation?' }]);
    const first = await runOntologySync({ corpus, store, openRouter: llm, logger }, { maxDocsPerRun: 25 });
    expect(first.pending_guidance[0]).toMatchObject({
      path: 'notes/odd.md',
      question: 'Is this a Project or a Situation?',
      attempts: 1,
    });

    // Without guidance the parked doc is not retried.
    const second = await runOntologySync({ corpus, store, openRouter: llm, logger }, { maxDocsPerRun: 25 });
    expect(llm.calls).toHaveLength(1);
    expect(second.pending_guidance).toHaveLength(1);
  });

  it('guidance answers re-enter the loop and clear the pending queue', async () => {
    const store = memoryStore();
    const corpus = fakeCorpus({ 'notes/odd.md': { body: 'strange', category: 'Situation' } });
    const asker = scriptedLlm([{ action: 'needs_guidance', question: 'What is this?' }]);
    await runOntologySync({ corpus, store, openRouter: asker, logger }, { maxDocsPerRun: 25 });

    const resolver = scriptedLlm([GOOD_PROPOSAL]);
    const report = await runOntologySync(
      { corpus, store, openRouter: resolver, logger },
      { maxDocsPerRun: 25, guidance: { 'notes/odd.md': 'Model it as the Goal debt-free.' } },
    );
    expect(resolver.calls[0]).toMatch(/HUMAN GUIDANCE/);
    expect(resolver.calls[0]).toMatch(/Model it as the Goal debt-free/);
    expect(report.processed).toEqual(['notes/odd.md']);
    expect(report.pending_guidance).toHaveLength(0);
  });

  it('skips unchanged documents on a second run (hash gate)', async () => {
    const store = memoryStore();
    const corpus = fakeCorpus({ 'notes/goal.md': { body: 'debt free', category: 'Goal' } });
    const llm = scriptedLlm([GOOD_PROPOSAL]);
    await runOntologySync({ corpus, store, openRouter: llm, logger }, { maxDocsPerRun: 25 });
    const second = await runOntologySync({ corpus, store, openRouter: llm, logger }, { maxDocsPerRun: 25 });
    expect(llm.calls).toHaveLength(1);
    expect(second.processed).toEqual([]);
    expect(second.version).toBe(1); // nothing new persisted
  });

  it('honors maxDocsPerRun', async () => {
    const store = memoryStore();
    const corpus = fakeCorpus({
      'notes/a.md': { body: 'a', category: 'Goal' },
      'notes/b.md': { body: 'b', category: 'Goal' },
      'notes/c.md': { body: 'c', category: 'Goal' },
    });
    const llm = scriptedLlm([GOOD_PROPOSAL]);
    const report = await runOntologySync({ corpus, store, openRouter: llm, logger }, { maxDocsPerRun: 2 });
    expect(report.processed).toHaveLength(2);
  });
});
