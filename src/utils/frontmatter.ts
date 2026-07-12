import { parse as parseYaml } from 'yaml';

/** A markdown note split into parsed YAML frontmatter and the remaining body. */
export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/**
 * Splits a markdown note into YAML frontmatter and body. Notes in the enriched layer always
 * carry frontmatter (the pipeline writes it), but a note without any — or with YAML that fails
 * to parse — degrades to `{ frontmatter: {}, body: <whole text> }` rather than throwing, so one
 * malformed object can't take the whole corpus down.
 */
export function parseNote(text: string): ParsedNote {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return { frontmatter: {}, body: text };
  }
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        frontmatter: parsed as Record<string, unknown>,
        body: text.slice(match[0].length),
      };
    }
  } catch {
    // fall through to the degraded shape
  }
  return { frontmatter: {}, body: text };
}
