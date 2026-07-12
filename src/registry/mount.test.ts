import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { mountMcp } from './mount.js';
import type { McpDefinition } from './types.js';

function makeMcp(): McpServer {
  const mcp = new McpServer({ name: 'stub', version: '0.0.0' });
  mcp.registerTool('ping', { inputSchema: {} }, () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return mcp;
}

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
};

describe('mountMcp', () => {
  it('responds 405 with a JSON-RPC error to GET and DELETE (stateless: POST only)', async () => {
    const app = Fastify();
    mountMcp(app, { path: 'x', name: 'x', version: '0.0.0', build: makeMcp });
    await app.ready();

    const get = await app.inject({ method: 'GET', url: '/x' });
    expect(get.statusCode).toBe(405);
    expect(get.json()).toMatchObject({ error: { code: -32000 } });

    const del = await app.inject({ method: 'DELETE', url: '/x' });
    expect(del.statusCode).toBe(405);

    await app.close();
  });

  it('builds a fresh MCP server per request and replies with JSON', async () => {
    let buildCount = 0;
    const build = (): McpServer => {
      buildCount += 1;
      return makeMcp();
    };
    const def: McpDefinition = {
      path: 'x',
      name: 'x',
      version: '0.0.0',
      build,
    };
    const app = Fastify();
    mountMcp(app, def);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/x`;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };

    const first = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(INITIALIZE_BODY),
    });
    const second = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(INITIALIZE_BODY),
    });

    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('application/json');
    expect(second.status).toBe(200);
    expect(buildCount).toBe(2);

    await app.close();
  });

  it('replies with a JSON-RPC 500 when building the MCP server throws', async () => {
    const def: McpDefinition = {
      path: 'boom',
      name: 'boom',
      version: '0.0.0',
      build: () => {
        throw new Error('build failed');
      },
    };
    const app = Fastify();
    mountMcp(app, def);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/boom`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(INITIALIZE_BODY),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: -32603 } });

    await app.close();
  });
});
