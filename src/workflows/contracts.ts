import type { WorkflowEdge, WorkflowNode } from './definition.js';
import { workflowNodeDefinition, type WorkflowPort } from './registry.js';

export type JsonSchema = { type?: string; nullable?: boolean; items?: JsonSchema; properties?: Record<string, JsonSchema> };
export type ContractBinding = WorkflowEdge & {
  sourcePort?: string;
  targetPort?: string;
  sourceSchema?: JsonSchema;
  targetSchema?: JsonSchema;
  required?: boolean;
  nullable?: boolean;
};

export type ContractIssue = { code: 'NODE_PORT_UNKNOWN' | 'NODE_SCHEMA_INCOMPATIBLE'; nodeId: string; message: string; guidance: string };
export type ResolvedBinding = { source: string; target: string; sourcePort: string; targetPort: string; required: boolean; nullable: boolean; sourceSchema: JsonSchema; targetSchema: JsonSchema; legacy: boolean };

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
  return { binding: { source: source.id, target: target.id, sourcePort: sourcePort.id, targetPort: targetPort.id, required: edge.required ?? Boolean(targetPort.required), nullable: edge.nullable ?? false, sourceSchema: edge.sourceSchema ?? schemaFor(sourcePort), targetSchema: edge.targetSchema ?? schemaFor(targetPort), legacy } };
}

/** Contract compatibility is deliberately strict: only identical JSON value shapes (or any)
 * are accepted. Required output into an optional target is safe; no scalar/object/array coercion occurs. */
export function contractCompatible(binding: ResolvedBinding): boolean {
  const source = binding.sourceSchema.type; const target = binding.targetSchema.type;
  if (!source || !target || source === 'any' || target === 'any') return true;
  if (source !== target) return false;
  if (binding.required && binding.nullable && !binding.targetSchema.nullable) return false;
  if (source === 'array' && binding.sourceSchema.items && binding.targetSchema.items) {
    return contractCompatible({ ...binding, sourceSchema: binding.sourceSchema.items, targetSchema: binding.targetSchema.items });
  }
  return true;
}
