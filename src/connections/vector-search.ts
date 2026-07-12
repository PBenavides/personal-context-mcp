import type { ConnectionsConfig } from '../config.js';
import type { SearchFilters } from './enriched-corpus.js';
import type { Connection, ConnectionHealth } from './types.js';

/**
 * The vector-search connection: semantic search over the S3 Vectors index the pipeline
 * populates (one Titan embedding per enriched document, vector key = manifest path).
 *
 * A query is embedded with the same Bedrock model the pipeline used, then handed to
 * `QueryVectors` with the taxonomy filters applied server-side. Results come back as
 * (manifest path, similarity) pairs; the caller hydrates them from the in-memory corpus.
 *
 * Unconfigured (empty bucket/index — file-source fixtures, credential-free tests) the
 * connection stays inert and `maybe()` returns undefined, which keeps `search_context`
 * on its BM25 path.
 */

/** One semantic hit: a manifest path and a similarity score in (0, 1]. */
export interface VectorHit {
  key: string;
  score: number;
}

export interface VectorSearchClient {
  search(query: string, filters: SearchFilters, limit: number): Promise<VectorHit[]>;
}

/** The two AWS calls behind a search, isolated so tests can fake them without the SDK. */
export interface VectorBackend {
  embedQuery(text: string): Promise<number[]>;
  queryVectors(
    vector: number[],
    filter: Record<string, string> | undefined,
    topK: number,
  ): Promise<{ key: string; distance: number }[]>;
}

interface QueryVectorsInput {
  vectorBucketName: string;
  indexName: string;
  queryVector: { float32: number[] };
  topK: number;
  filter?: Record<string, string>;
  returnDistance: boolean;
  returnMetadata: boolean;
}

function createAwsBackend(config: ConnectionsConfig['vectorSearch']): VectorBackend {
  // Lazy imports keep both SDK clients off the require path for unconfigured (test) runs.
  let bedrockPromise:
    | Promise<{ invoke: (body: string) => Promise<Uint8Array> }>
    | undefined;
  let vectorsPromise:
    | Promise<{
        query: (
          input: QueryVectorsInput,
        ) => Promise<{ vectors?: { key?: string; distance?: number }[] }>;
      }>
    | undefined;

  function bedrock(): NonNullable<typeof bedrockPromise> {
    bedrockPromise ??= import('@aws-sdk/client-bedrock-runtime').then(
      ({ BedrockRuntimeClient, InvokeModelCommand }) => {
        const client = new BedrockRuntimeClient({ region: config.region });
        return {
          async invoke(body: string): Promise<Uint8Array> {
            const res = await client.send(
              new InvokeModelCommand({ modelId: config.embedModelId, body }),
            );
            return res.body;
          },
        };
      },
    );
    return bedrockPromise;
  }

  function vectors(): NonNullable<typeof vectorsPromise> {
    vectorsPromise ??= import('@aws-sdk/client-s3vectors').then(
      ({ S3VectorsClient, QueryVectorsCommand }) => {
        const client = new S3VectorsClient({ region: config.region });
        return {
          async query(input: QueryVectorsInput) {
            return client.send(new QueryVectorsCommand(input));
          },
        };
      },
    );
    return vectorsPromise;
  }

  return {
    async embedQuery(text: string): Promise<number[]> {
      const raw = await (await bedrock()).invoke(JSON.stringify({ inputText: text }));
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as { embedding: number[] };
      return parsed.embedding;
    },
    async queryVectors(vector, filter, topK) {
      const res = await (await vectors()).query({
        vectorBucketName: config.bucket,
        indexName: config.index,
        queryVector: { float32: vector },
        topK,
        ...(filter ? { filter } : {}),
        returnDistance: true,
        returnMetadata: false,
      });
      return (res.vectors ?? []).flatMap(v =>
        v.key !== undefined && v.distance !== undefined
          ? [{ key: v.key, distance: v.distance }]
          : [],
      );
    },
  };
}

/**
 * S3 Vectors metadata filters are exact-match; the pipeline lowercases values on write, so
 * lowercasing here restores the case-insensitive filter semantics of the BM25 path.
 */
export function toVectorFilter(filters: SearchFilters): Record<string, string> | undefined {
  const entries = Object.entries(filters).filter(
    (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1].trim() !== '',
  );
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, v.trim().toLowerCase()]));
}

export interface VectorSearchConnection extends Connection<VectorSearchClient> {
  /** The client when configured, undefined otherwise — callers fall back to BM25. */
  maybe(): VectorSearchClient | undefined;
}

export interface VectorSearchDeps {
  /** Overrides the AWS backend (tests inject a fake). */
  backend?: VectorBackend;
}

export function createVectorSearchConnection(
  config: ConnectionsConfig['vectorSearch'],
  deps: VectorSearchDeps = {},
): VectorSearchConnection {
  const name = 'vector-search';
  const kind = 'vector-search' as const;
  const configured = Boolean(config.bucket && config.index);
  const backend = configured ? (deps.backend ?? createAwsBackend(config)) : undefined;

  const client: VectorSearchClient = {
    async search(query, filters, limit): Promise<VectorHit[]> {
      if (!backend) {
        throw new Error('vector search is not configured (VECTOR_BUCKET/VECTOR_INDEX unset)');
      }
      const embedding = await backend.embedQuery(query);
      const hits = await backend.queryVectors(embedding, toVectorFilter(filters), limit);
      // Cosine distance ∈ [0, 2] → a similarity-flavored score, higher = closer.
      return hits.map(({ key, distance }) => ({ key, score: 1 - distance }));
    },
  };

  return {
    name,
    kind,
    get(): VectorSearchClient {
      if (!configured) {
        throw new Error('vector search is not configured (VECTOR_BUCKET/VECTOR_INDEX unset)');
      }
      return client;
    },
    maybe(): VectorSearchClient | undefined {
      return configured ? client : undefined;
    },
    async healthCheck(): Promise<ConnectionHealth> {
      return {
        name,
        kind,
        ok: true,
        detail: configured
          ? `s3vectors://${config.bucket}/${config.index} (${config.embedModelId})`
          : 'not configured — search_context uses BM25',
      };
    },
    async close(): Promise<void> {
      /* stateless HTTP clients; nothing to release */
    },
  };
}
