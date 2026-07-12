import { contextLayerDefinition } from '../mcps/context-layer/index.js';
import type { McpDefinition } from './types.js';

/** Throws if any definition has an empty path or two share a path, so collisions fail fast. */
export function validateDefinitions(defs: readonly McpDefinition[]): void {
  const seen = new Set<string>();
  for (const def of defs) {
    if (!def.path) {
      throw new Error(`McpDefinition "${def.name}" has an empty path`);
    }
    if (seen.has(def.path)) {
      throw new Error(`Duplicate MCP path: ${def.path}`);
    }
    seen.add(def.path);
  }
}

const definitions: readonly McpDefinition[] = [contextLayerDefinition];

validateDefinitions(definitions);

/** Returns the statically registered MCP definitions. Add new MCPs to `definitions` above. */
export function getRegistry(): readonly McpDefinition[] {
  return definitions;
}
