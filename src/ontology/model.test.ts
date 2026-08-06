import { applyUpdate, cloneGraph, emptyGraph, type OntologyGraph } from './model.js';

const T1 = '2026-07-19T10:00:00.000Z';
const T2 = '2026-07-19T11:00:00.000Z';

function seeded(): OntologyGraph {
  const graph = emptyGraph();
  const result = applyUpdate(
    graph,
    {
      nodes: [
        { id: 'project-2026', class: 'Project', label: 'Project 2026', attributes: { summary: 'The plan', status: 'active' } },
        { id: 'goal-debt-free', class: 'Goal', label: 'Debt free' },
        { id: 'ms-v1', class: 'Milestone', label: 'V1 shipped' },
      ],
      edges: [
        { subject: 'project-2026', predicate: 'contributesTo', object: 'goal-debt-free' },
        { subject: 'ms-v1', predicate: 'milestoneOf', object: 'project-2026' },
      ],
    },
    T1,
  );
  expect(result.ok).toBe(true);
  return graph;
}

describe('applyUpdate validation', () => {
  it('rejects unknown classes, properties, and malformed ids in one report', () => {
    const graph = emptyGraph();
    const result = applyUpdate(
      graph,
      {
        nodes: [
          { id: 'Bad_ID', class: 'Project' },
          { id: 'x', class: 'Spaceship' },
          { id: 'y', class: 'Person', attributes: { flavor: 'sweet' } },
        ],
      },
      T1,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/lowercase slug/);
    expect(result.errors.join('\n')).toMatch(/unknown class "Spaceship"/);
    expect(result.errors.join('\n')).toMatch(/unknown datatype property "flavor"/);
    expect(graph.nodes.size).toBe(0);
  });

  it('rejects closed-vocabulary violations and wrong value types', () => {
    const result = applyUpdate(
      emptyGraph(),
      {
        nodes: [
          { id: 'a', class: 'Goal', attributes: { status: 'thriving', salience: 'high' } },
        ],
      },
      T1,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/not in closed vocabulary/);
    expect(result.errors.join('\n')).toMatch(/expects a number/);
  });

  it('enforces property domains (situationShape only on Situation)', () => {
    const result = applyUpdate(
      emptyGraph(),
      { nodes: [{ id: 'a', class: 'Goal', attributes: { situationShape: 'Task' } }] },
      T1,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/applies to Situation, not Goal/);
  });

  it('enforces edge domain/range', () => {
    const graph = seeded();
    const result = applyUpdate(
      graph,
      { edges: [{ subject: 'goal-debt-free', predicate: 'contributesTo', object: 'project-2026' }] },
      T2,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/requires subject of class Project/);
  });

  it('enforces maxCardinality on milestoneOf', () => {
    const graph = seeded();
    applyUpdate(
      graph,
      { nodes: [{ id: 'project-other', class: 'Project', label: 'Other' }] },
      T2,
    );
    const result = applyUpdate(
      graph,
      { edges: [{ subject: 'ms-v1', predicate: 'milestoneOf', object: 'project-other' }] },
      T2,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/cardinality violation/);
  });

  it('rejects re-typing an existing node', () => {
    const graph = seeded();
    const result = applyUpdate(graph, { nodes: [{ id: 'ms-v1', class: 'Event' }] }, T2);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/cannot re-type/);
  });
});

describe('applyUpdate timestamps', () => {
  it('stamps created/modified on new nodes, attributes, and edges', () => {
    const graph = seeded();
    const project = graph.nodes.get('project-2026')!;
    expect(project.created).toBe(T1);
    expect(project.modified).toBe(T1);
    expect(project.attributes.find(a => a.property === 'summary')).toMatchObject({
      created: T1,
      modified: T1,
    });
    expect(graph.edges[0]).toMatchObject({ created: T1, modified: T1 });
  });

  it('bumps modified only when a functional value actually changes', () => {
    const graph = seeded();
    const same = applyUpdate(
      graph,
      { attributes: [{ nodeId: 'project-2026', property: 'summary', value: 'The plan' }] },
      T2,
    );
    expect(same.ok).toBe(true);
    expect(same.changedNodeIds).toEqual([]);
    expect(graph.nodes.get('project-2026')!.modified).toBe(T1);

    const changed = applyUpdate(
      graph,
      { attributes: [{ nodeId: 'project-2026', property: 'summary', value: 'The new plan' }] },
      T2,
    );
    expect(changed.ok).toBe(true);
    const summary = graph.nodes.get('project-2026')!.attributes.find(a => a.property === 'summary')!;
    expect(summary).toMatchObject({ value: 'The new plan', created: T1, modified: T2 });
    expect(graph.nodes.get('project-2026')!.modified).toBe(T2);
  });

  it('appends multi-valued attributes without duplicating equal values', () => {
    const graph = seeded();
    applyUpdate(
      graph,
      { attributes: [{ nodeId: 'project-2026', property: 'sourcePath', value: 'notes/a.md' }] },
      T1,
    );
    applyUpdate(
      graph,
      {
        attributes: [
          { nodeId: 'project-2026', property: 'sourcePath', value: 'notes/a.md' },
          { nodeId: 'project-2026', property: 'sourcePath', value: 'notes/b.md' },
        ],
      },
      T2,
    );
    const paths = graph.nodes
      .get('project-2026')!
      .attributes.filter(a => a.property === 'sourcePath');
    expect(paths.map(p => p.value).sort()).toEqual(['notes/a.md', 'notes/b.md']);
    expect(paths.find(p => p.value === 'notes/a.md')!.modified).toBe(T1);
  });

  it('removals drop nodes with their incident edges', () => {
    const graph = seeded();
    const result = applyUpdate(graph, { removeNodes: ['project-2026'] }, T2);
    expect(result.ok).toBe(true);
    expect(result.nodesRemoved).toBe(1);
    expect(graph.nodes.has('project-2026')).toBe(false);
    expect(graph.edges).toHaveLength(0);
  });
});

describe('cloneGraph', () => {
  it('is a deep copy', () => {
    const graph = seeded();
    const copy = cloneGraph(graph);
    applyUpdate(
      copy,
      { attributes: [{ nodeId: 'project-2026', property: 'summary', value: 'changed' }] },
      T2,
    );
    expect(graph.nodes.get('project-2026')!.attributes.find(a => a.property === 'summary')!.value).toBe(
      'The plan',
    );
  });
});
