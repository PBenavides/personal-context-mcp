import type { SearchStrategy } from './types.js';

/** Longer strings in payloads are truncated to this many characters to protect the context window. */
export const MAX_STRING_LENGTH = 500;
/** Arrays in payloads are capped to this many elements. */
export const MAX_ARRAY_ITEMS = 10;

/** Truncates a long string, appending a marker with how many characters were dropped. */
export function truncateString(value: string, max = MAX_STRING_LENGTH): string {
  return value.length > max
    ? `${value.slice(0, max)}… [truncated ${value.length - max} chars]`
    : value;
}

/** Generic, size-bounded projection: truncates long strings and caps arrays; passes other types. */
export function projectGeneric(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      out[key] = truncateString(value);
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, MAX_ARRAY_ITEMS);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Picks a subset of payload fields (when present), truncating string values. Returns an empty
 * object if none of the keys are present — callers fall back to {@link projectGeneric}.
 */
export function pickFields(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null) {
      continue;
    }
    out[key] = typeof value === 'string' ? truncateString(value) : value;
  }
  return out;
}

/**
 * The fallback strategy used for any collection without a dedicated one: return every payload
 * field, size-bounded.
 */
export const defaultStrategy: SearchStrategy = {
  key: 'default',
  describe: () =>
    'Generic BM25 keyword search: returns the nearest matches with a size-bounded copy of the full payload.',
  projectPayload: projectGeneric,
};
