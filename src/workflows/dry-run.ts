import { canonicalJsonHash, type WorkflowDependencySnapshot } from '../runtime/manifest.js';
import { evaluateCondition, valueAtPath, workflowDefinitionErrors, type WorkflowDefinition, type WorkflowNode } from './definition.js';
import { contractCompatible, resolveBinding, type ContractBinding } from './contracts.js';
import { workflowNodeDefinition } from './registry.js';

type AgentResource = { id: string; versionId: string | null; version: number | null; snapshotHash?: string };
type ToolResource = { id: string; kind: string; risk: string; permissions: string[]; requiresApproval?: boolean; connectionId?: string; agentIds?: string[]; schema?: unknown; permissionHash?: string; schemaHash?: string; policyVersion?: string };
export type DryRunIssue = { code: string; message: string; nodeId?: string; guidance: string };
export type DryRunResources = {
  agents: Map<string, AgentResource>;
  tools: Map<string, ToolResource>;
  mcpTools: Map<string, ToolResource>;
  dependencies?: WorkflowDependencySnapshot;
  dependencyIssues?: DryRunIssue[];
};
export type DryRunResult = {
  valid: boolean; executionPath: string[]; bindings: ReturnType<typeof resolveBinding>[]; errors: DryRunIssue[]; warnings: DryRunIssue[];
  externalActions: Array<{ nodeId: string; adapter: 'api' | 'mcp' | 'legacy_tool' | 'browser'; resourceId: string; risk: string; permissions: string[]; requiresConfirmation: boolean }>;
  requiredApprovals: Array<{ nodeId: string; reason: string; prompt?: string }>;
  missingResources: Array<{ nodeId: string; resourceId: string; kind: string }>;
  pinnedAgents: Array<{ nodeId: string; agentId: string; versionId: string; version: number }>;
  estimatedBudgets: { agentCalls: number; maxLoopIterations: number; externalActions: number; maxNodeExecutions: number };
  manifest: { definitionHash: string; inputHash: string; dependenciesHash: string; previewHash: string };
};

const issue = (code: string, message: string, nodeId?: string, guidance = 'Correct the workflow definition and run the preview again.'): DryRunIssue => ({ code, message, nodeId, guidance });
const externalTypes = new Set(['action', 'api_action', 'mcp_action', 'browser']);
const unsafe = /(?:__proto__|prototype|constructor|\+|\(|\)|;|\[\s*['"])/;
function references(value: unknown, result: string[] = []): string[] {
  if (typeof value === 'string') for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*}}/g)) result.push(match[1].trim());
  else if (Array.isArray(value)) value.forEach((item) => references(item, result));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => references(item, result));
  return result;
}

function graph(definition: WorkflowDefinition, input: Record<string, unknown>, errors: DryRunIssue[]) {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const trigger = definition.nodes.find((node) => node.type === 'trigger');
  const reachable = new Set<string>(); const path: string[] = [];
  if (trigger) {
    const queue = [trigger.id]; reachable.add(trigger.id);
    while (queue.length) { const id = queue.shift()!; path.push(id); const node = nodes.get(id); for (const edge of definition.edges) {
      if (edge.source !== id || reachable.has(edge.target)) continue;
      if (node?.type === 'condition') {
        const selected = evaluateCondition(node.config, { ...input, input });
        if (edge.condition !== String(selected)) continue;
      }
      reachable.add(edge.target); queue.push(edge.target);
    } }
  } else errors.push(issue('WORKFLOW_TRIGGER_MISSING', 'Workflow has no trigger node', undefined, 'Add one manual trigger node.'));
  const structural = new Set<string>(); if (trigger) { const pending = [trigger.id]; structural.add(trigger.id); while (pending.length) { const id = pending.pop()!; for (const edge of definition.edges.filter((candidate) => candidate.source === id)) if (!structural.has(edge.target)) { structural.add(edge.target); pending.push(edge.target); } } }
  for (const node of definition.nodes) if (!structural.has(node.id)) errors.push(issue('NODE_UNREACHABLE', `Node ${node.id} is not reachable from the trigger`, node.id, 'Connect it to the workflow path or remove it.'));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const cycle = (id: string): boolean => { if (visiting.has(id)) return true; if (visited.has(id)) return false; visiting.add(id); const found = definition.edges.filter((edge) => edge.source === id && edge.condition !== 'continue').some((edge) => cycle(edge.target)); visiting.delete(id); visited.add(id); return found; };
  if ([...nodes.keys()].some(cycle)) errors.push(issue('WORKFLOW_CYCLE', 'Workflow has a cycle outside a bounded loop', undefined, 'Route repeat work through a Loop node and a continue edge.'));
  return { nodes, path };
}

