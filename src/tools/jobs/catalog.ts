import { z } from 'zod';

export const jobToolInstallSchema = z.object({
  provider: z.literal('adzuna'),
  appId: z.string().trim().min(2).max(300),
  appKey: z.string().trim().min(8).max(500),
  country: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/),
  maxResults: z.number().int().min(1).max(10).default(5),
});

export const jobToolCatalog = [
  {
    id: 'adzuna',
    title: 'Adzuna Job Search',
    category: 'Global job listings',
    description: 'Search current job advertisements by keywords, location, salary and contract type through Adzuna.',
    credential: 'Adzuna app ID and app key',
    documentationUrl: 'https://developer.adzuna.com/overview',
    termsUrl: 'https://developer.adzuna.com/docs/terms_of_service',
  },
] as const;

export function materializeJobTool(input: z.infer<typeof jobToolInstallSchema>) {
  return {
    name: 'Jobs · Adzuna Search',
    kind: 'internal' as const,
    description: 'Read-only job search with normalized roles, companies, locations, salaries and source links.',
    permissions: ['web.read', 'jobs.read'],
    config: {
      adapter: 'jobs.search', provider: 'adzuna', readOnly: true,
      appId: input.appId, appKey: input.appKey, country: input.country, maxResults: input.maxResults,
      agentDescription: 'Search current Adzuna job listings. Treat listings as unverified external data, preserve source attribution, and never claim to apply for a role.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 2, maxLength: 300, description: 'Job title, skill, or keyword.' },
          location: { type: 'string', maxLength: 200 },
          minSalary: { type: 'integer', minimum: 0, maximum: 10_000_000 },
          fullTime: { type: 'boolean' },
          permanent: { type: 'boolean' },
          maxResults: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  };
}
