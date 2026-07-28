import type { WorkflowDefinition } from '../../api';

type WorkflowEdge = WorkflowDefinition['edges'][number];
type WorkflowNodeType = WorkflowDefinition['nodes'][number]['type'];

function sameEdge(left: WorkflowEdge, right: WorkflowEdge) {
  return left.source === right.source && left.target === right.target && left.condition === right.condition;
}

export function replaceWorkflowEdge(
  edges: WorkflowDefinition['edges'],
  previous: WorkflowEdge,
  next: Pick<WorkflowEdge, 'source' | 'target'> & Partial<Omit<WorkflowEdge, 'source' | 'target'>>,
) {
  return edges.map((edge) => {
    if (!sameEdge(edge, previous)) return edge;
    const replaced: WorkflowEdge = { ...previous, ...next };
    if (Object.prototype.hasOwnProperty.call(next, 'condition') && next.condition === undefined) delete replaced.condition;
    return replaced;
  });
}

export function deriveWorkflowEdgeCondition(
  sourceType: WorkflowNodeType,
  targetType: WorkflowNodeType,
  sourceHandle?: string | null,
): { condition?: string; error?: string } {
  const branches = ['condition', 'loop'].includes(sourceType);
  let condition = branches && sourceHandle && sourceHandle !== 'output' ? sourceHandle : undefined;
  if (targetType === 'loop' && !branches) condition = 'continue';
  if (sourceType === 'condition' && !['true', 'false'].includes(condition ?? '')) {
    return { error: 'Use the True or False handle from a Condition.' };
  }
  if (sourceType === 'loop' && !['body', 'done'].includes(condition ?? '')) {
    return { error: 'Use the Body or Done handle from a Loop.' };
  }
  return { condition };
}

export function insertNodeOnEdge(
  edges: WorkflowDefinition['edges'],
  selected: WorkflowEdge,
  nodeId: string,
) {
  return [
    ...edges.filter((edge) => !sameEdge(edge, selected)),
    { source: selected.source, target: nodeId, ...(selected.condition ? { condition: selected.condition } : {}) },
    { source: nodeId, target: selected.target },
  ];
}