function loopBodyRegions(definition: WorkflowDefinition) {
  const regions = new Map<string, Set<string>>();
  for (const loop of definition.nodes.filter((node) => node.type === 'loop')) {
    const body = definition.edges.find((edge) => edge.source === loop.id && edge.condition === 'body');
    const continueSources = definition.edges
      .filter((edge) => edge.target === loop.id && edge.condition === 'continue')
      .map((edge) => edge.source);
    if (!body || !continueSources.length) {
      regions.set(loop.id, new Set());
      continue;
    }
    const forward = new Set<string>();
    const pendingForward = [body.target];
    while (pendingForward.length) {
      const id = pendingForward.pop()!;
      if (id === loop.id || forward.has(id)) continue;
      forward.add(id);
      for (const edge of definition.edges) {
        if (edge.source === id && !(edge.target === loop.id && edge.condition === 'continue')) pendingForward.push(edge.target);
      }
    }
    const backward = new Set<string>();
    const pendingBackward = [...continueSources];
    while (pendingBackward.length) {
      const id = pendingBackward.pop()!;
      if (id === loop.id || backward.has(id)) continue;
      backward.add(id);
      for (const edge of definition.edges) if (edge.target === id) pendingBackward.push(edge.source);
    }
    regions.set(loop.id, new Set([...forward].filter((id) => backward.has(id))));
  }
  return regions;
}

