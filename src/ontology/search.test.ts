import type { OntologySnapshot } from '../connections/ontology-store.js';
import type { OpenRouterClient } from '../connections/openrouter.js';
import { applyUpdate, emptyGraph } from './model.js';
import { cosine, searchOntology } from './search.js';

const T1 = '2026-07-19T10:00:00.000Z';

function snapshot(embeddings: Record<string, number[]> = {}): OntologySnapshot {
  const graph = emptyGraph();
  applyUpdate(
    graph,
    {
      nodes: [
        { id: 'goal-debt-free', class: 'Goal', label: 'Debt free', attributes: { summary: 'Pay off all debt' } },
        { id: 'project-2026', class: 'Project', label: 'Project 2026', attributes: { summary: 'Yearly master plan' } },
        { id: 'anna', class: 'Person', label: 'Anna' },
      ],
      edges: [
        { subject: 'project-2026', predicate: 'contributesTo', object: 'goal-debt-free' },
        { subject: 'project-2026', predicate: 'involvesPerson', object: 'anna' },
      ],
    },
    T1,
  );
  return {
    graph,
    manifest: {
      version: 3,
      updated_at: T1,
      embed_model: 'test',
      versions: [],
      processed: {},
      pending_guidance: [],
    },
    embeddings,
  };
}

describe('cosine', () => {
  it('is 1 for identical directions and 0 for orthogonal', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe('searchOntology (keyword fallback)', () => {
  it('ranks by token overlap and expands one hop of neighborhood', async () => {
    const result = await searchOntology(snapshot(), undefined, { query: 'debt' });
    expect(result.mode).toBe('keyword');
    expect(result.version).toBe(3);
    expect(result.matches[0].id).toBe('goal-debt-free');
    expect(result.matches[0].attributes[0]).toMatchObject({ property: 'summary', modified: T1 });
    // 1 hop pulls in project-2026 via contributesTo.
    expect(result.edges.map(e => e.predicate)).toContain('contributesTo');
    expect(result.neighbors.map(n => n.id)).toContain('project-2026');
  });

  it('hops=0 returns matches only', async () => {
    const result = await searchOntology(snapshot(), undefined, { query: 'debt', hops: 0 });
    expect(result.edges).toHaveLength(0);
    expect(result.neighbors).toHaveLength(0);
  });

  it('class filter restricts matches but not neighbors', async () => {
    const result = await searchOntology(snapshot(), undefined, {
      query: 'project 2026 plan',
      classes: ['Project'],
    });
    expect(result.matches.map(m => m.id)).toEqual(['project-2026']);
    expect(result.neighbors.map(n => n.id).sort()).toEqual(['anna', 'goal-debt-free']);
  });
});

describe('searchOntology (semantic)', () => {
  const embedded: OpenRouterClient = {
    async chatJson() {
      return {};
    },
    async embed(texts) {
      return texts.map(() => [1, 0]);
    },
  };

  it('ranks by cosine similarity against stored embeddings', async () => {
    const result = await searchOntology(
      snapshot({ 'goal-debt-free': [1, 0], 'project-2026': [0, 1], anna: [0.7, 0.7] }),
      embedded,
      { query: 'anything', limit: 2 },
    );
    expect(result.mode).toBe('semantic');
    expect(result.matches.map(m => m.id)).toEqual(['goal-debt-free', 'anna']);
  });

  it('falls back to keyword when the embed call fails', async () => {
    const failing: OpenRouterClient = {
      async chatJson() {
        return {};
      },
      async embed() {
        throw new Error('boom');
      },
    };
    const result = await searchOntology(snapshot({ 'goal-debt-free': [1, 0] }), failing, {
      query: 'debt',
    });
    expect(result.mode).toBe('keyword');
    expect(result.matches[0].id).toBe('goal-debt-free');
  });
});
