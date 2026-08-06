import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionsConfig } from '../config.js';
import type { OntologyGraph } from '../ontology/model.js';
import { emptyGraph } from '../ontology/model.js';
import { parseGraph, serializeGraph, serializeSchema } from '../ontology/rdfxml.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * The ontology-store connection: versioned persistence of the ontology registry.
 *
 * Layout under the root (S3 `ontology/` prefix, or a local directory in file mode):
 *   schema.owl            — OWL TBox (RDF/XML), regenerated from the vocabulary on every save
 *   data.rdf              — current ABox (RDF/XML), the file the dashboard consumes
 *   versions/v<n>.rdf     — immutable snapshot of data.rdf at version n
 *   manifest.json         — version counter + history, injector progress (processed doc
 *                           hashes), pending elicitation guidance, embedding model marker
 *   embeddings.json       — node id → embedding vector (OpenRouter), for ontology_search
 *
 * The client holds the current snapshot in memory (single-writer service). `mutate()`
 * serializes writers through a promise chain so a cron sync and a tool update can't
 * interleave their read-modify-write cycles.
 */

export interface PendingGuidance {
  path: string;
  question: string;
  attempts: number;
  last_errors: string[];
  updated_at: string;
}

export interface OntologyManifest {
  version: number;
  updated_at: string;
  embed_model: string;
  versions: { version: number; key: string; updated_at: string; note: string }[];
  processed: Record<string, { body_hash: string; node_ids: string[]; updated_at: string }>;
  pending_guidance: PendingGuidance[];
}

export interface OntologySnapshot {
  graph: OntologyGraph;
  manifest: OntologyManifest;
  /** node id → embedding vector; empty when OpenRouter has never run. */
  embeddings: Record<string, number[]>;
}

function emptyManifest(): OntologyManifest {
  return {
    version: 0,
    updated_at: '',
    embed_model: '',
    versions: [],
    processed: {},
    pending_guidance: [],
  };
}

/** Minimal blob backend both sources implement. Keys are root-relative. */
export interface OntologyBackend {
  describe(): string;
  read(key: string): Promise<string | undefined>;
  write(key: string, body: string, contentType: string): Promise<void>;
}

export function createFileBackend(rootDir: string): OntologyBackend {
  const root = path.isAbsolute(rootDir) ? rootDir : path.resolve(process.cwd(), rootDir);
  return {
    describe: () => `file:${root}`,
    async read(key: string): Promise<string | undefined> {
      try {
        return await fs.promises.readFile(path.join(root, key), 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      }
    },
    async write(key: string, body: string): Promise<void> {
      const file = path.join(root, key);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, body, 'utf-8');
    },
  };
}

export function createS3Backend(config: {
  bucket: string;
  prefix: string;
  region: string;
}): OntologyBackend {
  const prefix = config.prefix && !config.prefix.endsWith('/') ? `${config.prefix}/` : config.prefix;
  let clientPromise:
    | Promise<{
        get: (key: string) => Promise<string | undefined>;
        put: (key: string, body: string, contentType: string) => Promise<void>;
      }>
    | undefined;
  function client(): NonNullable<typeof clientPromise> {
    clientPromise ??= import('@aws-sdk/client-s3').then(
      ({ S3Client, GetObjectCommand, PutObjectCommand, NoSuchKey }) => {
        const s3 = new S3Client({ region: config.region });
        return {
          async get(key: string): Promise<string | undefined> {
            try {
              const res = await s3.send(
                new GetObjectCommand({ Bucket: config.bucket, Key: `${prefix}${key}` }),
              );
              return res.Body ? res.Body.transformToString('utf-8') : '';
            } catch (error) {
              if (error instanceof NoSuchKey || (error as { name?: string }).name === 'NoSuchKey') {
                return undefined;
              }
              throw error;
            }
          },
          async put(key: string, body: string, contentType: string): Promise<void> {
            await s3.send(
              new PutObjectCommand({
                Bucket: config.bucket,
                Key: `${prefix}${key}`,
                Body: body,
                ContentType: contentType,
              }),
            );
          },
        };
      },
    );
    return clientPromise;
  }
  return {
    describe: () => `s3://${config.bucket}/${prefix}`,
    async read(key: string): Promise<string | undefined> {
      return (await client()).get(key);
    },
    async write(key: string, body: string, contentType: string): Promise<void> {
      await (await client()).put(key, body, contentType);
    },
  };
}

