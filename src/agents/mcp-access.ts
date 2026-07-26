import { query } from '../db/client.js';

type AgentStatus = 'draft' | 'active' | 'paused' | 'archived';
type PermissionLevel = 'read' | 'read_write';
type McpAvailabilityStatus =
  | 'available'
  | 'agent_inactive'
  | 'assignment_disabled'
  | 'connection_disabled'
  | 'connection_unhealthy'
  | 'tool_disabled';

type AgentMcpAccessRow = {
  agent_id: string;
  agent_status: AgentStatus;
  connection_id: string | null;
  connection_name: string | null;
  connection_permission: PermissionLevel | null;
  connection_access_enabled: boolean | null;
  connection_enabled: boolean | null;
  health_status: string | null;
  tool_id: string | null;
  remote_name: string | null;
  tool_title: string | null;
  risk_level: 'read' | 'write' | 'destructive' | 'external_write' | 'unknown' | null;
  tool_permission: PermissionLevel | null;
  tool_access_enabled: boolean | null;
  tool_enabled: boolean | null;
};

export type AgentMcpAccess = {
  agentId: string;
  agentStatus: AgentStatus;
  connections: Array<{
    id: string;
    name: string;
    permissionLevel: PermissionLevel;
    assignmentEnabled: boolean;
    availability: {
      available: boolean;
      status: McpAvailabilityStatus;
      connectionEnabled: boolean;
      healthStatus: string;
    };
    tools: Array<{
      id: string;
      remoteName: string;
      title: string | null;
      riskLevel: NonNullable<AgentMcpAccessRow['risk_level']>;
      permissionLevel: PermissionLevel;
      assignmentEnabled: boolean;
      availability: {
        available: boolean;
        status: McpAvailabilityStatus;
        toolEnabled: boolean;
      };
    }>;
  }>;
};

function connectionAvailability(row: AgentMcpAccessRow): McpAvailabilityStatus {
  if (row.agent_status !== 'active') return 'agent_inactive';
  if (!row.connection_access_enabled) return 'assignment_disabled';
  if (!row.connection_enabled) return 'connection_disabled';
  if (row.health_status !== 'healthy') return 'connection_unhealthy';
  return 'available';
}

function toolAvailability(row: AgentMcpAccessRow, connectionStatus: McpAvailabilityStatus): McpAvailabilityStatus {
  if (connectionStatus !== 'available') return connectionStatus;
  if (!row.tool_access_enabled) return 'assignment_disabled';
  if (!row.tool_enabled) return 'tool_disabled';
  return 'available';
}

export async function loadAgentMcpAccess(workspaceId: string, agentId: string): Promise<AgentMcpAccess | null> {
  const result = await query<AgentMcpAccessRow>(
    `SELECT a.id agent_id,a.status agent_status,
     c.id connection_id,c.name connection_name,access.permission_level connection_permission,
     access.enabled connection_access_enabled,c.enabled connection_enabled,c.health_status,
     tool.id tool_id,tool.remote_name,tool.title tool_title,tool.risk_level,
     tool.permission_level tool_permission,tool.access_enabled tool_access_enabled,tool.enabled tool_enabled
     FROM agents a
     LEFT JOIN mcp_agent_access access ON access.agent_id=a.id
     LEFT JOIN mcp_connections c ON c.id=access.connection_id
       AND c.workspace_id=a.workspace_id AND c.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT t.id,t.remote_name,t.title,t.risk_level,t.enabled,
       tool_access.permission_level,tool_access.enabled access_enabled
       FROM mcp_agent_tool_access tool_access
       JOIN mcp_connection_tools t ON t.id=tool_access.mcp_tool_id
       WHERE tool_access.agent_id=a.id AND t.connection_id=c.id
       ORDER BY COALESCE(t.title,t.remote_name)
     ) tool ON true
     WHERE a.id=$1 AND a.workspace_id=$2
     ORDER BY c.name,COALESCE(tool.title,tool.remote_name)`,
    [agentId, workspaceId],
  );
  if (!result.rowCount) return null;

  const agentStatus = result.rows[0].agent_status;
  const connections = new Map<string, AgentMcpAccess['connections'][number]>();
  for (const row of result.rows) {
    if (!row.connection_id || !row.connection_name || !row.connection_permission) continue;
    let connection = connections.get(row.connection_id);
    if (!connection) {
      const status = connectionAvailability(row);
      connection = {
        id: row.connection_id,
        name: row.connection_name,
        permissionLevel: row.connection_permission,
        assignmentEnabled: Boolean(row.connection_access_enabled),
        availability: {
          available: status === 'available',
          status,
          connectionEnabled: Boolean(row.connection_enabled),
          healthStatus: row.health_status ?? 'unknown',
        },
        tools: [],
      };
      connections.set(connection.id, connection);
    }
    if (!row.tool_id || !row.remote_name || !row.risk_level || !row.tool_permission) continue;
    const status = toolAvailability(row, connection.availability.status);
    connection.tools.push({
      id: row.tool_id,
      remoteName: row.remote_name,
      title: row.tool_title,
      riskLevel: row.risk_level,
      permissionLevel: row.tool_permission,
      assignmentEnabled: Boolean(row.tool_access_enabled),
      availability: {
        available: status === 'available',
        status,
        toolEnabled: Boolean(row.tool_enabled),
      },
    });
  }
  return { agentId, agentStatus, connections: [...connections.values()] };
}
