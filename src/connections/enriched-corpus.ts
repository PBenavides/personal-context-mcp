import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { ConnectionsConfig } from '../config.js';
import { parseNote } from '../utils/frontmatter.js';
import { buildBm25Index, type Bm25Index } from './bm25.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * The enriched-corpus connection: the pipeline's output layer (Workstream B contract,
 * `fable_plans/02_…` §"Output contract") loaded into memory and searched with BM25.
 *
 * Layout it consumes:
 *   <root>/manifest.json                              — {taxonomy_version, run_id, run_mode,
 *                                                        generated_at, files: {path: {...}}}
 *   <root>/notes/<vault-relative-path>.md             — enriched frontmatter + original body
 *   <root>/events/english-collector/<iso-date>.json   — one day of normalized activity events
 *
 * Two sources implement the same tiny reader contract: `file` (a local directory — fixtures,
 * zero-credential tests) and `s3` (AWS SDK v3 against the production bucket). The corpus is a
 * few thousand small documents at most, so everything lives in memory; `load()` runs at boot and
 * a refresh timer re-checks the manifest's `run_id` on an interval, reloading only when the
 * pipeline has published a new run.
 */

/** The manifest written by the pipeline at the corpus root. */
export interface CorpusManifest {
  taxonomy_version: string;
  run_id: string;
  run_mode: string;
  generated_at: string;
  files: Record<string, { body_hash: string; category: string; enriched_at: string }>;
}

/** One enriched document (a vault note or a day of events), normalized for search. */
export interface EnrichedDocument {
  /** Manifest key, e.g. `notes/foo.md` or `events/english-collector/2026-07-12.json`. */
  path: string;
  category: string;
  horizon?: string;
  status?: string;
  salience?: number;
  summary: string;
  entities: string[];
  /** Searchable body text (note body, or a text rendering of the day's events). */
  body: string;
  /** The full original object content, returned by `get_document`. */
  raw: string;
}

/** Metadata filters applied to search results; all matches are case-insensitive equality. */
export interface SearchFilters {
  category?: string;
  status?: string;
  horizon?: string;
}

export interface CorpusSearchHit {
  score: number;
  doc: EnrichedDocument;
}

/** An immutable snapshot of one loaded corpus generation (one manifest `run_id`). */
export interface EnrichedCorpusIndex {
  manifest: CorpusManifest;
  docCount(): number;
  search(query: string, filters: SearchFilters, limit: number): CorpusSearchHit[];
  getDocument(docPath: string): EnrichedDocument | undefined;
  /** Category → document count, derived from the manifest. */
  categoryCounts(): Record<string, number>;
}

/** Minimal reader contract both sources implement. Keys are corpus-root-relative. */
export interface CorpusSource {
  describe(): string;
  readText(key: string): Promise<string>;
}

export function createFileSource(rootDir: string): CorpusSource {
  const root = path.isAbsolute(rootDir) ? rootDir : path.resolve(process.cwd(), rootDir);
  return {
    describe: () => `file:${root}`,
    async readText(key: string): Promise<string> {
      return fs.promises.readFile(path.join(root, key), 'utf-8');
    },
  };
}

export function createS3Source(config: {
  bucket: string;
  prefix: string;
  region: string;
}): CorpusSource {
  const prefix = config.prefix && !config.prefix.endsWith('/') ? `${config.prefix}/` : config.prefix;
  // Lazy import keeps the AWS SDK off the require path for file-source (test) runs.
  let clientPromise: Promise<{ getText: (key: string) => Promise<string> }> | undefined;
  function client(): Promise<{ getText: (key: string) => Promise<string> }> {
    clientPromise ??= import('@aws-sdk/client-s3').then(({ S3Client, GetObjectCommand }) => {
      const s3 = new S3Client({ region: config.region });
      return {
        async getText(key: string): Promise<string> {
          const res = await s3.send(
            new GetObjectCommand({ Bucket: config.bucket, Key: `${prefix}${key}` }),
          );
          return res.Body ? res.Body.transformToString('utf-8') : '';
        },
      };
    });
    return clientPromise;
  }
  return {
    describe: () => `s3://${config.bucket}/${prefix}`,
    async readText(key: string): Promise<string> {
      return (await client()).getText(key);
    },
  };
}

/** Renders one day-of-events JSON into searchable text (types, timestamps, payload values). */
function eventsToBody(parsed: Record<string, unknown>): string {
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const lines = events.map(event => {
    const e = event as Record<string, unknown>;
    const payload = e.payload && typeof e.payload === 'object' ? Object.values(e.payload).join(' ') : '';
    return [e.type, e.occurred_at, e.summary, payload].filter(Boolean).join(' ');
  });
  return [parsed.summary, ...lines].filter(Boolean).join('\n');
}

