import type { FastifyInstance } from 'fastify';
import { getConnections } from '../connections/registry.js';
import { DASHBOARD_PAGE } from './page.js';

/**
 * The ontology dashboard surface:
 *
 *   GET /visual-ontologies              — self-contained HTML page (no external assets)
 *   GET /visual-ontologies/ontology.rdf — the live ABox, RDF/XML (what the page consumes)
 *   GET /visual-ontologies/schema.owl   — the OWL TBox, RDF/XML
 *   GET /visual-ontologies/meta.json    — version, counts, history, pending guidance
 *
 * The page parses the .rdf file client-side (DOMParser) — the dashboard reads the same
 * datasource that is persisted to S3, not a bespoke JSON projection. Like the management
 * routes this surface is unauthenticated: ingress is Tailscale-gated, and the MCP bearer
 * token protects the tool endpoints, not the read-only visualization.
 */
export function registerVisualOntologies(server: FastifyInstance): void {
  server.get('/visual-ontologies', async (_request, reply) => {
    // The page is a single self-contained document: relax helmet's global CSP just here to
    // allow its inline script/style; everything else stays locked to same-origin fetches.
    return reply
      .header(
        'content-security-policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
          "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
      )
      .type('text/html; charset=utf-8')
      .send(DASHBOARD_PAGE);
  });

  server.get('/visual-ontologies/ontology.rdf', async (_request, reply) => {
    const xml = await getConnections().ontologyStore.get().dataXml();
    return reply.type('application/rdf+xml; charset=utf-8').send(xml);
  });

  server.get('/visual-ontologies/schema.owl', async (_request, reply) => {
    const xml = getConnections().ontologyStore.get().schemaXml();
    return reply.type('application/rdf+xml; charset=utf-8').send(xml);
  });

  server.get('/visual-ontologies/meta.json', async () => {
    const snapshot = await getConnections().ontologyStore.get().snapshot();
    return {
      version: snapshot.manifest.version,
      updated_at: snapshot.manifest.updated_at,
      nodes: snapshot.graph.nodes.size,
      edges: snapshot.graph.edges.length,
      pending_guidance: snapshot.manifest.pending_guidance,
      versions: snapshot.manifest.versions.slice(-10),
    };
  });
}
