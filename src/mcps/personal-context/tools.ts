import type {
  EnrichedCorpusIndex,
  SearchFilters,
} from '../../connections/enriched-corpus.js';
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

/**
 * BM25 keyword search over the enriched corpus (notes + events). `category`/`status`/`horizon`
 * filter on the pipeline's frontmatter; every document that survives the filters is ranked, so
 * a narrow filter still returns the best matches rather than an accidentally-empty page.
 */
export function searchContext(
  corpus: EnrichedCorpusIndex,
  args: { query: string; category?: string; status?: string; horizon?: string; limit?: number },
): SearchResult | ToolError {
  if (!args.query || !args.query.trim()) {
    return { error: 'query must be a non-empty string' };
  }
  const filters: SearchFilters = {
    category: args.category,
    status: args.status,
    horizon: args.horizon,
  };
  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const raw = corpus.search(args.query, filters, limit);
  return {
    query: args.query,
    filters,
    total: raw.length,
    hits: raw.map(({ score, doc }) => ({
      path: doc.path,
      score,
      category: doc.category,
      ...(doc.horizon ? { horizon: doc.horizon } : {}),
      ...(doc.status ? { status: doc.status } : {}),
      summary: doc.summary,
      snippet: makeSnippet(doc.body, args.query),
    })),
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
