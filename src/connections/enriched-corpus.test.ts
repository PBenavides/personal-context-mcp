import { jest } from '@jest/globals';
import type { FastifyBaseLogger } from 'fastify';
import {
  createEnrichedCorpusConnection,
  createFileSource,
  loadCorpus,
  type CorpusManifest,
  type CorpusSource,
} from './enriched-corpus.js';

const FIXTURES = 'tests/fixtures/enriched';

function fileConfig(overrides: Partial<{ refreshSeconds: number }> = {}): Parameters<
  typeof createEnrichedCorpusConnection
>[0] {
  return {
    source: 'file',
    rootDir: FIXTURES,
    bucket: '',
    prefix: '',
    region: 'us-east-1',
    refreshSeconds: overrides.refreshSeconds ?? 0,
  };
}

describe('loadCorpus (file source over fixtures)', () => {
  it('loads every manifest entry, notes and events alike', async () => {
    const corpus = await loadCorpus(createFileSource(FIXTURES));
    expect(corpus.docCount()).toBe(7);
    expect(corpus.manifest.run_id).toBe('run-fixture-001');
  });

  it('parses note frontmatter into document metadata', async () => {
    const corpus = await loadCorpus(createFileSource(FIXTURES));
    const doc = corpus.getDocument('notes/_pipeline_sentinel.md');
    expect(doc).toBeDefined();
    expect(doc?.category).toBe('Goal');
    expect(doc?.horizon).toBe('standing');
    expect(doc?.status).toBe('active');
    expect(doc?.salience).toBe(0.9);
    expect(doc?.entities).toContain('[[personal context pipeline]]');
    expect(doc?.body).toContain('Sentinel goal');
    expect(doc?.body).not.toContain('body_hash');
    expect(doc?.raw).toContain('body_hash');
  });

  it('renders event JSON into a searchable document with past/done defaults', async () => {
    const corpus = await loadCorpus(createFileSource(FIXTURES));
    const doc = corpus.getDocument('events/english-collector/2026-07-12.json');
    expect(doc?.category).toBe('Event');
    expect(doc?.horizon).toBe('past');
    expect(doc?.status).toBe('done');
    expect(doc?.body).toContain('word_collected');
    expect(doc?.body).toContain('ubiquitous');
  });

  it('search ranks by BM25 and applies category/status/horizon filters', async () => {
    const corpus = await loadCorpus(createFileSource(FIXTURES));

    const knee = corpus.search('knee physiotherapy', {}, 10);
    expect(knee[0].doc.path).toBe('notes/health/knee-rehab.md');

    // "pipeline" matches both the sentinel Goal and the Project note; the filter disambiguates.
    const goalsOnly = corpus.search('pipeline', { category: 'Goal' }, 10);
    expect(goalsOnly.map(hit => hit.doc.path)).toEqual(['notes/_pipeline_sentinel.md']);

    const dormant = corpus.search('blog project', { status: 'dormant' }, 10);
    expect(dormant.map(hit => hit.doc.path)).toEqual(['notes/projects/old-blog.md']);

    const pastEvents = corpus.search('word collected', { horizon: 'past' }, 10);
    expect(pastEvents.length).toBeGreaterThan(0);
    expect(pastEvents.every(hit => hit.doc.path.startsWith('events/'))).toBe(true);
  });

  it('filters are case-insensitive', async () => {
    const corpus = await loadCorpus(createFileSource(FIXTURES));
    const hits = corpus.search('pipeline', { category: 'goal' }, 10);
    expect(hits.map(hit => hit.doc.path)).toEqual(['notes/_pipeline_sentinel.md']);
  });

  it('categoryCounts derives counts from the manifest', async () => {
    const corpus = await loadCorpus(createFileSource(FIXTURES));
    expect(corpus.categoryCounts()).toEqual({
      Event: 2,
      Goal: 1,
      HealthCondition: 1,
      Project: 2,
      Habit: 1,
    });
  });
});

/** In-memory source whose manifest can be swapped, to drive the refresh logic. */
function fakeSource(): {
  source: CorpusSource;
  setRunId: (runId: string) => void;
  failNextManifestRead: () => void;
} {
  let runId = 'run-1';
  let failNext = false;
  const note = '---\ncategory: Goal\nsummary: s\n---\nbody text';
  const manifest = (): CorpusManifest => ({
    taxonomy_version: 't1',
    run_id: runId,
    run_mode: 'batch',
    generated_at: 'now',
    files: { 'notes/a.md': { body_hash: 'h', category: 'Goal', enriched_at: 'now' } },
  });
  return {
    source: {
      describe: () => 'fake',
      async readText(key: string): Promise<string> {
        if (key === 'manifest.json') {
          if (failNext) {
            failNext = false;
            throw new Error('boom');
          }
          return JSON.stringify(manifest());
        }
        return note;
      },
    },
    setRunId: (next: string) => {
      runId = next;
    },
    failNextManifestRead: () => {
      failNext = true;
    },
  };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as FastifyBaseLogger;

describe('createEnrichedCorpusConnection lifecycle', () => {
  it('get() throws before load() and returns the index after', async () => {
    const conn = createEnrichedCorpusConnection(fileConfig());
    expect(() => conn.get()).toThrow(/not loaded/);
    await conn.load();
    expect(conn.get().docCount()).toBe(7);
    await conn.close();
  });

  it('refresh reloads only when the manifest run_id changes', async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeSource();
      const conn = createEnrichedCorpusConnection(fileConfig(), {
        source: fake.source,
        refreshSeconds: 1,
      });
      await conn.load();
      const first = conn.get();

      conn.startRefresh(silentLogger);
      await jest.advanceTimersByTimeAsync(1100);
      expect(conn.get()).toBe(first); // same run_id → same snapshot

      fake.setRunId('run-2');
      await jest.advanceTimersByTimeAsync(1100);
      expect(conn.get()).not.toBe(first);
      expect(conn.get().manifest.run_id).toBe('run-2');

      await conn.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failed refresh keeps serving the previous snapshot', async () => {
    jest.useFakeTimers();
    try {
      const fake = fakeSource();
      const conn = createEnrichedCorpusConnection(fileConfig(), {
        source: fake.source,
        refreshSeconds: 1,
      });
      await conn.load();
      const first = conn.get();

      conn.startRefresh(silentLogger);
      fake.setRunId('run-2');
      fake.failNextManifestRead();
      await jest.advanceTimersByTimeAsync(1100);
      expect(conn.get()).toBe(first); // failure → old snapshot survives

      await jest.advanceTimersByTimeAsync(1100);
      expect(conn.get().manifest.run_id).toBe('run-2'); // next tick recovers

      await conn.close();
    } finally {
      jest.useRealTimers();
    }
  });
});
