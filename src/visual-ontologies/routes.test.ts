import type { FastifyInstance } from 'fastify';
import { appConfig } from '../config.js';
import { getConnections, resetConnections } from '../connections/registry.js';
import { createContext } from '../context.js';
import { applyUpdate } from '../ontology/model.js';
import { buildServer } from '../server.js';

describe('/visual-ontologies', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    resetConnections();
    await getConnections().enrichedCorpus.load();
    // Seed one node through the store client (in-memory; file backend never written).
    await getConnections()
      .ontologyStore.get()
      .mutate(async snapshot => {
        applyUpdate(
          snapshot.graph,
          { nodes: [{ id: 'goal-demo', class: 'Goal', label: 'Demo goal' }] },
          '2026-07-19T10:00:00.000Z',
        );
        return { persist: false, result: undefined };
      });
    server = await buildServer(createContext(appConfig));
  });

  afterAll(async () => {
    await server.close();
    resetConnections();
  });

  it('serves the dashboard HTML without auth, with a page-scoped CSP', async () => {
    const res = await server.inject({ method: 'GET', url: '/visual-ontologies' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'unsafe-inline'/);
    expect(res.body).toContain('Ontology — personal context');
    expect(res.body).toContain('/visual-ontologies/ontology.rdf');
  });

  it('serves the live ABox as RDF/XML', async () => {
    const res = await server.inject({ method: 'GET', url: '/visual-ontologies/ontology.rdf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/rdf\+xml/);
    expect(res.body).toContain('<rdf:RDF');
    expect(res.body).toContain('goal-demo');
    expect(res.body).toContain('dcterms:modified');
  });

  it('serves the OWL TBox', async () => {
    const res = await server.inject({ method: 'GET', url: '/visual-ontologies/schema.owl' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<owl:Class');
    expect(res.body).toContain('owl:maxCardinality');
  });

  it('serves version metadata', async () => {
    const res = await server.inject({ method: 'GET', url: '/visual-ontologies/meta.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ nodes: 1, edges: 0, pending_guidance: [] });
  });
});