export interface OntologyStoreClient {
  /** The current snapshot, loading it from the backend on first call. */
  snapshot(): Promise<OntologySnapshot>;
  /**
   * Runs `fn` against the current snapshot under the writer lock. When `fn` returns
   * `persist: true`, the store bumps the version, writes data.rdf + an immutable
   * versions/v<n>.rdf snapshot + manifest + embeddings (+ schema.owl), and keeps the
   * mutated snapshot as current.
   */
  mutate<T>(
    fn: (snapshot: OntologySnapshot) => Promise<{ persist: boolean; note?: string; result: T }>,
  ): Promise<T>;
  /** Serialized RDF/XML of the current ABox (dashboard + .rdf endpoint). */
  dataXml(): Promise<string>;
  /** Serialized RDF/XML of the TBox (.owl endpoint). */
  schemaXml(): string;
}

export type OntologyStoreConnection = Connection<OntologyStoreClient>;

export interface OntologyStoreDeps {
  /** Overrides the backend (tests inject an in-memory fake). */
  backend?: OntologyBackend;
  now?: () => string;
}

export function createOntologyStoreConnection(
  config: ConnectionsConfig['ontology'],
  deps: OntologyStoreDeps = {},
): OntologyStoreConnection {
  const name = 'ontology-store';
  const kind = 'ontology-store' as const;
  const backend =
    deps.backend ??
    (config.source === 's3'
      ? createS3Backend({ bucket: config.bucket, prefix: config.prefix, region: config.region })
      : createFileBackend(config.rootDir));
  const now = deps.now ?? ((): string => new Date().toISOString());

  let current: OntologySnapshot | undefined;
  let lock: Promise<unknown> = Promise.resolve();

  async function load(): Promise<OntologySnapshot> {
    const manifestText = await backend.read('manifest.json');
    if (!manifestText) {
      return { graph: emptyGraph(), manifest: emptyManifest(), embeddings: {} };
    }
    const manifest = JSON.parse(manifestText) as OntologyManifest;
    const dataText = await backend.read('data.rdf');
    const embedText = await backend.read('embeddings.json');
    return {
      graph: dataText ? parseGraph(dataText) : emptyGraph(),
      manifest,
      embeddings: embedText ? (JSON.parse(embedText) as Record<string, number[]>) : {},
    };
  }

  async function persist(snapshot: OntologySnapshot, note: string): Promise<void> {
    const stamp = now();
    snapshot.manifest.version += 1;
    snapshot.manifest.updated_at = stamp;
    const versionKey = `versions/v${snapshot.manifest.version}.rdf`;
    snapshot.manifest.versions.push({
      version: snapshot.manifest.version,
      key: versionKey,
      updated_at: stamp,
      note,
    });
    const dataXml = serializeGraph(snapshot.graph);
    await backend.write('schema.owl', serializeSchema(), 'application/rdf+xml');
    await backend.write('data.rdf', dataXml, 'application/rdf+xml');
    await backend.write(versionKey, dataXml, 'application/rdf+xml');
    await backend.write(
      'embeddings.json',
      JSON.stringify(snapshot.embeddings),
      'application/json',
    );
    await backend.write(
      'manifest.json',
      JSON.stringify(snapshot.manifest, null, 2),
      'application/json',
    );
  }

  /** Chains `fn` onto the writer lock so mutations never interleave. */
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = lock.then(fn, fn);
    lock = next.catch(() => undefined);
    return next;
  }

  const client: OntologyStoreClient = {
    async snapshot(): Promise<OntologySnapshot> {
      return withLock(async () => {
        current ??= await load();
        return current;
      });
    },
    async mutate<T>(
      fn: (snapshot: OntologySnapshot) => Promise<{ persist: boolean; note?: string; result: T }>,
    ): Promise<T> {
      return withLock(async () => {
        current ??= await load();
        const outcome = await fn(current);
        if (outcome.persist) {
          await persist(current, outcome.note ?? 'update');
        }
        return outcome.result;
      });
    },
    async dataXml(): Promise<string> {
      const snap = await client.snapshot();
      return serializeGraph(snap.graph);
    },
    schemaXml(): string {
      return serializeSchema();
    },
  };

  return {
    name,
    kind,
    get: (): OntologyStoreClient => client,
    async healthCheck(): Promise<ConnectionHealth> {
      if (!current) {
        return { name, kind, ok: true, detail: `lazy (${backend.describe()})` };
      }
      return {
        name,
        kind,
        ok: true,
        detail:
          `v${current.manifest.version}, ${current.graph.nodes.size} nodes, ` +
          `${current.graph.edges.length} edges (${backend.describe()})`,
      };
    },
    async close(): Promise<void> {
      /* nothing held */
    },
  };
}
