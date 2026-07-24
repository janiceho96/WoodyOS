import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('../src/tools/web/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/web/http.js')>();
  return { ...actual, safeHttpRequest: requestMock };
});

import { jobToolCatalog, jobToolInstallSchema, materializeJobTool } from '../src/tools/jobs/catalog.js';
import { searchJobs } from '../src/tools/jobs/search.js';

function response(body: unknown, url = 'https://api.adzuna.com/v1/api/jobs/sg/search/1') {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)), url };
}

describe('read-only job search', () => {
  beforeEach(() => requestMock.mockReset());

  it('publishes no credentials and materializes a least-privilege tool', () => {
    expect(JSON.stringify(jobToolCatalog)).not.toMatch(/appKey|appId|secret/i);
    const tool = materializeJobTool(jobToolInstallSchema.parse({ provider: 'adzuna', appId: 'woody-app', appKey: 'adzuna-secret', country: 'sg' }));
    expect(tool).toMatchObject({ kind: 'internal', permissions: ['web.read', 'jobs.read'] });
    expect(tool.config).toMatchObject({ adapter: 'jobs.search', provider: 'adzuna', readOnly: true, country: 'sg' });
  });

  it('normalizes listings and preserves attribution links', async () => {
    requestMock.mockResolvedValue(response({
      count: 42,
      results: [{
        id: 'job-1',
        title: 'AI Researcher',
        company: { display_name: 'Example Labs' },
        location: { display_name: 'Singapore' },
        category: { label: 'IT Jobs' },
        description: '<p>Research safe agents.</p>',
        contract_time: 'full_time',
        salary_min: 80_000,
        salary_max: 120_000,
        created: '2026-07-23T01:00:00Z',
        redirect_url: 'https://www.adzuna.sg/details/job-1',
      }],
    }));
    const output = await searchJobs({ adapter: 'jobs.search', provider: 'adzuna', appId: 'app-id', appKey: 'secret-key', country: 'sg', maxResults: 5 }, { query: 'AI researcher', location: 'Singapore', minSalary: 75_000 });
    expect(output).toMatchObject({
      provider: 'adzuna',
      resultCount: 1,
      jobs: [{ title: 'AI Researcher', company: 'Example Labs', location: 'Singapore', salaryMin: 80_000, source: 'Adzuna' }],
    });
    expect(output.jobs[0].description).toBe('Research safe agents.');
    expect(output.attributionInstruction).toMatch(/Adzuna/);
    const called = new URL(requestMock.mock.calls[0][0]);
    expect(called.searchParams.get('what')).toBe('AI researcher');
    expect(called.searchParams.get('where')).toBe('Singapore');
    expect(called.searchParams.get('salary_min')).toBe('75000');
    expect(called.searchParams.get('results_per_page')).toBe('5');
  });

  it('does not expose credentials in provider errors', async () => {
    requestMock.mockResolvedValue({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"error":"invalid private-job-key"}'),
      url: 'https://api.adzuna.com/?app_key=private-job-key',
    });
    const error = await searchJobs(
      { adapter: 'jobs.search', provider: 'adzuna', appId: 'private-app-id', appKey: 'private-job-key', country: 'sg' },
      { query: 'designer' },
    ).catch((cause: Error) => cause);
    expect(error.message).toMatch(/Adzuna could not complete/);
    expect(error.message).not.toMatch(/private-job-key|private-app-id/);
  });
});