export async function dryRunWorkflow(input: { workspaceId: string; definition: WorkflowDefinition; input: Record<string, unknown>; resources: DryRunResources; adapterSpy?: (...args: never[]) => unknown }): Promise<DryRunResult> {
  // Intentionally no adapter, queue, artifact, worker, manifest persistence, audit, or write call.
  const errors: DryRunIssue[] = []; const warnings: DryRunIssue[] = [];
  errors.push(...(input.resources.dependencyIssues ?? []));
  const { nodes, path } = graph(input.definition, input.input, errors);
  for (const message of workflowDefinitionErrors(input.definition)) errors.push(issue('DEFINITION_INVALID', message));
  const bindings: ReturnType<typeof resolveBinding>[] = [];
  for (const edge of input.definition.edges as ContractBinding[]) {
    const result = resolveBinding(edge, nodes); bindings.push(result);
    if (result.issue) errors.push(result.issue);
    if (result.binding?.legacy) warnings.push(issue('LEGACY_PORT_DEFAULT', `${edge.source} → ${edge.target} uses legacy output-to-input ports`, edge.target, 'Save the workflow with explicit ports to remove this compatibility warning.'));
    if (result.binding && !contractCompatible(result.binding)) errors.push(issue('NODE_SCHEMA_INCOMPATIBLE', `Binding ${edge.source}.${result.binding.sourcePort} is incompatible with ${edge.target}.${result.binding.targetPort}`, edge.target, 'Use matching schema types or add an explicit registered transformation.'));
  }
  for (const node of input.definition.nodes) {
    const required = workflowNodeDefinition(node.type)?.inputPorts.filter((port) => port.required) ?? [];
    for (const port of required) if (!bindings.some((result) => result.binding?.target === node.id && result.binding.targetPort === port.id)) errors.push(issue('REQUIRED_PORT_UNBOUND', `Required port ${node.id}.${port.id} has no binding`, node.id, 'Connect a compatible value to every required input port.'));
  }
  const externalActions: DryRunResult['externalActions'] = []; const requiredApprovals: DryRunResult['requiredApprovals'] = []; const missingResources: DryRunResult['missingResources'] = []; const pinnedAgents: DryRunResult['pinnedAgents'] = [];
  let maxLoopIterations = 0;
  for (const node of input.definition.nodes) {
    const config = node.config;
    for (const reference of references(config)) {
      if (unsafe.test(reference)) errors.push(issue('UNSAFE_REFERENCE', `Node ${node.id} has unsafe reference ${reference}`, node.id, 'Use only safe input, variables, or upstream nodes paths.'));
      else if (reference.startsWith('input.') && valueAtPath({ input: input.input }, reference) === undefined) warnings.push(issue('REFERENCE_UNRESOLVED', `Fixture input does not provide ${reference}`, node.id, 'Provide a fixture value or make the binding optional.'));
    }
    if (node.type === 'trigger' && Array.isArray(config.inputSchema)) for (const field of config.inputSchema as Array<Record<string, unknown>>) if (field.required && typeof field.key === 'string' && input.input[field.key] === undefined) errors.push(issue('INPUT_REQUIRED', `Required fixture input ${field.key} is missing`, node.id, 'Supply the required trigger input.'));
    if (node.type === 'loop') { const bound = config.maxIterations; if (typeof bound !== 'number' || !Number.isInteger(bound) || bound < 1 || bound > 100) errors.push(issue('LOOP_BOUND_INVALID', `Loop ${node.id} must have a maximum between 1 and 100`, node.id, 'Set a finite integer loop limit from 1 to 100.')); else if (path.includes(node.id)) maxLoopIterations += bound; }
    if (node.type === 'agent' || node.type === 'mcp_action') { const id = typeof config.agentId === 'string' ? config.agentId : ''; const agent = input.resources.agents.get(id); if (!agent) { missingResources.push({ nodeId: node.id, resourceId: id, kind: 'agent' }); errors.push(issue('RESOURCE_NOT_FOUND', `Agent ${id || '(missing)'} is unavailable in this workspace`, node.id, 'Choose an active workspace agent.')); } else if (!agent.versionId || !agent.version) errors.push(issue('AGENT_VERSION_REQUIRED', `Agent ${id} has no pinned published version`, node.id, 'Publish an agent version before using it in a workflow.')); else pinnedAgents.push({ nodeId: node.id, agentId: id, versionId: agent.versionId, version: agent.version }); }
    if (externalTypes.has(node.type)) {
      const resourceId = typeof config.toolId === 'string' ? config.toolId : typeof config.mcpToolId === 'string' ? config.mcpToolId : '';
      const adapter = node.type === 'mcp_action' ? 'mcp' : node.type === 'action' ? 'legacy_tool' : node.type === 'browser' ? 'browser' : 'api';
      const resource = node.type === 'mcp_action' ? input.resources.mcpTools.get(resourceId) : input.resources.tools.get(resourceId);
      if (!resource) { missingResources.push({ nodeId: node.id, resourceId, kind: adapter }); errors.push(issue('RESOURCE_NOT_FOUND', `${adapter} resource ${resourceId || '(missing)'} is unavailable in this workspace`, node.id, 'Choose an enabled resource owned by this workspace.')); }
      else {
        if (node.type === 'mcp_action' && resource.agentIds && !resource.agentIds.includes(String(config.agentId))) errors.push(issue('MCP_ACCESS_DENIED', `MCP tool ${resourceId} is not allowlisted for agent ${String(config.agentId)}`, node.id, 'Enable this tool for the selected agent or choose an allowed action.'));
        const requiresConfirmation = node.type === 'action' ? resource.requiresApproval !== false : resource.risk !== 'read'; externalActions.push({ nodeId: node.id, adapter, resourceId, risk: resource.risk, permissions: [...resource.permissions].sort(), requiresConfirmation }); if (requiresConfirmation) requiredApprovals.push({ nodeId: node.id, reason: 'External write requires confirmation' });
      }
    }
    if (node.type === 'approval') requiredApprovals.push({ nodeId: node.id, reason: 'Human approval node', prompt: typeof config.prompt === 'string' ? config.prompt : undefined });
    if (!workflowNodeDefinition(node.type)?.available) errors.push(issue('NODE_UNAVAILABLE', `Node ${node.id} has no available runtime adapter`, node.id, 'Replace the unavailable node before execution.'));
  }
  const bodyRegions = loopBodyRegions(input.definition);
  const multiplierFor = (nodeId: string) => input.definition.nodes.reduce((total, node) => {
    const bound = node.config.maxIterations;
    return node.type === 'loop' && path.includes(node.id) && bodyRegions.get(node.id)?.has(nodeId)
      && typeof bound === 'number' && Number.isInteger(bound) && bound >= 1 && bound <= 100
      ? total * bound
      : total;
  }, 1);
  const estimatedBudgets = { agentCalls: input.definition.nodes.filter((node) => node.type === 'agent' && path.includes(node.id)).reduce((total, node) => total + multiplierFor(node.id), 0), maxLoopIterations, externalActions: externalActions.filter((action) => path.includes(action.nodeId)).reduce((total, action) => total + multiplierFor(action.nodeId), 0), maxNodeExecutions: path.reduce((total, nodeId) => total + multiplierFor(nodeId), 0) };
  const definitionHash = canonicalJsonHash(input.definition); const inputHash = canonicalJsonHash(input.input);
  const sorted = <T extends { id: string }>(items: Iterable<T>) => [...items].sort((left, right) => left.id.localeCompare(right.id));
  const dependencies = input.resources.dependencies ?? {
    agents: Object.fromEntries(sorted(input.resources.agents.values()).map((agent) => [agent.id, agent])),
    prompts: {},
    models: {},
    apiTools: Object.fromEntries(sorted(input.resources.tools.values()).map((tool) => [tool.id, {
      toolId: tool.id,
      schemaHash: tool.schemaHash ?? canonicalJsonHash(tool.schema ?? {}),
      permissionHash: tool.permissionHash ?? canonicalJsonHash({ kind: tool.kind, permissions: [...tool.permissions].sort() }),
    }])),
    mcpActions: Object.fromEntries(sorted(input.resources.mcpTools.values()).map((tool) => [tool.id, {
      connectionId: tool.connectionId ?? '',
      toolId: tool.id,
      schemaHash: tool.schemaHash ?? canonicalJsonHash(tool.schema ?? {}),
      permissionHash: tool.permissionHash ?? canonicalJsonHash([...tool.permissions].sort()),
    }])),
    policy: { version: '1' },
    adapters: Object.fromEntries(input.definition.nodes.map((node) => [node.id, `${workflowNodeDefinition(node.type)?.adapter ?? 'unavailable'}:1`])),
    outputContracts: {},
    artifactTemplates: {},
    runtime: { version: process.env.RUNTIME_VERSION ?? '0.1.0', stateSchemaVersion: 1 as const },
  };
  const dependenciesHash = canonicalJsonHash(dependencies);
  const manifest = { definitionHash, inputHash, dependenciesHash, previewHash: canonicalJsonHash({ definitionHash, inputHash, dependenciesHash, path, bindings, externalActions, requiredApprovals, pinnedAgents, estimatedBudgets }) };
  return { valid: errors.length === 0, executionPath: path, bindings, errors, warnings, externalActions, requiredApprovals, missingResources, pinnedAgents, estimatedBudgets, manifest };
}
