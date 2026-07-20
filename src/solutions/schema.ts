import { z } from 'zod';

const slug = z.string().min(2).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const key = z.string().min(1).max(80).regex(/^[a-z][a-z0-9_-]*$/);
const modelConfig = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(128).max(128_000).default(4096),
  topP: z.number().min(0).max(1).default(1),
});
const capabilities = z.object({
  webBrowser: z.boolean().default(false),
  codeInterpreter: z.boolean().default(false),
  knowledgeBase: z.boolean().default(true),
});

export const solutionAgentSchema = z.object({
  key,
  name: z.string().min(2).max(120),
  role: z.string().min(2).max(240),
  goal: z.string().min(2).max(5_000),
  instructions: z.string().min(10).max(20_000),
  personality: z.string().max(80).nullable().default('Analytical, careful, concise'),
  model: z.string().min(2).max(160).optional(),
  modelConfig: modelConfig.default({ temperature: 0.2, maxTokens: 4096, topP: 1 }),
  capabilities: capabilities.default({ webBrowser: false, codeInterpreter: false, knowledgeBase: true }),
});

export const solutionWorkflowNodeSchema = z.object({
  id: key,
  type: z.enum(['trigger', 'agent', 'approval', 'output']),
  agentKey: key.optional(),
  config: z.record(z.unknown()).default({}),
});

export const agentSolutionSchema = z.object({
  slug,
  version: z.number().int().min(1),
  source: z.enum(['starter', 'generated', 'imported']),
  name: z.string().min(2).max(120),
  description: z.string().min(10).max(2_000),
  category: z.string().min(2).max(80),
  difficulty: z.enum(['beginner', 'intermediate', 'advanced']),
  estimatedModelCalls: z.number().int().min(1).max(30),
  estimatedTokenRange: z.object({
    minimum: z.number().int().min(128).max(2_000_000),
    maximum: z.number().int().min(128).max(2_000_000),
  }).refine((range) => range.maximum >= range.minimum, 'Maximum token estimate must be at least the minimum'),
  requiredInputs: z.array(z.object({
    key,
    label: z.string().min(1).max(120),
    description: z.string().max(500).default(''),
    required: z.boolean().default(true),
    example: z.string().max(500).optional(),
  })).min(1).max(30),
  agents: z.array(solutionAgentSchema).min(1).max(8),
  team: z.object({
    name: z.string().min(2).max(120),
    description: z.string().max(2_000).default(''),
    managerAgentKey: key.optional(),
  }),
  workflow: z.object({
    name: z.string().min(2).max(120),
    description: z.string().max(2_000).default(''),
    nodes: z.array(solutionWorkflowNodeSchema).min(3).max(40),
    edges: z.array(z.object({ source: key, target: key })).min(2).max(80),
  }),
  expectedMarkdownOutput: z.string().min(10).max(10_000),
  recommendedIntegrations: z.array(z.object({
    id: slug,
    name: z.string().min(2).max(120),
    purpose: z.string().min(2).max(500),
    required: z.boolean().default(false),
    permission: z.enum(['read', 'read_write']).default('read'),
    toolHints: z.array(z.string().min(1).max(160)).max(30).default([]),
  })).max(30).default([]),
  requiredPermissions: z.array(z.object({
    resource: z.string().min(2).max(160),
    level: z.enum(['read', 'read_write', 'destructive']),
    reason: z.string().min(2).max(500),
    requiresConfirmation: z.boolean().default(false),
  })).max(30).default([]),
  humanApprovalRequirements: z.array(z.string().min(2).max(500)).max(30).default([]),
  missingQuestions: z.array(z.string().min(2).max(500)).max(30).default([]),
  warnings: z.array(z.string().min(2).max(1_000)).max(30).default([]),
});

export type AgentSolution = z.infer<typeof agentSolutionSchema>;
export type SolutionWorkflowNode = z.infer<typeof solutionWorkflowNodeSchema>;

