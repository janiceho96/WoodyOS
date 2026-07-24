import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('../src/tools/web/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/web/http.js')>();
  return { ...actual, safeHttpRequest: requestMock, assertPublicHttpsUrl: async (value: string) => new URL(value) };
});

import { extractWithFirecrawl } from '../src/tools/web/firecrawl.js';
import { readPublicPage } from '../src/tools/web/page-reader.js';
import { searchReddit } from '../src/tools/web/reddit.js';
import { searchWeb } from '../src/tools/web/search.js';

function response(body: unknown, url = 'https://provider.example/search', contentType = 'application/json') {
  return { status: 200, headers: { 'content-type': contentType }, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), url };
}

describe('web provider adapters', () => {
  beforeEach(() => requestMock.mockReset());

  it('normalizes Tavily results and sends bounded domain filters', async () => {
    requestMock.mockResolvedValue(response({ results: [{ title: 'Zhihu result', url: 'https://www.zhihu.com/question/123', content: 'Public excerpt', published_date: '2026-07-20' }], usage: { credits: 1 } }, 'https://api.tavily.com/search'));
    const output = await searchWeb({ adapter: 'web.search', provider: 'tavily', apiKey: 'tvly-secret', maxResults: 5 }, { query: 'AI agents', includeDomains: ['zhihu.com'], maxResults: 3 });
    expect(output).toMatchObject({ provider: 'tavily', resultCount: 1, results: [{ title: 'Zhihu result', sourceDomain: 'zhihu.com' }] });
    const [url, options] = requestMock.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(JSON.parse(options.body)).toMatchObject({
      max_results: 3,
      include_domains: ['zhihu.com'],
      include_raw_content: false,
      safe_search: true,
      include_usage: true,
    });
  });

  it('normalizes Brave results and applies site and freshness controls', async () => {
    requestMock.mockResolvedValue(response({ web: { results: [{ title: 'Reddit thread', url: 'https://www.reddit.com/r/LocalLLaMA/comments/abc', description: 'Discussion', extra_snippets: ['More context'] }] } }, 'https://api.search.brave.com/res/v1/web/search'));
    const output = await searchWeb({ adapter: 'web.search', provider: 'brave', apiKey: 'brave-secret', maxResults: 5 }, { query: 'local agents', includeDomains: ['reddit.com'], days: 7 });
    expect(output.results[0]).toMatchObject({ sourceDomain: 'reddit.com', snippet: 'Discussion More context' });
    const called = new URL(requestMock.mock.calls[0][0]);
    expect(called.searchParams.get('q')).toContain('site:reddit.com');
    expect(called.searchParams.get('freshness')).toBe('pw');
  });

  it('filters SearXNG output using configured domain policy', async () => {
    requestMock.mockResolvedValue(response({ results: [
      { title: 'Allowed', url: 'https://docs.example.com/guide', content: 'Guide' },
      { title: 'Blocked', url: 'https://blocked.example.net/post', content: 'No' },
    ] }, 'https://search.example.org/search?q=agents&format=json'));
    const output = await searchWeb({ adapter: 'web.search', provider: 'searxng', endpoint: 'https://search.example.org/search', allowedDomains: ['example.com'] }, { query: 'agents' });
    expect(output.results).toHaveLength(1);
    expect(output.results[0].title).toBe('Allowed');
  });

  it('searches Firecrawl without enabling page extraction or interactive actions', async () => {
    requestMock.mockResolvedValue(response({ success: true, data: { web: [{ title: 'Firecrawl guide', url: 'https://docs.example.com/firecrawl', description: 'Bounded result' }] }, creditsUsed: 1 }, 'https://api.firecrawl.dev/v2/search'));
    const output = await searchWeb({ adapter: 'web.search', provider: 'firecrawl', apiKey: 'fc-secret', maxResults: 4 }, { query: 'agent research', excludeDomains: ['blocked.example'] });
    expect(output).toMatchObject({ provider: 'firecrawl', resultCount: 1, usage: { credits: 1 } });
    const [url, options] = requestMock.mock.calls[0];
    expect(url).toBe('https://api.firecrawl.dev/v2/search');
    expect(JSON.parse(options.body)).toMatchObject({ query: 'agent research', limit: 4, sources: ['web'], excludeDomains: ['blocked.example'] });
    expect(options.body).not.toMatch(/scrapeOptions|actions|crawl/i);
  });

  it('extracts bounded Firecrawl Markdown as untrusted evidence', async () => {
    requestMock.mockResolvedValue(response({ success: true, data: { markdown: '# Finding\\n\\nUseful evidence', metadata: { title: 'Research page' } } }, 'https://api.firecrawl.dev/v2/scrape'));
    const output = await extractWithFirecrawl({ adapter: 'web.page.extract', provider: 'firecrawl', apiKey: 'fc-secret', allowedDomains: ['example.org'], maxCharacters: 10_000 }, { url: 'https://example.org/report' });
    expect(output).toMatchObject({ provider: 'firecrawl', title: 'Research page', truncated: false });
    expect(output.content).toContain('Useful evidence');
    expect(output.safetyNotice).toMatch(/untrusted evidence/i);
    const body = JSON.parse(requestMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ url: 'https://example.org/report', formats: ['markdown'], onlyMainContent: true, blockAds: true, proxy: 'basic', storeInCache: false });
    expect(body).not.toHaveProperty('actions');
  });

  it('rejects Firecrawl PDF extraction before spending variable per-page credits', async () => {
    await expect(extractWithFirecrawl({ adapter: 'web.page.extract', provider: 'firecrawl', apiKey: 'fc-secret' }, { url: 'https://example.org/large-report.pdf' })).rejects.toThrow(/PDF extraction is disabled/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('reads a bounded public HTML page and labels it as untrusted evidence', async () => {
    requestMock.mockResolvedValue(response('<html><head><title>Article</title></head><body><article><h1>Finding</h1><p>Useful evidence</p><script>bad()</script></article></body></html>', 'https://example.org/article', 'text/html'));
    const output = await readPublicPage({ adapter: 'web.page.read', allowedDomains: ['example.org'], maxCharacters: 20_000 }, { url: 'https://example.org/article' });
    expect(output).toMatchObject({ type: 'public_page', title: 'Article', truncated: false });
    expect(output.content).toContain('Useful evidence');
    expect(output.content).not.toContain('bad()');
    expect(output.safetyNotice).toMatch(/untrusted evidence/i);
  });

  it('uses Reddit OAuth and returns Reddit permalinks rather than outbound links', async () => {
    requestMock
      .mockResolvedValueOnce(response({ access_token: 'oauth-token', expires_in: 3600 }, 'https://www.reddit.com/api/v1/access_token'))
      .mockResolvedValueOnce(response({ data: { children: [{ data: { id: 'abc', title: 'Agent discussion', permalink: '/r/agents/comments/abc/thread/', subreddit: 'agents', author: 'user', score: 42, num_comments: 7, created_utc: 1_700_000_000, selftext: 'Opinion and experience' } }] } }, 'https://oauth.reddit.com/search'));
    const output = await searchReddit({ adapter: 'reddit.search', clientId: 'test-client-unique', clientSecret: 'test-secret-value', userAgent: 'macos:woody-test:v0.1 (by /u/test)' }, { query: 'agent workflows' });
    expect(output).toMatchObject({ provider: 'reddit-data-api', resultCount: 1, results: [{ url: 'https://www.reddit.com/r/agents/comments/abc/thread/', subreddit: 'agents' }] });
    expect(requestMock.mock.calls[0][1].headers.authorization).toMatch(/^Basic /);
    expect(requestMock.mock.calls[1][1].headers.authorization).toBe('Bearer oauth-token');
  });
});
