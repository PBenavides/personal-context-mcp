/** Arguments passed to a search. */
export interface SearchArgs {
  collection: string;
  query: string;
  limit?: number;
}

/**
 * A per-collection (or default) search strategy — the extension point for evolving how each
 * document type is searched over time. Add a new strategy under `./searches/`, register it in
 * `./searches/registry.ts`, and it takes effect for its collection with no changes to the tools.
 *
 * A strategy controls how a collection's BM25 hits are projected/trimmed for the response —
 * e.g. a sensitive collection can return a shorter, more conservative snippet than the default.
 */
export interface SearchStrategy {
  /** Stable identifier, surfaced in results and `describe_collection`. */
  key: string;
  /** The collection this strategy targets. Omitted for the default fallback. */
  collection?: string;
  /** One-line, human-oriented description of what this strategy does. */
  describe(): string;
  /** Project (and truncate) a raw hit payload into the compact form returned to the caller. */
  projectPayload(payload: Record<string, unknown>): Record<string, unknown>;
}
