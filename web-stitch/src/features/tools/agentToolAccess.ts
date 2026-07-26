import { isApiTool, type Tool } from '../../api';

export function normalizeAgentApiToolIds(assignedIds: string[], catalog: Tool[], additionalTools: Tool[] = []) {
  const allowed = new Set(
    [...catalog, ...additionalTools]
      .filter(isApiTool)
      .filter((tool) => tool.enabled)
      .map((tool) => tool.id),
  );
  const uniqueAssignedIds = [...new Set(assignedIds)];
  const toolIds = uniqueAssignedIds.filter((id) => allowed.has(id));
  return { toolIds, removedCount: uniqueAssignedIds.length - toolIds.length };
}
