import type { FastifyBaseLogger } from 'fastify';
import type { EnrichedCorpusIndex, EnrichedDocument } from '../connections/enriched-corpus.js';
import type { OpenRouterClient } from '../connections/openrouter.js';
import type {
  OntologySnapshot,
  OntologyStoreClient,
  PendingGuidance,
} from '../connections/ontology-store.js';
import { applyUpdate, nodeText, type UpdateInput } from './model.js';
import { keywordRank } from './search.js';
import { describeVocabulary } from './vocabulary.js';

/**
 * The injector layer: routes free-text enriched documents (Obsidian notes + activity events,
 * already taxonomy-classified by the pipeline) into the ontology registry.
 *
 * Per document it runs a discovery loop of at most {@link MAX_ITERATIONS} LLM turns: propose a
 * graph update → validate against the vocabulary (classes, domains/ranges, cardinalities) →
 * on errors, feed them back verbatim and retry. A document that exhausts its iterations — or
 * where the model explicitly asks for help — lands in the pending-guidance queue, the
 * elicitation surface: `ontology_sync` reports the queued questions and accepts human
 * `guidance` answers that re-enter the loop with the hint prepended.
 *
 * One sync run = at most one persisted ontology version (single save at the end).
 */

export const MAX_ITERATIONS = 5;
const BODY_EXCERPT = 3500;
const RELATED_NODES = 8;

const RESPONSE_CONTRACT = `Respond with ONE JSON object, no prose. Either:
{"action":"update","nodes":[{"id":"<slug>","class":"<Class>","label":"<name>","attributes":{"summary":"...","status":"active"}}],"edges":[{"subject":"<slug>","predicate":"<objectProperty>","object":"<slug>"}]}
or, when you genuinely cannot decide how this content maps onto the ontology:
{"action":"needs_guidance","question":"<one concrete question for the human>"}

Rules:
- node ids are lowercase slugs (a-z, 0-9, hyphens); reuse an existing node's id to enrich it, never invent a near-duplicate.
- every node needs class + label; put a one-sentence "summary" attribute on new nodes.
- add a "sourcePath" attribute with the document path on every node you create or enrich.
- edges may only use the object properties listed, respecting their domain/range/cardinality.
- extract only what the text supports; fewer, well-typed assertions beat many speculative ones.`;

export interface SyncReport {
  ran: boolean;
  reason?: string;
  processed: string[];
  failed: { path: string; errors: string[] }[];
  pending_guidance: PendingGuidance[];
  version: number;
  nodes: number;
  edges: number;
  duration_ms: number;
}

export interface SyncOptions {
  /** Human elicitation answers: document path → instruction, re-enters the loop. */
  guidance?: Record<string, string>;
  /** Re-route every document regardless of processed hashes. */
  force?: boolean;
  maxDocsPerRun: number;
}

interface Proposal {
  action?: string;
  question?: string;
  nodes?: UpdateInput['nodes'];
  edges?: UpdateInput['edges'];
}

function docPrompt(
  doc: EnrichedDocument,
  snapshot: OntologySnapshot,
  errors: string[],
  guidance: string | undefined,
): string {
  const related = keywordRank(
    [...snapshot.graph.nodes.values()],
    `${doc.summary} ${doc.entities.join(' ')} ${doc.path}`,
    RELATED_NODES,
  );
  const sections: string[] = [];
  if (guidance) {
    sections.push(`HUMAN GUIDANCE (follow it — it overrides your own judgment):\n${guidance}`);
  }
  sections.push(
    `Document to route:\npath: ${doc.path}\ntaxonomy category: ${doc.category}\n` +
      `summary: ${doc.summary}\nentities: ${doc.entities.join(', ') || '(none)'}\n` +
      `body:\n${doc.body.slice(0, BODY_EXCERPT)}`,
  );
  sections.push(
    related.length
      ? `Existing nodes likely related (reuse their ids where they refer to the same thing):\n` +
          related.map(r => `- ${r.node.id}: ${nodeText(r.node).replace(/\n/g, ' | ')}`).join('\n')
      : 'The ontology has no obviously related nodes yet.',
  );
  if (errors.length) {
    sections.push(
      `Your previous proposal was rejected by the validator. Fix ALL of these:\n` +
        errors.map(e => `- ${e}`).join('\n'),
    );
  }
  return sections.join('\n\n');
}

function systemPrompt(): string {
  return (
    'You are the injector for a personal-context ontology (OWL). You convert one document ' +
    'into a small, precise graph update.\n\n' +
    describeVocabulary() +
    '\n\n' +
    RESPONSE_CONTRACT
  );
}

/** Routes one document; mutates `snapshot.graph` on success. */
async function routeDocument(
  doc: EnrichedDocument,
  snapshot: OntologySnapshot,
  llm: OpenRouterClient,
  guidance: string | undefined,
  logger: FastifyBaseLogger,
): Promise<
  | { outcome: 'ok'; changedNodeIds: string[] }
  | { outcome: 'guidance'; question: string; attempts: number; errors: string[] }
  | { outcome: 'failed'; errors: string[] }
