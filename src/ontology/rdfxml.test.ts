import { applyUpdate, emptyGraph, type OntologyGraph } from './model.js';
import { parseGraph, serializeGraph, serializeSchema } from './rdfxml.js';

const T1 = '2026-07-19T10:00:00.000Z';
const T2 = '2026-07-19T11:00:00.000Z';

function sample(): OntologyGraph {
  const graph = emptyGraph();
  applyUpdate(
    graph,
    {
      nodes: [
        {
          id: 'project-2026',
          class: 'Project',
          label: 'Project <2026> & "friends"',
          attributes: { summary: 'Plan & <escape> test', status: 'active', salience: 0.8 },
        },
        { id: 'goal-debt-free', class: 'Goal', label: 'Debt free' },
        { id: 'anna', class: 'Person', label: 'Anna' },
      ],
      edges: [
        { subject: 'project-2026', predicate: 'contributesTo', object: 'goal-debt-free' },
        { subject: 'project-2026', predicate: 'involvesPerson', object: 'anna' },
      ],
    },
    T1,
  );
  applyUpdate(
    graph,
    { attributes: [{ nodeId: 'project-2026', property: 'summary', value: 'Updated plan' }] },
    T2,
  );
  return graph;
}

describe('serializeSchema', () => {
  const xml = serializeSchema();

  it('declares every class as an owl:Class under PersonalEntity', () => {
    expect(xml).toContain('<owl:Class rdf:about="https://pbenavides.dev/ontology/personal-context#Project">');
    expect(xml).toContain('rdfs:subClassOf rdf:resource="https://pbenavides.dev/ontology/personal-context#PersonalEntity"');
  });

  it('declares datatype properties with functional marking and ranges', () => {
    expect(xml).toContain('<owl:DatatypeProperty rdf:about="https://pbenavides.dev/ontology/personal-context#summary">');
    expect(xml).toContain('<rdf:type rdf:resource="http://www.w3.org/2002/07/owl#FunctionalProperty"/>');
    expect(xml).toContain('rdfs:range rdf:resource="http://www.w3.org/2001/XMLSchema#decimal"');
  });

  it('declares object properties and the milestoneOf cardinality restriction', () => {
    expect(xml).toContain('<owl:ObjectProperty rdf:about="https://pbenavides.dev/ontology/personal-context#milestoneOf">');
    expect(xml).toContain('<owl:Restriction>');
    expect(xml).toContain('owl:maxCardinality');
  });
});

describe('serializeGraph / parseGraph round trip', () => {
  it('round-trips nodes, attributes, edges, and all timestamps', () => {
    const graph = sample();
    const xml = serializeGraph(graph);
    const back = parseGraph(xml);

    expect(back.nodes.size).toBe(3);
    const project = back.nodes.get('project-2026')!;
    expect(project.class).toBe('Project');
    expect(project.label).toBe('Project <2026> & "friends"');
    expect(project.created).toBe(T1);
    expect(project.modified).toBe(T2);

    const summary = project.attributes.find(a => a.property === 'summary')!;
    expect(summary).toMatchObject({ value: 'Updated plan', created: T1, modified: T2 });
    const salience = project.attributes.find(a => a.property === 'salience')!;
    expect(salience.value).toBe(0.8);

    expect(back.edges).toHaveLength(2);
    const edge = back.edges.find(e => e.predicate === 'contributesTo')!;
    expect(edge).toMatchObject({
      subject: 'project-2026',
      object: 'goal-debt-free',
      created: T1,
      modified: T1,
    });
  });

  it('serializes reified statements carrying per-assertion timestamps', () => {
    const xml = serializeGraph(sample());
    expect(xml).toContain('<rdf:Statement');
    expect(xml).toContain('<rdf:predicate rdf:resource="https://pbenavides.dev/ontology/personal-context#summary"/>');
    // The updated attribute's statement carries T2 while the node keeps created T1.
    expect(xml).toContain(T2);
  });

  it('parses an empty document into an empty graph', () => {
    const back = parseGraph(serializeGraph(emptyGraph()));
    expect(back.nodes.size).toBe(0);
    expect(back.edges).toHaveLength(0);
  });
});
