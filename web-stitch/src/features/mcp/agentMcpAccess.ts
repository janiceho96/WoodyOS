import type { AgentMcpAccess } from '../../api';

export function mcpAvailabilityLabel(status: AgentMcpAccess['connections'][number]['availability']['status'], agentStatus: AgentMcpAccess['agentStatus']) {
  if (status === 'available') return 'Available';
  if (status === 'agent_inactive') return `Unavailable · agent ${agentStatus}`;
  if (status === 'assignment_disabled') return 'Unavailable · assignment disabled';
  if (status === 'connection_disabled') return 'Unavailable · connection disabled';
  return 'Unavailable · connection unhealthy';
}

export function mcpToolAvailabilityLabel(tool: AgentMcpAccess['connections'][number]['tools'][number], access: AgentMcpAccess) {
  if (tool.availability.status === 'tool_disabled') return 'Unavailable · action disabled';
  return mcpAvailabilityLabel(tool.availability.status, access.agentStatus);
}

export function mcpAccessSummary(access: AgentMcpAccess | undefined) {
  if (!access?.connections.length) return 'No MCP access assigned';
  const actions = access.connections.flatMap((connection) => connection.tools.map((tool) =>
    `${connection.name} · ${tool.title ?? tool.remoteName} (${mcpToolAvailabilityLabel(tool, access)})`,
  ));
  if (actions.length) return actions.join(', ');
  return access.connections.map((connection) =>
    `${connection.name} · No actions assigned (${mcpAvailabilityLabel(connection.availability.status, access.agentStatus)})`,
  ).join(', ');
}
