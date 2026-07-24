import { z } from 'zod';
import { jsonBody, safeHttpRequest } from '../web/http.js';

export type JobSearchConfig = {
  adapter: 'jobs.search';
  provider: 'adzuna';
  appId: string;
  appKey: string;
  country: string;
  maxResults?: number;
};

export const jobSearchInput = z.object({
  query: z.string().trim().min(2).max(300),
  location: z.string().trim().max(200).optional(),
  minSalary: z.number().int().min(0).max(10_000_000).optional(),
  fullTime: z.boolean().optional(),
  permanent: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
});

function text(value: unknown, limit = 500) {
  return typeof value === 'string' ? value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

export async function searchJobs(config: JobSearchConfig, value: Record<string, unknown>) {
  if (!config.appId || !config.appKey) throw Object.assign(new Error('Adzuna credentials are not configured'), { statusCode: 400 });
  const input = jobSearchInput.parse(value);
  const limit = Math.min(input.maxResults ?? config.maxResults ?? 5, config.maxResults ?? 10, 10);
  const endpoint = new URL(`https://api.adzuna.com/v1/api/jobs/${config.country}/search/1`);
  endpoint.searchParams.set('app_id', config.appId);
  endpoint.searchParams.set('app_key', config.appKey);
  endpoint.searchParams.set('results_per_page', String(limit));
  endpoint.searchParams.set('what', input.query);
  endpoint.searchParams.set('content-type', 'application/json');
  endpoint.searchParams.set('sort_by', 'date');
  if (input.location) endpoint.searchParams.set('where', input.location);
  if (input.minSalary !== undefined) endpoint.searchParams.set('salary_min', String(input.minSalary));
  if (input.fullTime !== undefined) endpoint.searchParams.set('full_time', input.fullTime ? '1' : '0');
  if (input.permanent !== undefined) endpoint.searchParams.set('permanent', input.permanent ? '1' : '0');
  let body: { count?: number; results?: Array<Record<string, unknown>> };
  try {
    const response = await safeHttpRequest(endpoint.toString(), { maxBytes: 1_500_000, timeoutMs: 20_000 });
    body = jsonBody<{ count?: number; results?: Array<Record<string, unknown>> }>(response);
  } catch {
    throw Object.assign(
      new Error('Adzuna could not complete the search. Check the app ID, app key, country code, and provider availability.'),
      { statusCode: 502 },
    );
  }
  const jobs = (body.results ?? []).slice(0, limit).flatMap((item) => {
    const url = typeof item.redirect_url === 'string' ? item.redirect_url : '';
    if (!url.startsWith('https://')) return [];
    const company = item.company && typeof item.company === 'object' ? item.company as Record<string, unknown> : {};
    const location = item.location && typeof item.location === 'object' ? item.location as Record<string, unknown> : {};
    const category = item.category && typeof item.category === 'object' ? item.category as Record<string, unknown> : {};
    return [{
      id: String(item.id ?? url).slice(0, 500),
      title: text(item.title),
      company: text(company.display_name),
      location: text(location.display_name),
      category: text(category.label),
      description: text(item.description, 2_000),
      contractType: text(item.contract_type || item.contract_time, 100) || null,
      salaryMin: typeof item.salary_min === 'number' ? item.salary_min : null,
      salaryMax: typeof item.salary_max === 'number' ? item.salary_max : null,
      postedAt: typeof item.created === 'string' ? item.created.slice(0, 100) : null,
      url,
      source: 'Adzuna',
    }];
  });
  return {
    type: 'job_search_results',
    provider: 'adzuna',
    query: input.query,
    location: input.location ?? null,
    totalAvailable: typeof body.count === 'number' ? body.count : null,
    resultCount: jobs.length,
    jobs,
    attributionInstruction: 'Attribute these listings to Adzuna and link each role to its supplied Adzuna redirect URL. Verify important details on the source page before relying on them.',
  };
}

export async function testJobSearch(config: JobSearchConfig) {
  const output = await searchJobs({ ...config, maxResults: 1 }, { query: 'software', maxResults: 1 });
  return { provider: config.provider, status: 'healthy', resultCount: output.resultCount };
}
