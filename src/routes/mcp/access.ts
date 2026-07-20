import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { asyncRoute, parse } from '../../lib/http.js';

const connectionAgentParams = z.object({ id: z.string().uuid(), agentId: z.string().uuid() });
const accessInput = z.object({
  permissionLevel: z.enum(['read', 'read_write']),
  toolIds: z.array(z.string().uuid()).max(1_000).default([]),
  enabled: z.boolean().default(true),
});

export async function mcpAccessRoutes(app: FastifyInstance) {
  app.get('/:id/agents', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const params = parse(z.object({ id: z.string().uuid() }), request.params, reply);
    if (!params) return;
    const connection = await query(
      'SELECT id FROM mcp_connections WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL',
      [params.id, request.user.workspaceId],
    );
    if (!connection.rowCount) return reply.code(404).send({ error: 'MCP_CONNECTION_NOT_FOUND' });
    const result = await query(
      `SELECT a.id,a.name,a.role,a.status,access.permission_level,access.enabled,
       COALESCE(jsonb_agg(
         jsonb_build_object('toolId',tool_access.mcp_tool_id,'permissionLevel',tool_access.permission_level,'enabled',tool_access.enabled)
       ) FILTER (WHERE tool_access.mcp_tool_id IS NOT NULL),'[]'::jsonb) tools
       FROM agents a
       LEFT JOIN mcp_agent_access access ON access.agent_id=a.id AND access.connection_id=$1
       LEFT JOIN mcp_agent_tool_access tool_access ON tool_access.agent_id=a.id
         AND tool_access.mcp_tool_id IN (SELECT id FROM mcp_connection_tools WHERE connection_id=$1)
       WHERE a.workspace_id=$2
       GROUP BY a.id,access.permission_level,access.enabled
       ORDER BY a.name`,
      [params.id, request.user.workspaceId],
    );
    return { data: result.rows };
  }));

  app.put('/:id/agents/:agentId', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(connectionAgentParams, request.params, reply);
    const input = parse(accessInput, request.body, reply);
    if (!params || !input) return;
    const toolIds = input.toolIds ?? [];
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const valid = await client.query(
        `SELECT c.id FROM mcp_connections c JOIN agents a ON a.id=$2 AND a.workspace_id=c.workspace_id
         WHERE c.id=$1 AND c.workspace_id=$3 AND c.deleted_at IS NULL`,
        [params.id, params.agentId, request.user.workspaceId],
      );
      if (!valid.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'MCP_CONNECTION_OR_AGENT_NOT_FOUND' });
      }
      const tools = toolIds.length
        ? await client.query<{ id: string }>(
          `SELECT id FROM mcp_connection_tools WHERE connection_id=$1 AND enabled=true AND id=ANY($2::uuid[])`,
          [params.id, toolIds],
        )
        : { rows: [] as Array<{ id: string }> };
      if (tools.rows.length !== new Set(toolIds).size) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ error: 'MCP_TOOL_ACCESS_INVALID', message: 'Every allowed tool must be enabled on this connection' });
      }
      await client.query(
        `INSERT INTO mcp_agent_access(agent_id,connection_id,permission_level,enabled,assigned_by)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(agent_id,connection_id) DO UPDATE SET
         permission_level=EXCLUDED.permission_level,enabled=EXCLUDED.enabled,assigned_by=EXCLUDED.assigned_by,updated_at=now()`,
        [params.agentId, params.id, input.permissionLevel, input.enabled, request.user.sub],
      );
      await client.query(
        `DELETE FROM mcp_agent_tool_access WHERE agent_id=$1
         AND mcp_tool_id IN (SELECT id FROM mcp_connection_tools WHERE connection_id=$2)`,
        [params.agentId, params.id],
      );
      for (const tool of tools.rows) {
        await client.query(
          `INSERT INTO mcp_agent_tool_access(agent_id,mcp_tool_id,permission_level,enabled,assigned_by)
           VALUES($1,$2,$3,$4,$5)`,
          [params.agentId, tool.id, input.permissionLevel, input.enabled, request.user.sub],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await audit(request.user.workspaceId, request.user.sub, 'mcp.agent_access.updated', 'agent', params.agentId, {
      connectionId: params.id,
      permissionLevel: input.permissionLevel,
      toolCount: toolIds.length,
      enabled: input.enabled,
    });
    return { connectionId: params.id, agentId: params.agentId, ...input };
  }));
}
