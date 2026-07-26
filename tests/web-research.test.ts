import { describe, expect, it } from 'vitest';
import { resolveAgentRuntimePolicy } from '../src/lib/agent-runtime.js';
import { materializeWebTool, webResearchCatalog, webToolInstallSchema } from '../src/tools/web/catalog.js';
import { createPinnedLookup, safeHttpRequest, validatedPublicHttpsUrl } from '../src/tools/web/http.js';
import { isWebToolConfig, invokeWebTool } from '../src/tools/web/index.js';
import { extractReadableHtml } from '../src/tools/web/page-reader.js';
import type { ToolRecord } from '../src/tools/runtime.js';

describe('web research security and configuration', () => {
  it('publishes a credential-free catalog and materializes read-only provider tools', () => {
    expect(webResearchCatalog.every((entry) => !('apiKey' in entry) && !('clientSecret' in entry))).toBe(true);
    const input = webToolInstallSchema.parse({ provider: 'tavily', apiKey: 'tvly-test-key', maxResults: 4 });
    const tool = materializeWebTool(input);
    expect(tool).toMatchObject({ kind: 'internal', permissions: ['web.read', 'web.search'] });
    expect(tool.config).toMatchObject({ adapter: 'web.search', provider: 'tavily', readOnly: true, maxResults: 4 });
  });

  it('keeps search, page reading, and Reddit as separate least-privilege tools', () => {
    const firecrawlSearch = materializeWebTool(webToolInstallSchema.parse({ provider: 'firecrawl-search', apiKey: 'fc-test-secret' }));
    const firecrawlExtract = materializeWebTool(webToolInstallSchema.parse({ provider: 'firecrawl-extract', apiKey: 'fc-test-secret' }));
    const reader = materializeWebTool(webToolInstallSchema.parse({ provider: 'page-reader', blockedDomains: ['example.com'] }));
    const reddit = materializeWebTool(webToolInstallSchema.parse({ provider: 'reddit', clientId: 'client', clientSecret: 'secret-value', userAgent: 'macos:woody:v0.1 (by /u/test)' }));
    expect(firecrawlSearch.permissions).toEqual(['web.read', 'web.search']);
    expect(firecrawlExtract.permissions).toEqual(['web.read', 'web.page.extract']);
    expect(firecrawlSearch.config).toMatchObject({ adapter: 'web.search', provider: 'firecrawl', readOnly: true });
    expect(firecrawlExtract.config).toMatchObject({ adapter: 'web.page.extract', provider: 'firecrawl', readOnly: true });
    expect(reader.permissions).toEqual(['web.read', 'web.page.read']);
    expect(reddit.permissions).toEqual(['web.read', 'reddit.read']);
    expect(reader.config.adapter).toBe('web.page.read');
    expect(reddit.config.adapter).toBe('reddit.search');
  });

  it('removes executable and navigational markup from public HTML', () => {
    const output = extractReadableHtml('<html><head><title>Test &amp; Safety</title><style>.secret{}</style></head><body><nav>Ignore nav</nav><article><h1>Useful</h1><p>Evidence &amp; details.</p><script>stealSecrets()</script></article></body></html>');
    expect(output.title).toBe('Test & Safety');
    expect(output.text).toContain('Useful');
    expect(output.text).toContain('Evidence & details.');
    expect(output.text).not.toMatch(/stealSecrets|Ignore nav|secret/);
  });

  it('blocks unsafe page-reader URL forms and private IPs', async () => {
    expect(() => validatedPublicHttpsUrl('http://example.com')).toThrow(/HTTPS/);
    expect(() => validatedPublicHttpsUrl('https://user:pass@example.com')).toThrow(/Credentials/);
    await expect(safeHttpRequest('https://127.0.0.1/private')).rejects.toThrow(/Private|reserved/);
  });

  it('returns a pinned address in both Node lookup modes', async () => {
    const lookup = createPinnedLookup({ address: '203.0.113.10', family: 4 });
    const single = await new Promise<{ address: string; family?: number }>((resolve, reject) => {
      lookup('example.com', { all: false }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family });
      });
    });
    const all = await new Promise<unknown>((resolve, reject) => {
      lookup('example.com', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });
    expect(single).toEqual({ address: '203.0.113.10', family: 4 });
    expect(all).toEqual([{ address: '203.0.113.10', family: 4 }]);
  });

  it('requires Web access before a web tool reaches an agent runtime', () => {
    const tool = { id: '7f3ddc26-08e1-4ffc-9d33-f527ac3bd85c', name: 'Web Search', kind: 'internal', config: {} as ToolRecord['config'], permissions: ['web.read', 'web.search'] } satisfies ToolRecord;
    const denied = resolveAgentRuntimePolicy({ model_config: {}, capabilities: { webBrowser: false }, memory_config: {}, tool_ids: [tool.id] }, [tool]);
    const allowed = resolveAgentRuntimePolicy({ model_config: {}, capabilities: { webBrowser: true }, memory_config: {}, tool_ids: [tool.id] }, [tool]);
    expect(denied.tools).toEqual([]);
    expect(denied.deniedTools).toEqual([tool]);
    expect(allowed.tools).toEqual([tool]);
  });

  it('can health-check the page reader without making an external request', async () => {
    const config = { adapter: 'web.page.read' as const, maxCharacters: 20_000 };
    expect(isWebToolConfig(config)).toBe(true);
    await expect(invokeWebTool(config, {}, true)).resolves.toMatchObject({ status: 'healthy', adapter: 'web.page.read' });
  });
});
