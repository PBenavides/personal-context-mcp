import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionsConfig } from '../config.js';
import { getResourcePath } from '../utils/directories.js';
import { buildBm25Index, type Bm25Index } from './bm25.js';
import type { Connection, ConnectionHealth } from './types.js';

const INCLUDED_EXTENSIONS = new Set(['.md', '.txt']);

/** One document read from the corpus — every field is plain, uniform text (no varying schema). */
export interface CorpusDocument {
  id: string;
  collection: string;
  title: string;
  path: string;
  content: string;
}

/** One BM25 hit, with the raw document fields as `payload` — projection happens one layer up. */
export interface CorpusHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface LocalCorpusIndex {
  /** Collection (subdirectory) names, in discovery order. */
  listCollections(): string[];
  /** Number of documents in one collection (0 if the collection is unknown). */
  docCount(collection: string): number;
  /** Total documents across all collections. */
  totalDocCount(): number;
  /** BM25 search scoped to one collection; `[]` if the collection is unknown or has no matches. */
  search(collection: string, query: string, limit: number): CorpusHit[];
}

export interface LocalCorpusConnectionDeps {
  /** Overrides how the corpus is read from disk. Defaults to a real filesystem walk. */
  readCorpus?: (rootDir: string) => CorpusDocument[];
}

/** First markdown `# heading`, else the filename with `-`/`_` replaced by spaces. */
function deriveTitle(content: string, filePath: string): string {
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading) {
    return heading[1].trim();
  }
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, ' ');
}

/** Recursively collects included-extension file paths under `dir`, skipping dotfiles/dotdirs. */
function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (INCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

/** One level of subdirectories under `rootDir` are collections; each is walked recursively. */
function defaultReadCorpus(rootDir: string): CorpusDocument[] {
  const collectionDirs = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

  const docs: CorpusDocument[] = [];
  for (const collectionDir of collectionDirs) {
    const collection = collectionDir.name;
    for (const filePath of walk(path.join(rootDir, collection))) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(rootDir, filePath).split(path.sep).join('/');
      docs.push({
        id: relativePath,
        collection,
        title: deriveTitle(content, filePath),
        path: relativePath,
        content,
      });
    }
  }
  return docs;
}

function isConfigured(rootDir: string): boolean {
  if (!rootDir) {
    return false;
  }
  try {
    return fs.statSync(rootDir).isDirectory();
  } catch {
    return false;
  }
}

function toPayload(doc: CorpusDocument): Record<string, unknown> {
  return { id: doc.id, collection: doc.collection, title: doc.title, path: doc.path, content: doc.content };
}

/**
 * Builds the local, filesystem-backed corpus connection: a directory of markdown/text files
 * (one subdirectory per collection) searched with BM25 keyword scoring. The index is built once,
 * on first `get()`, and memoised for the process lifetime — the corpus is static and baked into
 * the Docker image, so there is no file-watching or hot-reload.
 */
export function createLocalCorpusConnection(
  config: ConnectionsConfig['localCorpus'],
  deps: LocalCorpusConnectionDeps = {},
): Connection<LocalCorpusIndex> {
  const name = 'local-corpus';
  const kind = 'local-corpus' as const;
  const resolvedRoot = config.rootDir
    ? path.isAbsolute(config.rootDir)
      ? config.rootDir
      : getResourcePath(config.rootDir)
    : '';
  const readCorpus = deps.readCorpus ?? defaultReadCorpus;

  let cached: LocalCorpusIndex | undefined;

  function build(): LocalCorpusIndex {
    const docs = readCorpus(resolvedRoot);
    const byCollection = new Map<string, CorpusDocument[]>();
    for (const doc of docs) {
      const list = byCollection.get(doc.collection) ?? [];
      list.push(doc);
      byCollection.set(doc.collection, list);
    }
    const docsById = new Map(docs.map(doc => [doc.id, doc]));
    const indexByCollection = new Map<string, Bm25Index>();
    for (const [collection, collectionDocs] of byCollection) {
      indexByCollection.set(
        collection,
        buildBm25Index(
          collectionDocs.map(doc => ({ id: doc.id, text: `${doc.title}\n${doc.content}` })),
        ),
      );
    }

    return {
      listCollections: (): string[] => [...byCollection.keys()],
      docCount: (collection: string): number => byCollection.get(collection)?.length ?? 0,
      totalDocCount: (): number => docs.length,
      search(collection: string, query: string, limit: number): CorpusHit[] {
        const bm25 = indexByCollection.get(collection);
        if (!bm25) {
          return [];
        }
        return bm25.search(query, limit).map(hit => ({
          id: hit.id,
          score: hit.score,
          payload: toPayload(docsById.get(hit.id) as CorpusDocument),
        }));
      },
    };
  }

  return {
    name,
    kind,
    get(): LocalCorpusIndex {
      if (!isConfigured(resolvedRoot)) {
        throw new Error(
          `Local corpus is not configured: "${resolvedRoot || config.rootDir}" is not an existing directory`,
        );
      }
      cached ??= build();
      return cached;
    },
    async healthCheck(): Promise<ConnectionHealth> {
      if (!isConfigured(resolvedRoot)) {
        return { name, kind, ok: false, detail: 'not configured' };
      }
      try {
        cached ??= build();
        return {
          name,
          kind,
          ok: true,
          detail: `${cached.listCollections().length} collections, ${cached.totalDocCount()} documents`,
        };
      } catch (error) {
        return {
          name,
          kind,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async close(): Promise<void> {
      // In-memory data, nothing to release.
    },
  };
}
