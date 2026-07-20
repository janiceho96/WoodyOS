import type { WorkflowDefinition, WorkflowNode } from '../../api';

export type WorkflowPosition = { nodeId: string; x: number; y: number };

export function autoLayoutPositions(nodes: WorkflowNode[], edges: WorkflowDefinition['edges']): WorkflowPosition[] {
  const trigger = nodes.find((node) => node.type === 'trigger') ?? nodes[0];
  if (!trigger) return [];
  const depth = new Map<string, number>([[trigger.id, 0]]);
  const queue = [trigger.id];
  while (queue.length) {
    const source = queue.shift()!;
    const nextDepth = (depth.get(source) ?? 0) + 1;
    for (const edge of edges.filter((candidate) => candidate.source === source && candidate.condition !== 'continue')) {
      if (!depth.has(edge.target) || nextDepth < (depth.get(edge.target) ?? Number.POSITIVE_INFINITY)) {
        depth.set(edge.target, nextDepth);
        queue.push(edge.target);
      }
    }
  }
  const groups = new Map<number, Array<{ node: WorkflowNode; order: number }>>();
  nodes.forEach((node, order) => {
    const nodeDepth = depth.get(node.id) ?? Math.max(1, ...depth.values()) + 1;
    groups.set(nodeDepth, [...(groups.get(nodeDepth) ?? []), { node, order }]);
  });
  const positions: WorkflowPosition[] = [];
  for (const [nodeDepth, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
    group.sort((left, right) => left.order - right.order);
    const totalHeight = (group.length - 1) * 170;
    group.forEach(({ node }, index) => positions.push({ nodeId: node.id, x: 50 + nodeDepth * 285, y: 280 - totalHeight / 2 + index * 170 }));
  }
  return positions;
}

