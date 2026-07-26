import type { WorkflowResources } from '../../api';

export function mcpAccessForAgent(resources: WorkflowResources | undefined, agentId: string | undefined) {
  const actions = resources?.mcpTools.filter((tool) => tool.agentId === agentId) ?? [];
  const connections = [...new Map(actions.map((tool) => [tool.connectionId, tool.connectionName])).values()];
  return { connections, actions };
}

export function mcpAccessSummary(resources: WorkflowResources | undefined, agentId: string | undefined) {
  if (!agentId) return 'Save this agent before assigning MCP access';
  const { actions } = mcpAccessForAgent(resources, agentId);
  return actions.length
    ? actions.map((tool) => `${tool.connectionName} · ${tool.title ?? tool.remoteName}`).join(', ')
    : 'No currently available MCP actions';
}
