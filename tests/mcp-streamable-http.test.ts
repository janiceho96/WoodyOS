import { describe, expect, it } from 'vitest';
import { StreamableHttpAdapter } from '../src/mcp/transports/streamable-http.js';

describe('Streamable HTTP MCP adapter', () => {
  it('initializes, negotiates a session, discovers tools and calls one', async () => {
    const requests: Array<{ method: string; session: string | null; body: Record<string, unknown> | null }> = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      const headers = new Headers(init?.headers);
      requests.push({ method: init?.method ?? 'GET', session: headers.get('mcp-session-id'), body });
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (!body || body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const id = body.id;
      if (body.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'Test MCP', version: '1.0.0' },
          },
        }, { headers: { 'mcp-session-id': 'test-session' } });
      }
      if (body.method === 'ping') return Response.json({ jsonrpc: '2.0', id, result: {} });
      if (body.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            tools: [{
              name: 'lookup',
              title: 'Lookup',
              description: 'Find a record',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              annotations: { readOnlyHint: true },
            }],
          },
        });
      }
      if (body.method === 'tools/call') {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'found' }], isError: false },
        });
      }
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } });
    };
    const adapter = new StreamableHttpAdapter({
      validateEndpoint: async (raw) => new URL(raw),
      fetchFactory: () => fakeFetch,
    });
    const session = await adapter.connect({ endpointUrl: 'https://203.0.113.10/mcp' });
    expect(session.info.serverInfo).toMatchObject({ name: 'Test MCP', version: '1.0.0' });
    await session.ping();
    const tools = await session.listTools();
    expect(tools).toEqual([expect.objectContaining({ name: 'lookup', annotations: { readOnlyHint: true } })]);
    const result = await session.callTool('lookup', { query: 'invoice' });
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'found' }] });
    await session.close();
    expect(requests.find((request) => request.body?.method === 'initialize')?.session).toBeNull();
    expect(requests.find((request) => request.body?.method === 'tools/list')?.session).toBe('test-session');
  });

  it('propagates caller cancellation into a tool transport request', async () => {
    let toolSignal: AbortSignal | null = null;
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      if (body?.method === 'tools/call') toolSignal = init?.signal as AbortSignal;
      if (!body || body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: body.method === 'initialize'
          ? {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'Test MCP', version: '1.0.0' },
          }
          : body.method === 'tools/call'
            ? { content: [], isError: false }
            : {},
      });
    };
    const adapter = new StreamableHttpAdapter({
      validateEndpoint: async (raw) => new URL(raw),
      fetchFactory: () => fakeFetch,
    });
    const controller = new AbortController();
    const session = await adapter.connect({
      endpointUrl: 'https://203.0.113.10/mcp',
      signal: controller.signal,
    });
    await session.callTool('lookup', {}, controller.signal);
    controller.abort();

    expect(toolSignal?.aborted).toBe(true);
    await session.close();
  });
});
