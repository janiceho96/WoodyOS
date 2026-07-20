import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { asyncRoute, parse } from '../../lib/http.js';
import {
  credentialPayload,
  encryptMcpCredentials,
  type McpAuthInput,
} from '../../mcp/credentials.js';
import { discoverMcpTools, testMcpConnection } from '../../mcp/connections.js';
import { McpError } from '../../mcp/errors.js';
import { assertSafeMcpEndpoint } from '../../mcp/network.js';
import { curatedMcpApp } from '../../mcp/registry/curated.js';

const idParams = z.object({ id: z.string().uuid() });
const toolParams = z.object({ id: z.string().uuid(), toolId: z.string().uuid() });
const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().min(1).max(16_000) }),
  z.object({ type: z.literal('custom_headers'), headers: z.record(z.string().max(8_000)) }),
  z.object({
    type: z.literal('oauth2'),
    clientId: z.string().min(1).max(2_000).optional(),
    clientSecret: z.string().min(1).max(8_000).optional(),
  }),
]);
const createInput = z.object({
  curatedAppId: z.string().min(1).max(100).optional(),
  catalogServerId: z.string().uuid().optional(),
  catalogEndpointId: z.string().uuid().optional(),
  name: z.string().min(2).max(260).optional(),
  description: z.string().max(2_000).default(''),
  endpointUrl: z.string().url().max(4_000).optional(),
  transport: z.literal('streamable-http').default('streamable-http'),
  auth: authSchema.default({ type: 'none' }),
}).refine((value) => Boolean(value.curatedAppId || value.catalogEndpointId || value.endpointUrl), {
  message: 'Choose a curated app, Registry endpoint, or enter a custom endpointUrl',
});
const updateInput = z.object({
  name: z.string().min(2).max(260).optional(),
  description: z.string().max(2_000).optional(),
  enabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'No changes supplied');
const toolUpdateInput = z.object({
  enabled: z.boolean().optional(),
  riskLevel: z.enum(['read', 'write', 'destructive', 'external_write', 'unknown']).optional(),
}).refine((value) => Object.keys(value).length > 0, 'No changes supplied');
const bulkToolUpdateInput = z.object({
  mode: z.enum(['enable_read_only', 'disable_all']),
});

async function endpointFor(input: {
  curatedAppId?: string;
  catalogServerId?: string;
  catalogEndpointId?: string;
  name?: string;
  description?: string;
  endpointUrl?: string;
  transport?: 'streamable-http';
}) {
  if (input.curatedAppId) {
    const app = curatedMcpApp(input.curatedAppId);
    if (!app) throw new McpError('MCP_CURATED_APP_NOT_FOUND', 'Curated MCP app not found', 404);
    if (!app.installable || !app.endpointUrl) {
      throw new McpError('MCP_CURATED_APP_UNAVAILABLE', app.setupNote, 422);
    }
    const endpoint = await assertSafeMcpEndpoint(app.endpointUrl);
    const registry = app.registryName ? await query<{ server_id: string; endpoint_id: string | null }>(
      `SELECT s.id server_id,e.id endpoint_id FROM mcp_catalog_servers s
       LEFT JOIN mcp_catalog_endpoints e ON e.catalog_server_id=s.id AND e.endpoint_url=$2 AND e.supported=true
       WHERE s.registry_name=$1 AND s.is_latest=true AND s.registry_status <> 'deleted' LIMIT 1`,
      [app.registryName, endpoint.toString()],
    ) : null;
    return {
      endpointUrl: endpoint.toString(),
      catalogServerId: registry?.rows[0]?.server_id ?? null,
      catalogEndpointId: registry?.rows[0]?.endpoint_id ?? null,
      name: app.title,
      description: app.description,
      transport: 'streamable-http',
      allowedAuthModes: app.authModes,
      requiresOAuthClient: Boolean(app.requiresOAuthClient),
    };
  }
  if (!input.catalogEndpointId) {
    const endpoint = await assertSafeMcpEndpoint(input.endpointUrl ?? '');
    return {
      endpointUrl: endpoint.toString(),
      catalogServerId: null,
      catalogEndpointId: null,
      name: input.name ?? endpoint.hostname,
      description: input.description ?? '',
      transport: input.transport ?? 'streamable-http',
      allowedAuthModes: ['none', 'oauth2', 'bearer', 'custom_headers'],
      requiresOAuthClient: false,
    };
  }
  const result = await query<{
    endpoint_url: string;
    transport: string;
    supported: boolean;
    catalog_server_id: string;
    title: string;
    description: string;
  }>(
    `SELECT e.endpoint_url,e.transport,e.supported,e.catalog_server_id,s.title,s.description
     FROM mcp_catalog_endpoints e JOIN mcp_catalog_servers s ON s.id=e.catalog_server_id
     WHERE e.id=$1 AND s.registry_status <> 'deleted'`,
    [input.catalogEndpointId],
  );
  if (!result.rowCount) throw new McpError('MCP_CATALOG_ENDPOINT_NOT_FOUND', 'Registry MCP endpoint not found', 404);
  const row = result.rows[0];
  if (!row.supported || row.transport !== 'streamable-http') {
    throw new McpError('MCP_TRANSPORT_UNSUPPORTED', 'Only remote Streamable HTTP MCP servers are supported in this release', 422);
  }
  if (input.catalogServerId && input.catalogServerId !== row.catalog_server_id) {
    throw new McpError('MCP_CATALOG_ENDPOINT_MISMATCH', 'The selected endpoint does not belong to this Registry server', 400);
  }
  const endpoint = await assertSafeMcpEndpoint(row.endpoint_url);
  return {
    endpointUrl: endpoint.toString(),
    catalogServerId: row.catalog_server_id,
    catalogEndpointId: input.catalogEndpointId,
    name: input.name ?? row.title,
    description: input.description || row.description,
    transport: row.transport,
    allowedAuthModes: ['none', 'oauth2', 'bearer', 'custom_headers'],
    requiresOAuthClient: false,
  };
}

export async function mcpConnectionRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => ({
    data: (await query(
      `SELECT c.id,c.catalog_server_id,c.name,c.description,c.transport,c.endpoint_url,c.auth_type,c.enabled,
       c.health_status,c.consecutive_failures,c.last_health_check_at,c.last_success_at,c.last_error_code,
       c.last_error_message,c.server_info,c.server_capabilities,c.created_at,c.updated_at,
       (c.auth_type <> 'oauth2' OR c.auth_metadata ? 'authorizedAt') authorized,
       count(DISTINCT t.id)::int tool_count,
       count(DISTINCT a.agent_id)::int agent_count
       FROM mcp_connections c
       LEFT JOIN mcp_connection_tools t ON t.connection_id=c.id
       LEFT JOIN mcp_agent_access a ON a.connection_id=c.id AND a.enabled=true
       WHERE c.workspace_id=$1 AND c.deleted_at IS NULL
       GROUP BY c.id ORDER BY c.created_at DESC`,
      [request.user.workspaceId],
    )).rows,
  })));

  app.post('/', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(createInput, request.body, reply);
    if (!input) return;
    const auth = input.auth ?? { type: 'none' as const };
    const endpoint = await endpointFor(input);
    if (!endpoint.allowedAuthModes.includes(auth.type)) {
      throw new McpError('MCP_AUTH_MODE_UNSUPPORTED', `${endpoint.name} does not support the selected authentication method`, 422);
    }
    if (endpoint.requiresOAuthClient && (auth.type !== 'oauth2' || !auth.clientId || !auth.clientSecret)) {
      throw new McpError('MCP_OAUTH_CLIENT_REQUIRED', `${endpoint.name} requires an OAuth client ID and client secret`, 422);
    }
    const id = randomUUID();
    const credentials = credentialPayload(auth as McpAuthInput);
    const encrypted = credentials
      ? encryptMcpCredentials(request.user.workspaceId, id, credentials)
      : null;
    const result = await query(
      `INSERT INTO mcp_connections(
         id,workspace_id,catalog_server_id,catalog_endpoint_id,name,description,transport,endpoint_url,
         auth_type,encrypted_credentials,installed_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id,catalog_server_id,name,description,transport,endpoint_url,auth_type,enabled,
       health_status,created_at,updated_at`,
      [
        id,
        request.user.workspaceId,
        endpoint.catalogServerId,
        endpoint.catalogEndpointId,
        endpoint.name,
        endpoint.description,
        endpoint.transport,
        endpoint.endpointUrl,
        auth.type,
        encrypted ? JSON.stringify(encrypted) : null,
        request.user.sub,
      ],
    );
    await audit(request.user.workspaceId, request.user.sub, 'mcp.connection.installed', 'mcp_connection', id, {
      catalogServerId: endpoint.catalogServerId,
      transport: endpoint.transport,
      authType: auth.type,
    });
    return reply.code(201).send(result.rows[0]);
  }));

  app.post('/:id/test', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(idParams, request.params, reply);
    if (!input) return;
    const result = await testMcpConnection(request.user.workspaceId, input.id);
    await audit(request.user.workspaceId, request.user.sub, 'mcp.connection.tested', 'mcp_connection', input.id, {
      status: result.status,
      durationMs: result.durationMs,
      toolsAvailable: result.toolsAvailable,
    });
    return result;
  }));

  app.post('/:id/discover-tools', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(idParams, request.params, reply);
    if (!input) return;
    const result = await discoverMcpTools(request.user.workspaceId, input.id);
    await audit(request.user.workspaceId, request.user.sub, 'mcp.tools.discovered', 'mcp_connection', input.id, result);
    return result;
  }));

  app.get('/:id/tools', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(idParams, request.params, reply);
    if (!input) return;
    const result = await query(
      `SELECT t.id,t.remote_name,t.title,t.description,t.input_schema,t.output_schema,t.annotations,
       t.risk_level,t.enabled,t.schema_hash,t.discovered_at,t.updated_at
       FROM mcp_connection_tools t JOIN mcp_connections c ON c.id=t.connection_id
       WHERE c.id=$1 AND c.workspace_id=$2 AND c.deleted_at IS NULL
       ORDER BY COALESCE(t.title,t.remote_name)`,
      [input.id, request.user.workspaceId],
    );
    return { data: result.rows };
  }));

  app.patch('/:id/tools', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(bulkToolUpdateInput, request.body, reply);
    if (!params || !input) return;
    const result = await query<{ enabled: boolean; count: number }>(
      `WITH updated AS (
         UPDATE mcp_connection_tools t SET
           enabled=CASE WHEN $1='enable_read_only' THEN t.risk_level='read' ELSE false END,
           updated_at=now()
         FROM mcp_connections c
         WHERE t.connection_id=c.id AND c.id=$2 AND c.workspace_id=$3 AND c.deleted_at IS NULL
         RETURNING t.enabled
       )
       SELECT enabled,count(*)::int count FROM updated GROUP BY enabled`,
      [input.mode, params.id, request.user.workspaceId],
    );
    if (!result.rowCount) {
      const connection = await query(
        'SELECT id FROM mcp_connections WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL',
        [params.id, request.user.workspaceId],
      );
      if (!connection.rowCount) return reply.code(404).send({ error: 'MCP_CONNECTION_NOT_FOUND' });
    }
    const enabled = result.rows.find((row) => row.enabled)?.count ?? 0;
    const disabled = result.rows.find((row) => !row.enabled)?.count ?? 0;
    await audit(request.user.workspaceId, request.user.sub, 'mcp.tools.bulk_updated', 'mcp_connection', params.id, {
      mode: input.mode,
      enabled,
      disabled,
    });
    return { mode: input.mode, enabled, disabled };
  }));

  app.patch('/:id/tools/:toolId', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(toolParams, request.params, reply);
    const input = parse(toolUpdateInput, request.body, reply);
    if (!params || !input) return;
    const result = await query(
      `UPDATE mcp_connection_tools t SET
       enabled=COALESCE($1,t.enabled),risk_level=COALESCE($2,t.risk_level),updated_at=now()
       FROM mcp_connections c
       WHERE t.id=$3 AND t.connection_id=c.id AND c.id=$4 AND c.workspace_id=$5 AND c.deleted_at IS NULL
       RETURNING t.id,t.remote_name,t.title,t.description,t.input_schema,t.output_schema,t.annotations,
       t.risk_level,t.enabled,t.schema_hash,t.discovered_at,t.updated_at`,
      [input.enabled ?? null, input.riskLevel ?? null, params.toolId, params.id, request.user.workspaceId],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'MCP_TOOL_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, 'mcp.tool.updated', 'mcp_tool', params.toolId, input);
    return result.rows[0];
  }));

  app.put('/:id/credentials', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const auth = parse(authSchema, request.body, reply);
    if (!params || !auth) return;
    const existing = await query('SELECT id FROM mcp_connections WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL', [params.id, request.user.workspaceId]);
    if (!existing.rowCount) return reply.code(404).send({ error: 'MCP_CONNECTION_NOT_FOUND' });
    const credentials = credentialPayload(auth as McpAuthInput);
    const encrypted = credentials ? encryptMcpCredentials(request.user.workspaceId, params.id, credentials) : null;
    await query(
      `UPDATE mcp_connections SET auth_type=$1,encrypted_credentials=$2,health_status='unknown',
       last_error_code=NULL,last_error_message=NULL,updated_at=now()
       WHERE id=$3 AND workspace_id=$4`,
      [auth.type, encrypted ? JSON.stringify(encrypted) : null, params.id, request.user.workspaceId],
    );
    await audit(request.user.workspaceId, request.user.sub, 'mcp.credentials.updated', 'mcp_connection', params.id, {
      authType: auth.type,
    });
    return reply.code(204).send();
  }));

  app.patch('/:id', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(updateInput, request.body, reply);
    if (!params || !input) return;
    if (input.enabled === true) {
      const health = await query<{ health_status: string }>(
        'SELECT health_status FROM mcp_connections WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL',
        [params.id, request.user.workspaceId],
      );
      if (!health.rowCount) return reply.code(404).send({ error: 'MCP_CONNECTION_NOT_FOUND' });
      if (health.rows[0].health_status !== 'healthy') {
        return reply.code(409).send({ error: 'MCP_CONNECTION_TEST_REQUIRED', message: 'Test the connection successfully before enabling it' });
      }
    }
    const result = await query(
      `UPDATE mcp_connections SET name=COALESCE($1,name),description=COALESCE($2,description),
       enabled=COALESCE($3,enabled),health_status=CASE WHEN $3=false THEN 'disabled' ELSE health_status END,updated_at=now()
       WHERE id=$4 AND workspace_id=$5 AND deleted_at IS NULL
       RETURNING id,catalog_server_id,name,description,transport,endpoint_url,auth_type,enabled,
       health_status,last_health_check_at,last_success_at,last_error_code,last_error_message,server_info,server_capabilities,created_at,updated_at`,
      [input.name ?? null, input.description ?? null, input.enabled ?? null, params.id, request.user.workspaceId],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'MCP_CONNECTION_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, input.enabled === false ? 'mcp.connection.disabled' : 'mcp.connection.updated', 'mcp_connection', params.id, input);
    return result.rows[0];
  }));

  app.delete('/:id', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params) return;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const removed = await client.query(
        `UPDATE mcp_connections SET enabled=false,health_status='disabled',encrypted_credentials=NULL,
         auth_metadata='{}'::jsonb,deleted_at=now(),updated_at=now()
         WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL RETURNING id`,
        [params.id, request.user.workspaceId],
      );
      if (!removed.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'MCP_CONNECTION_NOT_FOUND' });
      }
      await client.query('DELETE FROM mcp_agent_access WHERE connection_id=$1', [params.id]);
      await client.query(
        'DELETE FROM mcp_agent_tool_access WHERE mcp_tool_id IN (SELECT id FROM mcp_connection_tools WHERE connection_id=$1)',
        [params.id],
      );
      await client.query('UPDATE mcp_connection_tools SET enabled=false,updated_at=now() WHERE connection_id=$1', [params.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await audit(request.user.workspaceId, request.user.sub, 'mcp.connection.uninstalled', 'mcp_connection', params.id);
    return reply.code(204).send();
  }));
}
