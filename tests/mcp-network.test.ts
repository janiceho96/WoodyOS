import { describe, expect, it, vi } from 'vitest';
import { assertSafeMcpEndpoint, deliverLookupResult, safeMcpHeaders, selectPreferredAddress } from '../src/mcp/network.js';

describe('MCP outbound network policy', () => {
  it('rejects non-HTTPS and embedded credentials before connecting', async () => {
    await expect(assertSafeMcpEndpoint('http://example.com/mcp')).rejects.toMatchObject({ code: 'MCP_ENDPOINT_HTTPS_REQUIRED' });
    await expect(assertSafeMcpEndpoint('https://user:secret@example.com/mcp')).rejects.toMatchObject({ code: 'MCP_ENDPOINT_CREDENTIALS_FORBIDDEN' });
  });

  it('rejects local and private destinations', async () => {
    await expect(assertSafeMcpEndpoint('https://127.0.0.1/mcp')).rejects.toMatchObject({ code: 'MCP_ENDPOINT_BLOCKED' });
    await expect(assertSafeMcpEndpoint('https://localhost/mcp')).rejects.toMatchObject({ code: 'MCP_ENDPOINT_BLOCKED' });
  });

  it('blocks hop-by-hop and authority headers', () => {
    expect(() => safeMcpHeaders({ Host: 'internal.example' })).toThrowError(/cannot be configured/);
    expect(() => safeMcpHeaders({ Authorization: 'Bearer safe' })).not.toThrow();
  });

  it('returns the callback shape requested by modern Node DNS lookups', () => {
    const selected = { address: '203.0.113.10', family: 4 };
    const allCallback = vi.fn();
    deliverLookupResult({ all: true }, selected, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [selected]);

    const singleCallback = vi.fn();
    deliverLookupResult({}, selected, singleCallback);
    expect(singleCallback).toHaveBeenCalledWith(null, selected.address, selected.family);
  });

  it('prefers IPv4 when Docker has no route for a public IPv6 result', () => {
    expect(selectPreferredAddress([
      { address: '2606:4700::6810:85e5', family: 6 },
      { address: '104.16.133.229', family: 4 },
    ])).toEqual({ address: '104.16.133.229', family: 4 });
  });
});
