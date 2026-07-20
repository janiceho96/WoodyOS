import { describe, expect, it } from 'vitest';
import { starterSolutions } from '../src/solutions/catalog.js';
import { containsLikelySecret, parseCompilerOutput } from '../src/solutions/compiler.js';
import { materializeWorkflowDefinition } from '../src/solutions/installer.js';
import { parseAgentSolution, solutionValidationErrors } from '../src/solutions/schema.js';

describe('AgentSolution contract', () => {
  it('validates all ten production starter solutions', () => {
    expect(starterSolutions).toHaveLength(10);
    expect(new Set(starterSolutions.map((solution) => solution.slug)).size).toBe(10);
    for (const solution of starterSolutions) {
      expect(() => parseAgentSolution(solution)).not.toThrow();
      expect(solution.agents).toHaveLength(4);
      expect(solution.workflow.nodes.filter((node) => node.type === 'agent')).toHaveLength(4);
      expect(solution.requiredPermissions.every((permission) => permission.level === 'read')).toBe(true);
    }
  });

  it('rejects duplicate agents, invalid output wiring, workflow cycles, and writes without approval', () => {
    const source = structuredClone(starterSolutions[0]);
    source.agents[1].key = source.agents[0].key;
    source.requiredPermissions = [{ resource: 'Email', level: 'read_write', reason: 'Send a response', requiresConfirmation: true }];
    source.humanApprovalRequirements = [];
    source.workflow.nodes.find((node) => node.type === 'output')!.config.fromNodeId = 'trigger';
    source.workflow.edges.push({ source: 'output', target: 'trigger' });
    expect(solutionValidationErrors(source)).toEqual(expect.arrayContaining([
      'Agent keys must be unique',
      'The output node must reference a valid agent node in config.fromNodeId',
      'Solution workflows cannot contain cycles',
      'Write or destructive permissions require a human approval requirement',
      'Write or destructive permissions require an approval workflow node',
    ]));

    const duplicateWorkflowAgent = structuredClone(starterSolutions[0]);
    const agentNodes = duplicateWorkflowAgent.workflow.nodes.filter((node) => node.type === 'agent');
    agentNodes[1].agentKey = agentNodes[0].agentKey;
    expect(solutionValidationErrors(duplicateWorkflowAgent)).toContain(
      'Every solution agent must appear exactly once in the workflow',
    );
  });

  it('parses generated compiler JSON through the same schema', () => {
    const generated = structuredClone(starterSolutions[2]) as unknown as Record<string, unknown>;
    generated.name = 'Generated Research System';
    generated.source = 'starter';
    const solution = parseCompilerOutput(`\`\`\`json\n${JSON.stringify(generated)}\n\`\`\``, 'multi');
    expect(solution).toMatchObject({
      slug: 'generated-research-system',
      source: 'generated',
      version: 1,
    });
    expect(solution.agents).toHaveLength(4);
    expect(solution.agents.every((agent) => agent.model === undefined)).toBe(true);
  });

  it('enforces requested single-versus-multi compiler mode', () => {
    const generated = { ...structuredClone(starterSolutions[0]), name: 'Wrong Mode' };
    expect(() => parseCompilerOutput(JSON.stringify(generated), 'single')).toThrow('PROMPT_COMPILER_MODE_MISMATCH');
  });

  it('detects common credential patterns before compilation', () => {
    expect(containsLikelySecret('Build an email agent with no credentials included.')).toBe(false);
    expect(containsLikelySecret('api_key=abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
    expect(containsLikelySecret('-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('maps temporary agent keys to real IDs in workflow nodes', () => {
    const solution = starterSolutions[0];
    const ids = new Map(solution.agents.map((agent, index) => [agent.key, `00000000-0000-4000-8000-00000000000${index}`]));
    const definition = materializeWorkflowDefinition(solution, ids);
    const agentNodes = definition.nodes.filter((node) => node.type === 'agent');
    expect(agentNodes).toHaveLength(solution.agents.length);
    for (const node of agentNodes) {
      expect(node.config.agentId).toMatch(/^00000000-/);
      expect(node).not.toHaveProperty('agentKey');
    }
  });
});
