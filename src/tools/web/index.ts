import type { FirecrawlExtractConfig } from './firecrawl.js';
import { extractWithFirecrawl, testFirecrawl } from './firecrawl.js';
import type { PageReaderConfig } from './page-reader.js';
import { readPublicPage, testPageReader } from './page-reader.js';
import type { RedditConfig } from './reddit.js';
import { searchReddit, testReddit } from './reddit.js';
import type { WebSearchConfig } from './search.js';
import { searchWeb, testWebSearch } from './search.js';

export type WebToolConfig = WebSearchConfig | FirecrawlExtractConfig | PageReaderConfig | RedditConfig;

export function isWebToolConfig(value: Record<string, unknown>): value is WebToolConfig {
  return value.adapter === 'web.search' || value.adapter === 'web.page.extract' || value.adapter === 'web.page.read' || value.adapter === 'reddit.search';
}

export async function invokeWebTool(config: WebToolConfig, input: Record<string, unknown>, healthCheck = false, signal?: AbortSignal) {
  if (config.adapter === 'web.search') return healthCheck ? testWebSearch(config, signal) : searchWeb(config, input, signal);
  if (config.adapter === 'web.page.extract') return healthCheck ? testFirecrawl(config, signal) : extractWithFirecrawl(config, input, signal);
  if (config.adapter === 'web.page.read') return healthCheck ? testPageReader(config) : readPublicPage(config, input, signal);
  return healthCheck ? testReddit(config, signal) : searchReddit(config, input, signal);
}