> {
  let errors: string[] = [];
  for (let attempt = 1; attempt <= MAX_ITERATIONS; attempt++) {
    let proposal: Proposal;
    try {
      proposal = (await llm.chatJson({
        system: systemPrompt(),
        user: docPrompt(doc, snapshot, errors, guidance),
      })) as Proposal;
    } catch (error) {
      errors = [`LLM call failed: ${error instanceof Error ? error.message : String(error)}`];
      continue;
    }

    if (proposal.action === 'needs_guidance') {
      return {
        outcome: 'guidance',
        question: proposal.question?.trim() || 'How should this document map onto the ontology?',
        attempts: attempt,
        errors,
      };
    }

    const result = applyUpdate(
      snapshot.graph,
      { nodes: proposal.nodes ?? [], edges: proposal.edges ?? [] },
      new Date().toISOString(),
    );
    if (result.ok) {
      logger.debug(
        { path: doc.path, attempt, nodes: result.nodesCreated, edges: result.edgesCreated },
        'injector routed document',
      );
      return { outcome: 'ok', changedNodeIds: result.changedNodeIds };
    }
    errors = result.errors;
  }
  return { outcome: 'failed', errors };
}

/** Documents whose body hash is new or changed since they were last routed. */
function selectDocs(
  corpus: EnrichedCorpusIndex,
  snapshot: OntologySnapshot,
  options: SyncOptions,
): string[] {
  const guided = new Set(Object.keys(options.guidance ?? {}));
  const pending = new Set(snapshot.manifest.pending_guidance.map(p => p.path));
  return Object.entries(corpus.manifest.files)
    .filter(([path, entry]) => {
      if (guided.has(path)) {
        return true;
      }
      if (pending.has(path)) {
        return false; // parked until the human answers
      }
      if (options.force) {
        return true;
      }
      return snapshot.manifest.processed[path]?.body_hash !== entry.body_hash;
    })
    .map(([path]) => path)
    .sort((a, b) => (guided.has(a) === guided.has(b) ? a.localeCompare(b) : guided.has(a) ? -1 : 1))
    .slice(0, options.maxDocsPerRun);
}

/**
 * One injector run over the enriched corpus. Persists at most one new ontology version;
 * returns the report the `ontology_sync` tool relays (including open elicitation questions).
 */
export async function runOntologySync(
  deps: {
    corpus: EnrichedCorpusIndex;
    store: OntologyStoreClient;
    openRouter: OpenRouterClient | undefined;
    logger: FastifyBaseLogger;
  },
  options: SyncOptions,
): Promise<SyncReport> {
  const started = Date.now();
  const { corpus, store, openRouter, logger } = deps;
  if (!openRouter) {
    const snapshot = await store.snapshot();
    return {
      ran: false,
      reason: 'OpenRouter is not configured (OPENROUTER_API_KEY unset); injector cannot route documents',
      processed: [],
      failed: [],
      pending_guidance: snapshot.manifest.pending_guidance,
      version: snapshot.manifest.version,
      nodes: snapshot.graph.nodes.size,
      edges: snapshot.graph.edges.length,
      duration_ms: Date.now() - started,
    };
  }

  return store.mutate(async snapshot => {
    const paths = selectDocs(corpus, snapshot, options);
    const processed: string[] = [];
    const failed: { path: string; errors: string[] }[] = [];
    const changedNodes = new Set<string>();

    for (const path of paths) {
      const doc = corpus.getDocument(path);
      if (!doc) {
        continue; // manifest entry without a readable document — skip, next run retries
      }
      const guidance = options.guidance?.[path];
      const routed = await routeDocument(doc, snapshot, openRouter, guidance, logger);
      const entry = corpus.manifest.files[path];
      snapshot.manifest.pending_guidance = snapshot.manifest.pending_guidance.filter(
        p => p.path !== path,
      );
      if (routed.outcome === 'ok') {
        for (const id of routed.changedNodeIds) {
          changedNodes.add(id);
        }
        snapshot.manifest.processed[path] = {
          body_hash: entry.body_hash,
          node_ids: routed.changedNodeIds,
          updated_at: new Date().toISOString(),
        };
        processed.push(path);
      } else if (routed.outcome === 'guidance') {
        snapshot.manifest.pending_guidance.push({
          path,
          question: routed.question,
          attempts: routed.attempts,
          last_errors: routed.errors,
          updated_at: new Date().toISOString(),
        });
      } else {
        snapshot.manifest.pending_guidance.push({
          path,
          question:
            `After ${MAX_ITERATIONS} attempts the proposal still fails validation ` +
            `(${routed.errors[0] ?? 'unknown error'}). How should this document be modeled?`,
          attempts: MAX_ITERATIONS,
          last_errors: routed.errors,
          updated_at: new Date().toISOString(),
        });
        failed.push({ path, errors: routed.errors });
      }
    }

    // Re-embed changed nodes so ontology_search stays dense. Best-effort: embedding
    // failure must not lose the routed graph.
    if (changedNodes.size > 0) {
      try {
        const ids = [...changedNodes].filter(id => snapshot.graph.nodes.has(id));
        const vectors = await openRouter.embed(
          ids.map(id => nodeText(snapshot.graph.nodes.get(id)!)),
        );
        ids.forEach((id, i) => {
          snapshot.embeddings[id] = vectors[i];
        });
      } catch (error) {
        logger.warn({ err: error }, 'ontology embedding refresh failed; search may use keyword fallback');
      }
      for (const id of Object.keys(snapshot.embeddings)) {
        if (!snapshot.graph.nodes.has(id)) {
          delete snapshot.embeddings[id];
        }
      }
    }

    const mutated = processed.length > 0 || failed.length > 0 || paths.length > 0;
    const report: SyncReport = {
      ran: true,
      processed,
      failed,
      pending_guidance: snapshot.manifest.pending_guidance,
      version: snapshot.manifest.version + (mutated ? 1 : 0),
      nodes: snapshot.graph.nodes.size,
      edges: snapshot.graph.edges.length,
      duration_ms: Date.now() - started,
    };
    return {
      persist: mutated,
      note: `sync: ${processed.length} routed, ${failed.length} parked`,
      result: report,
    };
  });
}
