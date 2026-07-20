import { z } from 'zod';
import { McpError, humanMcpError } from '../errors.js';
import type { McpRegistryPage } from '../types.js';

export const DEFAULT_MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

const headerSchema = z.object({
  // Invalid names are ignored by the synchronizer rather than making the
  // entire public catalog unavailable.
  name: z.string().max(1_000),
  description: z.string().max(2_000).optional(),
  isRequired: z.boolean().optional(),
  isSecret: z.boolean().optional(),
  value: z.string().max(4_000).optional(),
}).passthrough();

const remoteSchema = z.object({
  type: z.string().min(1).max(100),
  // Registry endpoints may contain declared URI-template variables. They are
  // preserved in the catalog, but are not installable until fully resolved.
  url: z.string().min(1).max(4_000),
  headers: z.array(headerSchema).max(100).optional(),
  variables: z.record(z.unknown()).optional(),
}).passthrough();

const serverSchema = z.object({
  name: z.string().min(1).max(500),
  title: z.string().max(500).optional(),
  description: z.string().max(20_000).optional(),
  version: z.string().min(1).max(200),
  websiteUrl: z.string().url().max(4_000).optional(),
  repository: z.object({
    url: z.string().url().max(4_000).optional(),
    source: z.string().max(100).optional(),
    id: z.string().max(1_000).optional(),
  }).passthrough().optional(),
  icons: z.array(z.object({
    src: z.string().url().max(4_000).optional(),
    mimeType: z.string().max(200).optional(),
  }).passthrough()).max(20).optional(),
  remotes: z.array(remoteSchema).max(100).optional(),
}).passthrough();

const registryPageSchema = z.object({
  servers: z.array(z.object({
    server: serverSchema,
    _meta: z.record(z.unknown()).optional(),
  }).passthrough()).max(100),
  metadata: z.object({
    nextCursor: z.string().max(8_000).optional(),
    count: z.number().int().nonnegative().optional(),
  }).passthrough(),
});

function registryBaseUrl() {
  const configured = process.env.MCP_REGISTRY_URL ?? DEFAULT_MCP_REGISTRY_URL;
  const url = new URL(configured);
  if (url.protocol !== 'https:') throw new McpError('MCP_REGISTRY_URL_INVALID', 'MCP_REGISTRY_URL must use HTTPS', 503);
  return url.origin;
}

export async function fetchRegistryPage(input: {
  cursor?: string;
  updatedSince?: string;
  includeDeleted?: boolean;
  fetchImpl?: typeof fetch;
} = {}): Promise<McpRegistryPage> {
  const url = new URL('/v0.1/servers', registryBaseUrl());
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', '100');
  if (input.cursor) url.searchParams.set('cursor', input.cursor);
  if (input.updatedSince) url.searchParams.set('updated_since', input.updatedSince);
  if (input.includeDeleted) url.searchParams.set('include_deleted', 'true');
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'ai-nexus-mcp-registry-sync/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new McpError(
        'MCP_REGISTRY_HTTP_ERROR',
        `The MCP Registry returned HTTP ${response.status}`,
        response.status >= 500 ? 502 : 424,
      );
    }
    const parsed = registryPageSchema.safeParse(await response.json());
    if (!parsed.success) {
      const fields = parsed.error.issues.slice(0, 5).map((issue) => issue.path.join('.') || 'response').join(', ');
      throw new McpError('MCP_REGISTRY_RESPONSE_INVALID', `The MCP Registry returned unsupported fields: ${fields}`, 502);
    }
    return parsed.data as McpRegistryPage;
  } catch (error) {
    throw humanMcpError(error);
  }
}
