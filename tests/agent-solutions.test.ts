import { describe, expect, it } from 'vitest';
import { starterSolutions } from '../src/solutions/catalog.js';
import {
  compatibleCompletionText,
  compilerValidationFeedback,
  containsLikelySecret,
  normalizeCompilerEdgeCondition,
  parseCompilerOutput,
} from '../src/solutions/compiler.js';
import { materializeWorkflowDefinition } from '../src/solutions/installer.js';
import { parseAgentSolution, solutionValidationErrors } from '../src/solutions/schema.js';

describe('AgentSolution contract', () => {
  it('validates all production starter solutions', () => {
    expect(starterSolutions).toHaveLength(14);
    expect(new Set(starterSolutions.map((solution) => solution.slug)).size).toBe(14);
    for (const solution of starterSolutions) {
      expect(() => parseAgentSolution(solution)).not.toThrow();
      expect(solution.agents.length).toBeGreaterThanOrEqual(1);
      expect(solution.workflow.nodes.filter((node) => node.type === 'agent')).toHaveLength(solution.agents.length);
      expect(solution.requiredPermissions.every((permission) => permission.level === 'read')).toBe(true);
    }
  });

  it('provides four least-privilege, single-agent tool-ready templates', () => {
    const templates = starterSolutions.filter((solution) => solution.category === 'Tool-ready Agents');
    expect(templates).toHaveLength(4);
    for (const solution of templates) {
      expect(solution.agents).toHaveLength(1);
      expect(solution.estimatedModelCalls).toBe(1);
      expect(solution.agents[0].capabilities.webBrowser).toBe(true);
      expect(solution.agents[0].toolRequirements.length).toBeGreaterThan(0);
      expect(solution.agents[0].toolRequirements.every((requirement) => requirement.required)).toBe(true);
      expect(solution.recommendedIntegrations.every((integration) => integration.permission === 'read')).toBe(true);
    }
    expect(templates.find((solution) => solution.slug === 'job-opportunity-researcher')?.agents[0].toolRequirements)
      .toContainEqual(expect.objectContaining({ permissions: ['jobs.read'] }));
    expect(templates.find((solution) => solution.slug === 'community-insights-researcher')?.agents[0].toolRequirements)
      .toContainEqual(expect.objectContaining({ permissions: ['reddit.read'] }));
  });

  it('declares web research as an optional, read-only dependency for internet research starters', () => {
    for (const slug of ['deep-research-report', 'competitor-intelligence', 'content-campaign-studio']) {
      const solution = starterSolutions.find((item) => item.slug === slug);
      expect(solution?.recommendedIntegrations).toContainEqual(expect.objectContaining({
        id: 'web-search',
        name: 'Web Research',
        permission: 'read',
        required: false,
      }));
      expect(solution?.requiredPermissions).toContainEqual(expect.objectContaining({
        resource: 'Web Research',
        level: 'read',
        requiresConfirmation: false,
      }));
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

  it('extracts a complete proposal after provider reasoning and unwraps common response envelopes', () => {
    const generated = structuredClone(starterSolutions[2]) as unknown as Record<string, unknown>;
    generated.name = 'Wrapped Research System';
    const response = `<think>{"draft":true}</think>\n${JSON.stringify({ solution: generated })}`;
    const solution = parseCompilerOutput(response, 'multi');
    expect(solution).toMatchObject({ name: 'Wrapped Research System', slug: 'wrapped-research-system', source: 'generated' });
    expect(solution.agents).toHaveLength(4);
  });

  it('unwraps proposal envelopes and normalizes boolean branch labels', () => {
    const generated = structuredClone(starterSolutions[2]) as unknown as Record<string, unknown>;
    generated.name = 'Proposal Envelope System';
    expect(parseCompilerOutput(JSON.stringify({ proposal: generated }), 'multi')).toMatchObject({
      name: 'Proposal Envelope System',
      source: 'generated',
    });
    expect(normalizeCompilerEdgeCondition(true)).toBe('true');
    expect(normalizeCompilerEdgeCondition(false)).toBe('false');
    expect(normalizeCompilerEdgeCondition('continue')).toBe('continue');
  });

  it('normalizes invalid generated usage estimates and model sampling limits', () => {
    const generated = structuredClone(starterSolutions[2]) as unknown as Record<string, any>;
    generated.estimatedModelCalls = 0;
    generated.estimatedTokenRange = { minimum: 0, maximum: -1 };
    generated.agents[0].modelConfig = { temperature: -1, maxTokens: 0, topP: 2 };

    const solution = parseCompilerOutput(JSON.stringify(generated), 'multi');
    expect(solution.estimatedModelCalls).toBeGreaterThanOrEqual(1);
    expect(solution.estimatedTokenRange).toEqual({ minimum: 1_000, maximum: 8_000 });
    expect(solution.agents[0].modelConfig).toEqual({ temperature: 0.2, maxTokens: 4096, topP: 1 });
  });

  it('uses a compatible provider reasoning channel when final content is empty', () => {
    const generated = structuredClone(starterSolutions[2]);
    generated.name = 'Reasoning Channel Research System';
    const text = compatibleCompletionText({
      content: '',
      reasoning_content: `Planning complete.\n${JSON.stringify(generated)}`,
    });

    expect(parseCompilerOutput(text, 'multi')).toMatchObject({
      name: 'Reasoning Channel Research System',
      source: 'generated',
    });
  });

  it('returns sanitized schema feedback for the compiler repair pass', () => {
    const feedback = compilerValidationFeedback({
      issues: [
        { path: ['workflow', 'nodes', 2, 'config'], message: 'Required' },
        { path: ['agents', 0, 'name'], message: 'String must contain at least 2 character(s)' },
      ],
    });

    expect(feedback).toContain('workflow.nodes.2.config: Required');
    expect(feedback).toContain('agents.0.name: String must contain at least 2 character(s)');
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

  it('accepts and materializes a bounded generated quality loop', () => {
    const solution = structuredClone(starterSolutions[0]);
    const agentNodes = solution.workflow.nodes.filter((node) => node.type === 'agent');
    const first = agentNodes[0].id;
    const last = agentNodes.at(-1)!.id;
    solution.workflow.nodes.splice(1, 0, {
      id: 'quality_loop',
      type: 'loop' as never,
      config: {
        mode: 'while',
        condition: { path: `nodes.${last}.data.passed`, operator: 'not_equals', value: true },
        maxIterations: 4,
        onLimit: 'exit',
      },
    });
    solution.workflow.nodes.find((node) => node.id === last)!.config.outputContract = 'grader';
    solution.workflow.edges = [
      { source: 'trigger', target: 'quality_loop' },
      { source: 'quality_loop', target: first, condition: 'body' } as never,
      ...agentNodes.slice(0, -1).map((node, index) => ({ source: node.id, target: agentNodes[index + 1].id })),
      { source: last, target: 'quality_loop', condition: 'continue' } as never,
      { source: 'quality_loop', target: 'output', condition: 'done' } as never,
    ];
    expect(() => parseAgentSolution(solution)).not.toThrow();
    const ids = new Map(solution.agents.map((agent, index) => [agent.key, `00000000-0000-4000-8000-00000000000${index}`]));
    expect(materializeWorkflowDefinition(solution, ids).edges).toContainEqual({
      source: last,
      target: 'quality_loop',
      condition: 'continue',
    });
  });
});
