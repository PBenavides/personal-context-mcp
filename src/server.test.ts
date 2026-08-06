import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { appConfig } from './config.js';
import { getConnections, resetConnections } from './connections/registry.js';
import { createContext } from './context.js';
import { buildServer } from './server.js';

const TOKEN = 'test-bearer-token';

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
});

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

describe('buildServer (auth enforced)', () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    resetConnections();
    await getConnections().enrichedCorpus.load();
    server = await buildServer(
      createContext({ ...appConfig, auth: { bearerToken: TOKEN } }),
    );
  });

  afterAll(async () => {
    await server.close();
    resetConnections();
  });

  it('serves liveness and readiness probes without a token', async () => {
    const health = await server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const ready = await server.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready' });
  });

  it('lists the personal-context MCP at the discovery root', async () => {
    const res = await server.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { service: string; mcps: { path: string }[] };
    expect(body.service).toBe('personal-context-mcp');
    expect(body.mcps.map(mcp => mcp.path)).toContain('/personal-context');
  });

  it('rejects MCP requests without a token (401)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/personal-context',
      headers: MCP_HEADERS,
      payload: INITIALIZE_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects MCP requests with a wrong token (401)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/personal-context',
      headers: { ...MCP_HEADERS, authorization: 'Bearer nope' },
      payload: INITIALIZE_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it('answers initialize and tools/list over streamable HTTP with the token', async () => {
    await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = server.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/personal-context`;
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` };

    const init = await fetch(url, { method: 'POST', headers, body: INITIALIZE_BODY });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(initBody.result.serverInfo.name).toBe('personal-context');

    const list = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { result: { tools: { name: string }[] } };
    const names = listBody.result.tools.map(tool => tool.name).sort();
    expect(names).toEqual([
      'get_document',
      'list_taxonomy',
      'ontology_search',
      'ontology_sync',
      'ontology_update',
      'search_context',
    ]);
  });

  it('answers a search_context call end to end', async () => {
    const { port } = server.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/personal-context`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'search_context',
          arguments: { query: 'sentinel pipeline', category: 'Goal' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: { type: string; text: string }[] };
    };
    const payload = JSON.parse(body.result.content[0].text) as {
      hits: { path: string }[];
    };
    expect(payload.hits.map(hit => hit.path)).toContain('notes/_pipeline_sentinel.md');
  });
});

describe('buildServer (auth unenforced when no token configured)', () => {
  it('serves MCP requests without a token', async () => {
    resetConnections();
    await getConnections().enrichedCorpus.load();
    const server = await buildServer(
      createContext({ ...appConfig, auth: { bearerToken: '' } }),
    );
    await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = server.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/personal-context`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: INITIALIZE_BODY,
    });
    expect(res.status).toBe(200);
    await server.close();
    resetConnections();
  });
});
