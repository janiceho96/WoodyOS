import type { WorkflowDefinition } from '../../api';

type WorkflowEdge = WorkflowDefinition['edges'][number];

function sameEdge(left: WorkflowEdge, right: WorkflowEdge) {
  return left.source === right.source && left.target === right.target && left.condition === right.condition;
}

export function replaceWorkflowEdge(
  edges: WorkflowDefinition['edges'],
  previous: WorkflowEdge,
  next: Pick<WorkflowEdge, 'source' | 'target'> & Partial<Omit<WorkflowEdge, 'source' | 'target' | 'condition'>>,
) {
  return edges.map((edge) => sameEdge(edge, previous)
    ? { ...previous, ...next, ...(previous.condition ? { condition: previous.condition } : {}) }
    : edge);
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
