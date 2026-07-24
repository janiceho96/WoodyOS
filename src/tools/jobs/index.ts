import type { JobSearchConfig } from './search.js';
import { searchJobs, testJobSearch } from './search.js';

export function isJobToolConfig(value: Record<string, unknown>): value is JobSearchConfig {
  return value.adapter === 'jobs.search' && value.provider === 'adzuna';
}

export function invokeJobTool(config: JobSearchConfig, input: Record<string, unknown>, healthCheck = false) {
  return healthCheck ? testJobSearch(config) : searchJobs(config, input);
}