export function solutionValidationErrors(solution: AgentSolution) {
  const errors: string[] = [];
  const agentKeys = solution.agents.map((agent) => agent.key);
  const knownAgents = new Set(agentKeys);
  if (knownAgents.size !== agentKeys.length) errors.push('Agent keys must be unique');
  if (solution.team.managerAgentKey && !knownAgents.has(solution.team.managerAgentKey)) {
    errors.push('The team manager must reference an agent in this solution');
  }

  const nodeIds = solution.workflow.nodes.map((node) => node.id);
  const knownNodes = new Set(nodeIds);
  if (knownNodes.size !== nodeIds.length) errors.push('Workflow node IDs must be unique');
  if (solution.workflow.nodes.filter((node) => node.type === 'trigger').length !== 1) {
    errors.push('A solution workflow requires exactly one trigger node');
  }
  if (solution.workflow.nodes.filter((node) => node.type === 'output').length !== 1) {
    errors.push('A solution workflow requires exactly one output node');
  }
  for (const node of solution.workflow.nodes) {
    if (node.type === 'agent' && (!node.agentKey || !knownAgents.has(node.agentKey))) {
      errors.push(`Agent node ${node.id} must reference a solution agent`);
    }
    if (node.type !== 'agent' && node.agentKey) errors.push(`Only agent nodes may reference agentKey (${node.id})`);
  }
  const referencedAgentKeys = solution.workflow.nodes
    .filter((node) => node.type === 'agent' && node.agentKey)
    .map((node) => node.agentKey!);
  if (
    referencedAgentKeys.length !== solution.agents.length
    || new Set(referencedAgentKeys).size !== solution.agents.length
    || solution.agents.some((agent) => !referencedAgentKeys.includes(agent.key))
  ) {
    errors.push('Every solution agent must appear exactly once in the workflow');
  }
  const outputNode = solution.workflow.nodes.find((node) => node.type === 'output');
  if (outputNode) {
    const fromNodeId = outputNode.config.fromNodeId;
    const referencedNode = typeof fromNodeId === 'string'
      ? solution.workflow.nodes.find((node) => node.id === fromNodeId)
      : undefined;
    if (!referencedNode || referencedNode.type !== 'agent') {
      errors.push('The output node must reference a valid agent node in config.fromNodeId');
    }
  }
  if (solution.workflow.edges.some((edge) => !knownNodes.has(edge.source) || !knownNodes.has(edge.target))) {
    errors.push('Every workflow edge must reference existing nodes');
  }

  const outgoing = new Map(nodeIds.map((id) => [id, solution.workflow.edges.filter((edge) => edge.source === id)]));
  const trigger = solution.workflow.nodes.find((node) => node.type === 'trigger');
  if (trigger && knownNodes.size === nodeIds.length) {
    const reachable = new Set([trigger.id]);
    const pending = [trigger.id];
    while (pending.length) {
      const id = pending.pop()!;
      for (const edge of outgoing.get(id) ?? []) {
        if (!reachable.has(edge.target)) {
          reachable.add(edge.target);
          pending.push(edge.target);
        }
      }
    }
    if (reachable.size !== knownNodes.size) errors.push('Every workflow node must be reachable from the trigger');
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cyclic = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const found = (outgoing.get(id) ?? []).some((edge) => cyclic(edge.target));
      visiting.delete(id);
      visited.add(id);
      return found;
    };
    if (nodeIds.some(cyclic)) errors.push('Solution workflows cannot contain cycles');
  }

  const requiresApproval = solution.requiredPermissions.some((permission) =>
    permission.level !== 'read' || permission.requiresConfirmation,
  ) || solution.recommendedIntegrations.some((integration) => integration.permission === 'read_write');
  if (requiresApproval && !solution.humanApprovalRequirements.length) {
    errors.push('Write or destructive permissions require a human approval requirement');
  }
  if (requiresApproval && !solution.workflow.nodes.some((node) => node.type === 'approval')) {
    errors.push('Write or destructive permissions require an approval workflow node');
  }
  return [...new Set(errors)];
}

export function parseAgentSolution(value: unknown) {
  const solution = agentSolutionSchema.parse(value);
  const errors = solutionValidationErrors(solution);
  if (errors.length) throw Object.assign(new Error('INVALID_AGENT_SOLUTION'), { statusCode: 400, details: errors });
  return solution;
}
