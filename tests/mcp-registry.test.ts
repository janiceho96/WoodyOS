import { describe, expect, it, vi } from 'vitest';
import { fetchRegistryPage } from '../src/mcp/registry/client.js';

describe('MCP Registry client', () => {
  it('requests the official v0.1 latest-server catalog and validates it', async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/v0.1/servers');
      expect(url.searchParams.get('version')).toBe('latest');
      expect(url.searchParams.get('limit')).toBe('100');
      return new Response(JSON.stringify({
        servers: [{
          server: {
            name: 'io.example/search',
            title: 'Example Search',
            description: 'Search an example index',
            version: '1.0.0',
            remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/mcp' }],
          },
          _meta: {
            'io.modelcontextprotocol.registry/official': {
              status: 'active',
              isLatest: true,
            },
          },
        }],
        metadata: { count: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const page = await fetchRegistryPage({ fetchImpl: fetchImpl as typeof fetch });
    expect(page.servers[0].server.name).toBe('io.example/search');
    expect(page.servers[0].server.remotes?.[0].type).toBe('streamable-http');
  });

  it('rejects malformed Registry data with a human-readable code', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ servers: 'wrong', metadata: {} }), { status: 200 }));
    await expect(fetchRegistryPage({ fetchImpl: fetchImpl as typeof fetch })).rejects.toMatchObject({
      code: 'MCP_REGISTRY_RESPONSE_INVALID',
      message: expect.stringContaining('The MCP Registry returned unsupported fields'),
    });
  });
});
