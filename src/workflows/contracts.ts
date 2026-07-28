import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from './definition.js';
import { workflowNodeDefinition, type WorkflowPort } from './registry.js';

export type JsonSchema = { type?: string; nullable?: boolean; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[] };
export type ContractBinding = WorkflowEdge & {
  sourcePort?: string;
  targetPort?: string;
  sourceSchema?: JsonSchema;
  targetSchema?: JsonSchema;
  required?: boolean;
  nullable?: boolean;
  transformId?: 'json_parse' | 'stringify';
};

export type ContractIssue = { code: 'NODE_PORT_UNKNOWN' | 'NODE_SCHEMA_INCOMPATIBLE'; nodeId: string; message: string; guidance: string };
export type ResolvedBinding = { source: string; target: string; sourcePort: string; targetPort: string; required: boolean; nullable: boolean; transformId?: ContractBinding['transformId']; sourceSchema: JsonSchema; targetSchema: JsonSchema; legacy: boolean };

function schemaFor(port: WorkflowPort | undefined): JsonSchema {
  const type = port?.dataType;
  if (!type || type === 'any') return {};
  return { type: type === 'text' ? 'string' : type === 'collection' ? 'array' : type };
}

function port(ports: WorkflowPort[], id: string | undefined, fallback: string): WorkflowPort | undefined {
  return ports.find((item) => item.id === (id ?? fallback));
}

/** Legacy saved definitions omit ports. They bind the source's `output` (or first output)
 * to the target's `input` (or first input), preserving historical workflow behavior. */
export function resolveBinding(edge: ContractBinding, nodes: Map<string, WorkflowNode>): { binding?: ResolvedBinding; issue?: ContractIssue } {
  const source = nodes.get(edge.source); const target = nodes.get(edge.target);
  if (!source || !target) return {};
  const sourcePorts = workflowNodeDefinition(source.type)?.outputPorts ?? [];
  const targetPorts = workflowNodeDefinition(target.type)?.inputPorts ?? [];
  const legacy = !edge.sourcePort && !edge.targetPort && !edge.sourceSchema && !edge.targetSchema;
  const sourcePort = port(sourcePorts, edge.sourcePort, sourcePorts.find((item) => item.id === 'output')?.id ?? sourcePorts[0]?.id ?? 'output');
  const targetPort = port(targetPorts, edge.targetPort, targetPorts.find((item) => item.id === 'input')?.id ?? targetPorts[0]?.id ?? 'input');
  if (!sourcePort || !targetPort) return { issue: { code: 'NODE_PORT_UNKNOWN', nodeId: target.id, message: `Binding ${source.id} → ${target.id} references an unavailable port`, guidance: 'Choose a port exposed by both connected nodes.' } };
  return { binding: { source: source.id, target: target.id, sourcePort: sourcePort.id, targetPort: targetPort.id, required: edge.required ?? Boolean(targetPort.required), nullable: edge.nullable ?? false, transformId: edge.transformId, sourceSchema: edge.sourceSchema ?? schemaFor(sourcePort), targetSchema: edge.targetSchema ?? schemaFor(targetPort), legacy } };
}

/** Contract compatibility is deliberately strict: only identical JSON value shapes (or any)
 * are accepted. Required output into an optional target is safe; no scalar/object/array coercion occurs. */
export function contractCompatible(binding: ResolvedBinding): boolean {
  const source = binding.sourceSchema.type; const target = binding.targetSchema.type;
  // Dry-run must never promise a conversion that the runtime does not perform.
  if (binding.transformId) return false;
  if (!source || !target || source === 'any' || target === 'any') return true;
  if (source !== target) return false;
  if ((binding.nullable || binding.sourceSchema.nullable) && !binding.targetSchema.nullable) return false;
  if (source === 'array' && binding.targetSchema.items && !binding.sourceSchema.items) return false;
  if (source === 'array' && binding.sourceSchema.items && binding.targetSchema.items) {
    return contractCompatible({ ...binding, nullable: false, sourceSchema: binding.sourceSchema.items, targetSchema: binding.targetSchema.items });
  }
  if (source === 'object' && binding.targetSchema.properties) {
    for (const [key, targetProperty] of Object.entries(binding.targetSchema.properties)) {
      const sourceProperty = binding.sourceSchema.properties?.[key];
      if ((!sourceProperty || !binding.sourceSchema.required?.includes(key)) && binding.targetSchema.required?.includes(key)) return false;
      if (sourceProperty && !contractCompatible({ ...binding, nullable: false, sourceSchema: sourceProperty, targetSchema: targetProperty })) return false;
    }
  }
  return true;
}

/** Shared route/evaluation contract gate. Runtime adapters do not coerce bindings, so every
 * executable path must reject an absent required port or incompatible contract before work starts. */
export function workflowContractErrors(definition: WorkflowDefinition) {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const bindings = (definition.edges as ContractBinding[]).map((edge) => resolveBinding(edge, nodes));
  const errors = bindings.flatMap((result) => result.issue ? [result.issue.message] : result.binding && !contractCompatible(result.binding)
    ? [`Binding ${result.binding.source}.${result.binding.sourcePort} is incompatible with ${result.binding.target}.${result.binding.targetPort}`]
    : []);
  for (const node of definition.nodes) {
    const required = workflowNodeDefinition(node.type)?.inputPorts.filter((port) => port.required) ?? [];
    for (const port of required) {
      if (!bindings.some((result) => result.binding?.target === node.id && result.binding.targetPort === port.id)) {
        errors.push(`Required port ${node.id}.${port.id} has no binding`);
      }
    }
  }
  return errors;
}
