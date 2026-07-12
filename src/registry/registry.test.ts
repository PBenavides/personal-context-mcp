import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getRegistry, validateDefinitions } from './registry.js';
import type { McpDefinition } from './types.js';

function stub(path: string): McpDefinition {
  return {
    path,
    name: path || 'unnamed',
    version: '0.0.0',
    build: () => ({}) as unknown as McpServer,
  };
}

describe('validateDefinitions', () => {
  it('throws on duplicate paths', () => {
    expect(() => validateDefinitions([stub('a'), stub('a')])).toThrow(
      /Duplicate MCP path: a/,
    );
  });

  it('throws on an empty path', () => {
    expect(() => validateDefinitions([stub('')])).toThrow(/empty path/);
  });

  it('accepts unique, non-empty paths', () => {
    expect(() => validateDefinitions([stub('a'), stub('b')])).not.toThrow();
  });
});

describe('getRegistry', () => {
  it('registers the context-layer MCP with a unique path', () => {
    const paths = getRegistry().map(def => def.path);
    expect(paths).toContain('context-layer');
    expect(new Set(paths).size).toBe(paths.length);
  });
});
