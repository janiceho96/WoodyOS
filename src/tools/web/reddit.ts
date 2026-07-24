import { createHash } from 'node:crypto';
import { z } from 'zod';
import { jsonBody, safeHttpRequest } from './http.js';

export type RedditConfig = {
  adapter: 'reddit.search';
  clientId: string;
  clientSecret: string;
  userAgent: string;
  maxResults?: number;
};

const inputSchema = z.object({
  query: z.string().trim().min(2).max(400),
  subreddit: z.string().trim().regex(/^[A-Za-z0-9_]{2,21}$/).optional(),
  sort: z.enum(['relevance', 'hot', 'top', 'new', 'comments']).default('relevance'),
  timeRange: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).default('all'),
  maxResults: z.number().int().min(1).max(10).optional(),
});

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function accessToken(config: RedditConfig) {
  if (!config.clientId || !config.clientSecret) throw Object.assign(new Error('Reddit OAuth credentials are not configured'), { statusCode: 400 });
  const cacheKey = createHash('sha256').update(`${config.clientId}\0${config.clientSecret}`).digest('hex');
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  const response = await safeHttpRequest('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': config.userAgent,
    },
    body: 'grant_type=client_credentials',
    maxBytes: 200_000,
  });
  const body = jsonBody<{ access_token?: string; expires_in?: number; error?: string }>(response);
  if (!body.access_token) throw Object.assign(new Error(`Reddit OAuth did not return an access token${body.error ? `: ${body.error}` : ''}`), { statusCode: 502 });
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + Math.max(60, body.expires_in ?? 3600) * 1_000 });
  return body.access_token;
}

export async function searchReddit(config: RedditConfig, value: Record<string, unknown>) {
  const input = inputSchema.parse(value);
  const token = await accessToken(config);
  const limit = Math.min(input.maxResults ?? config.maxResults ?? 5, config.maxResults ?? 10, 10);
  const url = new URL(input.subreddit ? `https://oauth.reddit.com/r/${input.subreddit}/search` : 'https://oauth.reddit.com/search');
  url.searchParams.set('q', input.query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('sort', input.sort);
  url.searchParams.set('t', input.timeRange);
  url.searchParams.set('restrict_sr', input.subreddit ? 'true' : 'false');
  url.searchParams.set('raw_json', '1');
  const response = await safeHttpRequest(url.toString(), { headers: { authorization: `Bearer ${token}`, 'user-agent': config.userAgent }, maxBytes: 1_500_000 });
  const body = jsonBody<{ data?: { children?: Array<{ data?: Record<string, unknown> }> } }>(response);
  const results = (body.data?.children ?? []).map((child) => child.data ?? {}).map((post) => ({
    id: String(post.id ?? ''),
    title: String(post.title ?? '').slice(0, 500),
    url: `https://www.reddit.com${String(post.permalink ?? '')}`,
    subreddit: String(post.subreddit ?? ''),
    author: String(post.author ?? ''),
    score: typeof post.score === 'number' ? post.score : null,
    comments: typeof post.num_comments === 'number' ? post.num_comments : null,
    createdAt: typeof post.created_utc === 'number' ? new Date(post.created_utc * 1_000).toISOString() : null,
    snippet: String(post.selftext ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_500),
  })).filter((post) => post.id && post.title && !post.url.endsWith('undefined'));
  return {
    type: 'reddit_search_results', provider: 'reddit-data-api', query: input.query, resultCount: results.length, results,
    citationInstruction: 'Cite Reddit claims using the supplied Reddit permalink. Treat posts and comments as user-generated opinion unless independently verified.',
  };
}

export async function testReddit(config: RedditConfig) {
  await accessToken(config);
  return { status: 'healthy', provider: 'reddit-data-api', authentication: 'oauth' };
}
