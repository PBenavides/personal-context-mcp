const K1 = 1.2;
const B = 0.75;

/** Small built-in English stopword list — filtered out of both documents and queries. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'have', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'our', 'so', 'that',
  'the', 'their', 'this', 'to', 'was', 'were', 'will', 'with', 'you', 'your', 'we',
]);

/**
 * Lowercases, strips non-alphanumeric characters, and drops stopwords. No stemming or fuzzy
 * matching — "deduction" and "deductions" are distinct terms. A documented v1 simplification.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0 && !STOPWORDS.has(token));
}

export interface Bm25Doc {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

export interface Bm25Index {
  readonly docCount: number;
  search(query: string, limit: number): Bm25Hit[];
}

/**
 * Builds an in-memory BM25 index over `docs` (an inverted index: term -> docId -> term
 * frequency, plus per-doc lengths and the corpus average). `k1=1.2`/`b=0.75` are the standard
 * defaults.
 *
 * IDF uses the Lucene/Elasticsearch-style variant `ln((N - df + 0.5)/(df + 0.5) + 1)` — the `+1`
 * inside the log keeps IDF always >= 0, avoiding the classic negative-IDF case for terms that
 * appear in most of the corpus, rather than special-casing it.
 */
export function buildBm25Index(docs: readonly Bm25Doc[]): Bm25Index {
  const docLengths = new Map<string, number>();
  const postings = new Map<string, Map<string, number>>();

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    docLengths.set(doc.id, tokens.length);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const [term, count] of tf) {
      let docMap = postings.get(term);
      if (!docMap) {
        docMap = new Map<string, number>();
        postings.set(term, docMap);
      }
      docMap.set(doc.id, count);
    }
  }

  const docCount = docs.length;
  const totalLength = [...docLengths.values()].reduce((sum, len) => sum + len, 0);
  const avgDocLength = docCount > 0 ? totalLength / docCount : 0;

  function idf(term: string): number {
    const df = postings.get(term)?.size ?? 0;
    return Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
  }

  return {
    docCount,
    search(query: string, limit: number): Bm25Hit[] {
      const queryTerms = tokenize(query);
      if (queryTerms.length === 0) {
        return [];
      }

      const scores = new Map<string, number>();
      for (const term of queryTerms) {
        const docMap = postings.get(term);
        if (!docMap) {
          continue;
        }
        const termIdf = idf(term);
        for (const [docId, tf] of docMap) {
          const len = docLengths.get(docId) ?? 0;
          // avgDocLength is 0 only when every doc is empty, in which case len is also 0 —
          // treat the length-normalization term as 0 rather than dividing by zero.
          const lengthNorm = avgDocLength <= 0 ? 0 : (B * len) / avgDocLength;
          const denom = tf + K1 * (1 - B + lengthNorm);
          const score = (termIdf * (tf * (K1 + 1))) / denom;
          scores.set(docId, (scores.get(docId) ?? 0) + score);
        }
      }

      return [...scores.entries()]
        .filter(([, score]) => score > 0)
        .sort(([idA, scoreA], [idB, scoreB]) => scoreB - scoreA || idA.localeCompare(idB))
        .slice(0, limit)
        .map(([id, score]) => ({ id, score }));
    },
  };
}
