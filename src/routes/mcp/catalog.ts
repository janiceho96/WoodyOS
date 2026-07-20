import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../db/client.js';
import { asyncRoute, parse } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { syncMcpRegistry } from '../../mcp/registry/sync.js';
import { CURATED_MCP_APPS } from '../../mcp/registry/curated.js';

const listQuery = z.object({
  search: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).default(0),
  supportedOnly: z.enum(['true', 'false']).default('true'),
});

const idParams = z.object({ id: z.string().uuid() });
const syncInput = z.object({ forceFull: z.boolean().default(false) });

export async function mcpCatalogRoutes(app: FastifyInstance) {
  app.get('/featured', { preHandler: app.authenticate }, asyncRoute(async () => {
    const registryNames = CURATED_MCP_APPS.flatMap((entry) => entry.registryName ? [entry.registryName] : []);
    const catalog = registryNames.length ? await query<{
      id: string;
      registry_name: string;
      endpoint_id: string | null;
      endpoint_url: string | null;
    }>(
      `SELECT s.id,s.registry_name,e.id endpoint_id,e.endpoint_url
       FROM mcp_catalog_servers s
       LEFT JOIN mcp_catalog_endpoints e ON e.catalog_server_id=s.id AND e.supported=true
       WHERE s.is_latest=true AND s.registry_status <> 'deleted' AND s.registry_name = ANY($1::text[])`,
      [registryNames],
    ) : { rows: [] };
    const byRegistryName = new Map(catalog.rows.map((entry) => [entry.registry_name, entry]));
    return {
      data: CURATED_MCP_APPS.map((entry) => {
        const registry = entry.registryName ? byRegistryName.get(entry.registryName) : undefined;
        return {
          ...entry,
          catalogServerId: registry?.id ?? null,
          catalogEndpointId: registry?.endpoint_url === entry.endpointUrl ? registry.endpoint_id : null,
        };
      }),
    };
  }));

  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(listQuery, request.query, reply);
    if (!input) return;
    const filterValues: unknown[] = [];
    const clauses = [`s.registry_status <> 'deleted'`, 's.is_latest=true'];
    if (input.search) {
      filterValues.push(input.search);
      clauses.push(`to_tsvector('simple',s.registry_name || ' ' || s.title || ' ' || s.description) @@ websearch_to_tsquery('simple',$${filterValues.length})`);
    }
    if (input.supportedOnly === 'true') {
      clauses.push(`EXISTS (
        SELECT 1 FROM mcp_catalog_endpoints supported_endpoint
        WHERE supported_endpoint.catalog_server_id=s.id AND supported_endpoint.supported=true
      )`);
    }
    const result = await query(
      `SELECT s.id,s.registry_name,s.version,s.title,s.description,s.website_url,s.repository_url,s.icon_url,
       s.registry_status,s.registry_updated_at,
       COALESCE(jsonb_agg(
         jsonb_build_object(
           'id',e.id,'transport',e.transport,'endpoint_url',e.endpoint_url,
           'header_inputs',e.header_inputs,'supported',e.supported
         ) ORDER BY e.position
       ) FILTER (WHERE e.id IS NOT NULL),'[]'::jsonb) endpoints
       FROM mcp_catalog_servers s
       LEFT JOIN mcp_catalog_endpoints e ON e.catalog_server_id=s.id
       WHERE ${clauses.join(' AND ')}
       GROUP BY s.id
       ORDER BY COALESCE(s.registry_updated_at,s.updated_at) DESC,s.title
       LIMIT $${filterValues.length + 1} OFFSET $${filterValues.length + 2}`,
      [...filterValues, input.limit, input.offset],
    );
    const count = await query<{ count: string }>(
      `SELECT count(*) FROM mcp_catalog_servers s WHERE ${clauses.join(' AND ')}`,
      filterValues,
    );
    return { data: result.rows, total: Number(count.rows[0]?.count ?? 0), limit: input.limit, offset: input.offset };
  }));

  app.get('/sync/status', { preHandler: app.authenticate }, asyncRoute(async () => ({
    data: (await query(
      `SELECT registry_url,status,last_started_at,last_successful_sync_at,last_error_code,last_error_message,
       servers_seen,servers_updated,updated_at FROM mcp_registry_sync_state ORDER BY updated_at DESC LIMIT 1`,
    )).rows[0] ?? null,
  })));

  app.get('/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(idParams, request.params, reply);
    if (!input) return;
    const result = await query(
      `SELECT s.id,s.registry_name,s.version,s.title,s.description,s.website_url,s.repository_url,s.icon_url,
       s.registry_status,s.registry_updated_at,
       COALESCE(jsonb_agg(
         jsonb_build_object(
           'id',e.id,'transport',e.transport,'endpoint_url',e.endpoint_url,
           'header_inputs',e.header_inputs,'endpoint_variables',e.endpoint_variables,'supported',e.supported
         ) ORDER BY e.position
       ) FILTER (WHERE e.id IS NOT NULL),'[]'::jsonb) endpoints
       FROM mcp_catalog_servers s LEFT JOIN mcp_catalog_endpoints e ON e.catalog_server_id=s.id
       WHERE s.id=$1 GROUP BY s.id`,
      [input.id],
    );
    return result.rowCount ? result.rows[0] : reply.code(404).send({ error: 'MCP_CATALOG_SERVER_NOT_FOUND' });
  }));

  app.post('/sync', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(syncInput, request.body ?? {}, reply);
    if (!input) return;
    const result = await syncMcpRegistry(input);
    await audit(request.user.workspaceId, request.user.sub, 'mcp.catalog.synced', 'workspace', request.user.workspaceId, result);
    return result;
  }));
}
