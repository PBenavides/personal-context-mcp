import type {
  EnrichedCorpusIndex,
  EnrichedDocument,
  SearchFilters,
} from '../../connections/enriched-corpus.js';
import type { VectorSearchClient } from '../../connections/vector-search.js';
import { tokenize } from '../../connections/bm25.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const SNIPPET_RADIUS = 150;
const PREVIEW_LENGTH = 500;

/** Structured error result shared by the tool functions. */
export interface ToolError {
  error: string;
}

/** One compact hit returned by {@link searchContext}. */
export interface SearchHit {
  path: string;
  score: number;
  category: string;
  horizon?: string;
  status?: string;
  summary: string;
  snippet: string;
}

export interface SearchResult {
  query: string;
  filters: SearchFilters;
  /** How the hits were ranked: Titan/S3 Vectors similarity, or the BM25 fallback. */
  mode: 'semantic' | 'keyword';
  total: number;
  hits: SearchHit[];
}

/**
 * A short body excerpt centred on the first query-term occurrence, falling back to the head of
 * the body. Keeps result payloads small so the tool answers "which documents" — `get_document`
 * answers "what exactly do they say".
 */
export function makeSnippet(body: string, query: string): string {
  const haystack = body.toLowerCase();
  let at = -1;
  for (const term of tokenize(query)) {
    const index = haystack.indexOf(term);
    if (index !== -1 && (at === -1 || index < at)) {
      at = index;
    }
  }
  const start = at === -1 ? 0 : Math.max(0, at - SNIPPET_RADIUS);
  const end = at === -1 ? SNIPPET_RADIUS * 2 : at + SNIPPET_RADIUS;
  const slice = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < body.length ? '…' : ''}`;
}

function toHit(doc: EnrichedDocument, score: number, query: string): SearchHit {
  return {
    path: doc.path,
    score,
    category: doc.category,
    ...(doc.horizon ? { horizon: doc.horizon } : {}),
    ...(doc.status ? { status: doc.status } : {}),
    summary: doc.summary,
    snippet: makeSnippet(doc.body, query),
  };
}

/**
 * Search over the enriched corpus (notes + events). Semantic when the S3 Vectors index is
 * configured: the query is Titan-embedded and ranked by cosine similarity, with the
 * `category`/`status`/`horizon` filters applied server-side in the index. Falls back to BM25
 * keyword ranking when the index is unconfigured (file-source runs) or a vector query fails at
 * runtime — search stays available on an AWS blip, it just degrades to keywords.
 */
export async function searchContext(
  corpus: EnrichedCorpusIndex,
  vector: VectorSearchClient | undefined,
  args: { query: string; category?: string; status?: string; horizon?: string; limit?: number },
): Promise<SearchResult | ToolError> {
  if (!args.query || !args.query.trim()) {
    return { error: 'query must be a non-empty string' };
  }
  const filters: SearchFilters = {
    category: args.category,
    status: args.status,
    horizon: args.horizon,
  };
  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  if (vector) {
    try {
      const vectorHits = await vector.search(args.query, filters, limit);
      // Hydrate from the corpus snapshot; a key it doesn't know is a stale vector for a
      // document that left the manifest — skip it rather than serving a dead path.
      const hits = vectorHits.flatMap(({ key, score }) => {
        const doc = corpus.getDocument(key);
        return doc ? [toHit(doc, score, args.query)] : [];
      });
      return { query: args.query, filters, mode: 'semantic', total: hits.length, hits };
    } catch {
      // fall through to BM25
    }
  }

  const raw = corpus.search(args.query, filters, limit);
  return {
    query: args.query,
    filters,
    mode: 'keyword',
    total: raw.length,
    hits: raw.map(({ score, doc }) => toHit(doc, score, args.query)),
  };
}

export interface DocumentResult {
  path: string;
  category: string;
  horizon?: string;
  status?: string;
  salience?: number;
  summary: string;
  entities: string[];
  /** Full original content when `full`, else a bounded preview of the body. */
  content: string;
  truncated: boolean;
}

/** Fetches one document by its manifest path — full content or a bounded preview. */
export function getDocument(
  corpus: EnrichedCorpusIndex,
  args: { path: string; full?: boolean },
): DocumentResult | ToolError {
  const doc = corpus.getDocument(args.path);
  if (!doc) {
    return {
      error: `Unknown document "${args.path}". Paths come from search_context results (e.g. notes/….md or events/english-collector/<date>.json).`,
    };
  }
  const full = args.full ?? true;
  const content = full ? doc.raw : doc.body.slice(0, PREVIEW_LENGTH);
  return {
    path: doc.path,
    category: doc.category,
    ...(doc.horizon ? { horizon: doc.horizon } : {}),
    ...(doc.status ? { status: doc.status } : {}),
    ...(doc.salience !== undefined ? { salience: doc.salience } : {}),
    summary: doc.summary,
    entities: doc.entities,
    content,
    truncated: !full && doc.body.length > PREVIEW_LENGTH,
  };
}

export interface TaxonomyResult {
  taxonomy_version: string;
  run_id: string;
  generated_at: string;
  total_documents: number;
  categories: { category: string; count: number }[];
}

/** The taxonomy as materialized in the current corpus: categories with document counts. */
export function listTaxonomy(corpus: EnrichedCorpusIndex): TaxonomyResult {
  const counts = corpus.categoryCounts();
  return {
    taxonomy_version: corpus.manifest.taxonomy_version,
    run_id: corpus.manifest.run_id,
    generated_at: corpus.manifest.generated_at,
    total_documents: corpus.docCount(),
    categories: Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([category, count]) => ({ category, count })),
  };
}
