import type { WorkflowCursor } from './adapters/types.js';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from './definition.js';

export const WORKFLOW_STEP_LIMIT = 10_000;

export function workflowOutgoing(definition: WorkflowDefinition, nodeId: string) {
  return definition.edges.filter((edge) => edge.source === nodeId);
}

export function workflowEdgeFor(node: WorkflowNode, edges: WorkflowEdge[], result: unknown) {
  if (node.type === 'condition') return edges.find((edge) => edge.condition === String(Boolean(result)));
  if (node.type === 'loop') return edges.find((edge) => edge.condition === result);
  return edges[0];
}

export function advanceWorkflowCursor(
  definition: WorkflowDefinition,
  cursor: WorkflowCursor,
  node: WorkflowNode,
  result: unknown,
) {
  const edge = workflowEdgeFor(node, workflowOutgoing(definition, node.id), result);
  if (!edge) return null;
  const loops = { ...cursor.loops };
  if (edge.condition === 'continue') {
    const loop = loops[edge.target];
    if (!loop) throw Object.assign(new Error(`Continue edge returned to inactive loop ${edge.target}`), { code: 'WORKFLOW_LOOP_CURSOR_INVALID' });
    loops[edge.target] = { iteration: loop.iteration + 1 };
  }
  if (node.type === 'loop' && result === 'done') delete loops[node.id];
  return { edge, cursor: { nodeId: edge.target, loops, attempt: 1, previousNodeId: node.id } };
}
