import type { FastifyInstance } from 'fastify';
import { query } from '../db/client.js';
import { asyncRoute } from '../lib/http.js';
import { CURATED_MCP_APPS } from '../mcp/registry/curated.js';

const blockedKeys = /token|password|secret|authorization|(^|[-_])auth($|[-_])|api[-_]?key|cookie|credential|private[-_]?key|session/i;

function boundedExternalValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => boundedExternalValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([key, entry]) => [
      key,
      blockedKeys.test(key) ? '[redacted]' : boundedExternalValue(entry, depth + 1),
    ]));
  }
  if (typeof value === 'string') return value.slice(0, 4_000);
  return value;
}

type McpResourceRow = {
  id: string;
  connection_id: string;
  connection_name: string;
  remote_name: string;
  title: string | null;
  description: string;
  input_schema: unknown;
  risk_level: string;
  agent_id: string;
  connection_permission: string;
  tool_permission: string;
  endpoint_url: string;
};

function normalizedEndpoint(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return value.replace(/\/+$/, '');
  }
}

const curatedByEndpoint = new Map(CURATED_MCP_APPS.flatMap((app) => app.endpointUrl
  ? [[normalizedEndpoint(app.endpointUrl), app] as const]
  : []));

export async function workflowResourceRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const workspaceId = request.user.workspaceId;
    const [agents, apiTools, mcpTools, knowledge] = await Promise.all([
      query('SELECT id,name,role,status,avatar_config,updated_at FROM agents WHERE workspace_id=$1 AND status=$2 ORDER BY name', [workspaceId, 'active']),
      query("SELECT id,name,kind,description,permissions FROM tools WHERE workspace_id=$1 AND enabled=true AND kind <> 'mcp' ORDER BY name", [workspaceId]),
      query<McpResourceRow>(
        `SELECT t.id,c.id connection_id,c.name connection_name,c.endpoint_url,t.remote_name,t.title,
         left(t.description,4000) description,t.input_schema,t.risk_level,
         access.agent_id,access.permission_level connection_permission,tool_access.permission_level tool_permission
         FROM mcp_connection_tools t
         JOIN mcp_connections c ON c.id=t.connection_id
         JOIN mcp_agent_access access ON access.connection_id=c.id AND access.enabled=true
         JOIN mcp_agent_tool_access tool_access ON tool_access.mcp_tool_id=t.id
           AND tool_access.agent_id=access.agent_id AND tool_access.enabled=true
         JOIN agents a ON a.id=access.agent_id AND a.workspace_id=c.workspace_id AND a.status='active'
         WHERE c.workspace_id=$1 AND c.deleted_at IS NULL AND c.enabled=true AND c.health_status='healthy' AND t.enabled=true
         ORDER BY c.name,COALESCE(t.title,t.remote_name),a.name`,
        [workspaceId],
      ),
      query<{ total: number; ready: number; processing: number; failed: number }>(
        `SELECT count(*)::int total,
         count(*) FILTER (WHERE status IN ('ready','indexed','completed'))::int ready,
         count(*) FILTER (WHERE status IN ('queued','processing'))::int processing,
         count(*) FILTER (WHERE status='failed')::int failed
         FROM knowledge_documents WHERE workspace_id=$1`,
        [workspaceId],
      ),
    ]);
    return {
      version: 1,
      agents: agents.rows,
      apiTools: apiTools.rows,
      mcpTools: mcpTools.rows.map((tool) => {
        const curated = curatedByEndpoint.get(normalizedEndpoint(tool.endpoint_url));
        return {
          id: tool.id,
          connectionId: tool.connection_id,
          connectionName: tool.connection_name,
          remoteName: tool.remote_name,
          title: tool.title,
          description: tool.description,
          inputSchema: boundedExternalValue(tool.input_schema),
          riskLevel: tool.risk_level,
          agentId: tool.agent_id,
          connectionPermission: tool.connection_permission,
          toolPermission: tool.tool_permission,
          appId: curated?.id ?? null,
          appTitle: curated?.title ?? tool.connection_name,
          brandColor: curated?.brandColor ?? null,
        };
      }),
      knowledge: { scope: 'workspace', ...(knowledge.rows[0] ?? { total: 0, ready: 0, processing: 0, failed: 0 }) },
    };
  }));
}
