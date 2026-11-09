import type { WorkflowDefinition, WorkflowNodeCatalogEntry } from '../../api';

type WorkflowEdge = WorkflowDefinition['edges'][number];
type WorkflowNode = WorkflowDefinition['nodes'][number];
type WorkflowNodeType = WorkflowDefinition['nodes'][number]['type'];
type WorkflowPort = WorkflowNodeCatalogEntry['outputPorts'][number];
type WorkflowConnection = {
  source?: string | null;
  target?: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

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

const schemaFor = (dataType: string) => dataType === 'text'
  ? { type: 'string' }
  : dataType === 'collection'
    ? { type: 'array' }
    : dataType === 'any'
      ? {}
      : { type: dataType };

function resolvePort(
  catalog: WorkflowNodeCatalogEntry[],
  type: WorkflowNodeType,
  direction: 'source' | 'target',
  requested: string | null | undefined,
) {
  const definition = catalog.find((entry) => entry.type === type);
  if (!definition) return { error: `Node type ${type} is not available.` };
  const ports = direction === 'source' ? definition.outputPorts : definition.inputPorts;
  const fallbackId = direction === 'source' ? 'output' : 'input';
  const requestedId = requested ?? fallbackId;
  const exact = ports.find((port) => port.id === requestedId);
  if (exact) return { port: exact };
  const knownOnAnotherNode = catalog.some((entry) => [
    ...entry.inputPorts,
    ...entry.outputPorts,
  ].some((port) => port.id === requestedId));
  const fallback = ports.find((port) => port.id === fallbackId);
  if (knownOnAnotherNode && fallback) return { port: fallback };
  return {
    error: `${direction === 'source' ? 'Source' : 'Target'} handle ${requestedId} is not available on ${definition.title}.`,
  };
}

function connectionEndpoints(input: {
  nodes: WorkflowDefinition['nodes'];
  edges: WorkflowDefinition['edges'];
  connection: WorkflowConnection;
}) {
  const { connection, edges } = input;
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return { error: 'Connect two different nodes.' as const };
  }
  const source = input.nodes.find((node) => node.id === connection.source);
  const target = input.nodes.find((node) => node.id === connection.target);
  if (!source || !target || target.type === 'trigger' || source.type === 'output') {
    return { error: 'That connection direction is not valid.' as const };
  }
  return { source, target, edges };
}

function compatibleDataTypes(sourceType: string, targetType: string) {
  return sourceType === 'any' || targetType === 'any' || sourceType === targetType;
}

function connectionEdge(source: WorkflowNode, target: WorkflowNode, sourcePort: WorkflowPort, targetPort: WorkflowPort, condition?: string): WorkflowEdge {
  return {
    source: source.id,
    target: target.id,
    sourcePort: sourcePort.id,
    targetPort: targetPort.id,
    sourceSchema: schemaFor(sourcePort.dataType),
    targetSchema: schemaFor(targetPort.dataType),
    required: Boolean(targetPort.required),
    nullable: false,
    ...(condition ? { condition } : {}),
  };
}

function placeWorkflowEdge(
  input: { edges: WorkflowDefinition['edges']; previous?: WorkflowEdge },
  nextEdge: WorkflowEdge,
  source: WorkflowNode,
) {
  const identityIndex = input.previous ? input.edges.indexOf(input.previous) : -1;
  const previousIndex = input.previous && identityIndex < 0
    ? input.edges.findIndex((edge) => sameEdge(edge, input.previous!))
    : identityIndex;
  const withoutPrevious = input.edges.filter((_, index) => index !== previousIndex);
  if (withoutPrevious.some((edge) => sameEdge(edge, nextEdge))) {
    return { error: 'That connection already exists.' as const };
  }
  const replaceableIndex = !['condition', 'loop'].includes(source.type)
    ? withoutPrevious.findIndex((edge) => edge.source === source.id && edge.condition !== 'continue')
    : -1;
  if (replaceableIndex >= 0) {
    return { edges: withoutPrevious.map((edge, index) => index === replaceableIndex ? nextEdge : edge) };
  }
  const insertionIndex = previousIndex >= 0 ? Math.min(previousIndex, withoutPrevious.length) : withoutPrevious.length;
  return {
    edges: [
      ...withoutPrevious.slice(0, insertionIndex),
      nextEdge,
      ...withoutPrevious.slice(insertionIndex),
    ],
  };
}

export function mutateWorkflowEdge(input: {
  nodes: WorkflowDefinition['nodes'];
  edges: WorkflowDefinition['edges'];
  catalog: WorkflowNodeCatalogEntry[];
  connection: WorkflowConnection;
  previous?: WorkflowEdge;
}): { edges: WorkflowDefinition['edges']; error?: string } {
  const endpoints = connectionEndpoints(input);
  if ('error' in endpoints) return { edges: input.edges, error: endpoints.error };
  const { source, target, edges } = endpoints;
  const sourceResult = resolvePort(input.catalog, source.type, 'source', input.connection.sourceHandle);
  if (!sourceResult.port) return { edges, error: sourceResult.error };
  const targetResult = resolvePort(input.catalog, target.type, 'target', input.connection.targetHandle);
  if (!targetResult.port) return { edges, error: targetResult.error };
  const sourcePort = sourceResult.port;
  const targetPort = targetResult.port;
  if (!compatibleDataTypes(sourcePort.dataType, targetPort.dataType)) {
    return {
      edges,
      error: `${sourcePort.label} produces ${sourcePort.dataType}, but ${targetPort.label} expects ${targetPort.dataType}.`,
    };
  }
  const derived = deriveWorkflowEdgeCondition(source.type, target.type, sourcePort.id);
  if (derived.error) return { edges, error: derived.error };
  const nextEdge = connectionEdge(source, target, sourcePort, targetPort, derived.condition);
  const placed = placeWorkflowEdge(input, nextEdge, source);
  return 'error' in placed ? { edges, error: placed.error } : placed;
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