function toDocument(docPath: string, rawText: string, manifestCategory: string): EnrichedDocument {
  if (docPath.endsWith('.json')) {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    return {
      path: docPath,
      category: typeof parsed.category === 'string' ? parsed.category : manifestCategory,
      horizon: typeof parsed.horizon === 'string' ? parsed.horizon : 'past',
      status: typeof parsed.status === 'string' ? parsed.status : 'done',
      salience: typeof parsed.salience === 'number' ? parsed.salience : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
      body: eventsToBody(parsed),
      raw: rawText,
    };
  }
  const { frontmatter, body } = parseNote(rawText);
  return {
    path: docPath,
    category: typeof frontmatter.category === 'string' ? frontmatter.category : manifestCategory,
    horizon: typeof frontmatter.horizon === 'string' ? frontmatter.horizon : undefined,
    status: typeof frontmatter.status === 'string' ? frontmatter.status : undefined,
    salience: typeof frontmatter.salience === 'number' ? frontmatter.salience : undefined,
    summary: typeof frontmatter.summary === 'string' ? frontmatter.summary : '',
    entities: Array.isArray(frontmatter.entities) ? frontmatter.entities.map(String) : [],
    body,
    raw: rawText,
  };
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function matchesFilters(doc: EnrichedDocument, filters: SearchFilters): boolean {
  if (filters.category && normalize(doc.category) !== normalize(filters.category)) {
    return false;
  }
  if (filters.status && normalize(doc.status) !== normalize(filters.status)) {
    return false;
  }
  if (filters.horizon && normalize(doc.horizon) !== normalize(filters.horizon)) {
    return false;
  }
  return true;
}

function buildIndex(manifest: CorpusManifest, docs: EnrichedDocument[]): EnrichedCorpusIndex {
  const byPath = new Map(docs.map(doc => [doc.path, doc]));
  const bm25: Bm25Index = buildBm25Index(
    docs.map(doc => ({
      id: doc.path,
      text: [doc.path, doc.category, doc.summary, doc.entities.join(' '), doc.body].join('\n'),
    })),
  );

  return {
    manifest,
    docCount: (): number => docs.length,
    search(query: string, filters: SearchFilters, limit: number): CorpusSearchHit[] {
      // Score the whole (small) corpus, then filter — so metadata filters never starve results.
      return bm25
        .search(query, docs.length)
        .map(hit => ({ score: hit.score, doc: byPath.get(hit.id) as EnrichedDocument }))
        .filter(hit => matchesFilters(hit.doc, filters))
        .slice(0, limit);
    },
    getDocument: (docPath: string): EnrichedDocument | undefined => byPath.get(docPath),
    categoryCounts(): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const entry of Object.values(manifest.files)) {
        counts[entry.category] = (counts[entry.category] ?? 0) + 1;
      }
      return counts;
    },
  };
}

/** Reads the manifest and every listed document from `source`, building a fresh index. */
export async function loadCorpus(source: CorpusSource): Promise<EnrichedCorpusIndex> {
  const manifest = JSON.parse(await source.readText('manifest.json')) as CorpusManifest;
  const paths = Object.keys(manifest.files);
  const docs = await Promise.all(
    paths.map(async docPath =>
      toDocument(docPath, await source.readText(docPath), manifest.files[docPath].category),
    ),
  );
  return buildIndex(manifest, docs);
}

/**
 * The enriched-corpus {@link Connection}, extended with explicit lifecycle: `load()` runs at
 * boot (the process must not serve before it resolves) and `startRefresh()` begins the
 * interval that re-reads `manifest.json` and reloads only when `run_id` changed. A failed
 * refresh logs and keeps serving the previous snapshot.
 */
export interface EnrichedCorpusConnection extends Connection<EnrichedCorpusIndex> {
  load(): Promise<void>;
  startRefresh(logger: FastifyBaseLogger): void;
}

export interface EnrichedCorpusDeps {
  /** Overrides the source (tests inject an in-memory fake). */
  source?: CorpusSource;
  /** Overrides the refresh interval for tests. */
  refreshSeconds?: number;
}

export function createEnrichedCorpusConnection(
  config: ConnectionsConfig['enrichedCorpus'],
  deps: EnrichedCorpusDeps = {},
): EnrichedCorpusConnection {
  const name = 'enriched-corpus';
  const kind = 'enriched-corpus' as const;
  const source =
    deps.source ??
    (config.source === 's3'
      ? createS3Source({ bucket: config.bucket, prefix: config.prefix, region: config.region })
      : createFileSource(config.rootDir));
  const refreshSeconds = deps.refreshSeconds ?? config.refreshSeconds;

  let current: EnrichedCorpusIndex | undefined;
  let timer: NodeJS.Timeout | undefined;

  async function refreshIfChanged(logger: FastifyBaseLogger): Promise<void> {
    try {
      const manifest = JSON.parse(await source.readText('manifest.json')) as CorpusManifest;
      if (current && manifest.run_id === current.manifest.run_id) {
        return;
      }
      current = await loadCorpus(source);
      logger.info(
        { run_id: current.manifest.run_id, docs: current.docCount() },
        'enriched corpus reloaded',
      );
    } catch (error) {
      logger.warn({ err: error }, 'enriched corpus refresh failed; keeping previous snapshot');
    }
  }

  return {
    name,
    kind,
    async load(): Promise<void> {
      current = await loadCorpus(source);
    },
    startRefresh(logger: FastifyBaseLogger): void {
      if (timer || refreshSeconds <= 0) {
        return;
      }
      timer = setInterval(() => void refreshIfChanged(logger), refreshSeconds * 1000);
      timer.unref();
    },
    get(): EnrichedCorpusIndex {
      if (!current) {
        throw new Error(
          `Enriched corpus is not loaded yet (source ${source.describe()}); load() runs at boot`,
        );
      }
      return current;
    },
    async healthCheck(): Promise<ConnectionHealth> {
      if (!current) {
        return { name, kind, ok: false, detail: `not loaded (${source.describe()})` };
      }
      return {
        name,
        kind,
        ok: true,
        detail: `${current.docCount()} documents, run ${current.manifest.run_id}`,
      };
    },
    async close(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
