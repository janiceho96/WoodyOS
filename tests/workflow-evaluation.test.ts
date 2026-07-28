import { describe, expect, it, vi } from 'vitest';
import { dryRunWorkflow } from '../src/workflows/dry-run.js';
import { workflowDefinitionSchema } from '../src/workflows/definition.js';
import { evaluationFixtureKey, runFixtureEvaluation, validateRegressionAssertions } from '../src/workflows/evaluation.js';
import type { ExecutionManifest } from '../src/runtime/manifest.js';

const workspaceId = '00000000-0000-4000-8000-000000000010';
const agentId = '00000000-0000-4000-8000-000000000011';
const toolId = '00000000-0000-4000-8000-000000000012';

const resources = {
  agents: new Map([[agentId, { id: agentId, versionId: '00000000-0000-4000-8000-000000000013', version: 3 }]]),
  tools: new Map([[toolId, { id: toolId, kind: 'api', risk: 'write', permissions: ['contacts:write'] }]]),
  mcpTools: new Map(),
};

const definition = {
  nodes: [
    { id: 'start', type: 'trigger' as const, config: { inputSchema: [{ key: 'topic', label: 'Topic', type: 'text', required: true }] } },
    { id: 'writer', type: 'agent' as const, config: { agentId, inputMapping: { topic: '{{ input.topic }}' } } },
    { id: 'send', type: 'api_action' as const, config: { toolId, input: { body: '{{ nodes.writer.output }}' } } },
    { id: 'finish', type: 'output' as const, config: { fromNodeId: 'send' } },
  ],
  edges: [{ source: 'start', target: 'writer' }, { source: 'writer', target: 'send' }, { source: 'send', target: 'finish' }],
};
const evaluationManifest: ExecutionManifest = {
  manifestVersion: 1, createdAt: '2026-07-28T00:00:00.000Z', compatibility: 'exact',
  workflow: { id: workspaceId, versionId: '00000000-0000-4000-8000-000000000015', version: 1, definitionHash: 'a'.repeat(64) },
  agents: {}, prompts: {}, models: {}, apiTools: { [toolId]: { toolId, schemaHash: 'b'.repeat(64), permissionHash: 'c'.repeat(64) } }, mcpActions: {}, policy: { version: '1' }, adapters: {}, outputContracts: {}, artifactTemplates: {}, runtime: { version: '0.1.0', stateSchemaVersion: 1 },
};

describe('workflow dry run', () => {
  it('preserves explicit binding contracts when a definition is saved', () => {
    // Break caught: schema stripping port and JSON-schema metadata before dry-run can validate it.
    const parsed = workflowDefinitionSchema.parse({
      nodes: [{ id: 'start', type: 'trigger', config: {} }, { id: 'finish', type: 'output', config: {} }],
      edges: [{ source: 'start', target: 'finish', sourcePort: 'output', targetPort: 'input', sourceSchema: { type: 'object' }, targetSchema: { type: 'object' }, required: true, nullable: false }],
    });
    expect(parsed.edges[0]).toMatchObject({ sourcePort: 'output', targetPort: 'input', sourceSchema: { type: 'object' }, targetSchema: { type: 'object' }, required: true, nullable: false });
  });

  it('resolves topology, resources, approvals and hashes without invoking an adapter', async () => {
    // Break caught: routing preview through a runtime adapter or returning an unstable manifest.
    const adapterSpy = vi.fn();
    const result = await dryRunWorkflow({ workspaceId, definition, input: { topic: 'security' }, resources, adapterSpy });

    expect(adapterSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ valid: true, executionPath: ['start', 'writer', 'send', 'finish'] });
    expect(result.externalActions).toEqual([{ nodeId: 'send', adapter: 'api', resourceId: toolId, risk: 'write', permissions: ['contacts:write'], requiresConfirmation: true }]);
    expect(result.requiredApprovals).toEqual([expect.objectContaining({ nodeId: 'send', reason: 'External write requires confirmation' })]);
    expect(result.pinnedAgents).toEqual([{ nodeId: 'writer', agentId, versionId: '00000000-0000-4000-8000-000000000013', version: 3 }]);
    expect(result.manifest.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.previewHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects implicit scalar-to-object binding coercion before execution', async () => {
    // Break caught: accepting a connection that an adapter could reinterpret at execution time.
    const result = await dryRunWorkflow({
      workspaceId,
      input: { topic: 'security' },
      resources,
      definition: {
        ...definition,
        edges: [{ source: 'start', target: 'writer', sourcePort: 'output', targetPort: 'input', sourceSchema: { type: 'string' }, targetSchema: { type: 'object' } }, ...definition.edges.slice(1)],
      },
    });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'NODE_SCHEMA_INCOMPATIBLE', nodeId: 'writer' }));
    expect(result.valid).toBe(false);
  });

  it('reports malicious references, cycles, missing resources and unversioned agents without side effects', async () => {
    // Break caught: unsafe graph/reference/resource validation being deferred to execution.
    const result = await dryRunWorkflow({
      workspaceId,
      input: {},
      resources: { ...resources, agents: new Map([[agentId, { id: agentId, versionId: null, version: null }]]) },
      definition: {
        nodes: [
          { id: 'start', type: 'trigger', config: {} },
          { id: 'bad', type: 'agent', config: { agentId, inputMapping: { exploit: '{{ __proto__.polluted }}' } } },
          { id: 'loop', type: 'loop', config: { mode: 'forEach', collectionPath: 'input.items', maxIterations: 101 } },
          { id: 'gone', type: 'api_action', config: { toolId: '00000000-0000-4000-8000-000000000099', input: {} } },
          { id: 'finish', type: 'output', config: {} },
        ],
        edges: [{ source: 'start', target: 'bad' }, { source: 'bad', target: 'loop' }, { source: 'loop', target: 'gone', condition: 'body' }, { source: 'gone', target: 'bad' }, { source: 'loop', target: 'finish', condition: 'done' }],
      },
    });
    expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining(['UNSAFE_REFERENCE', 'LOOP_BOUND_INVALID', 'AGENT_VERSION_REQUIRED', 'RESOURCE_NOT_FOUND', 'WORKFLOW_CYCLE']));
  });

  it('is deterministic for equivalent object ordering', async () => {
    const first = await dryRunWorkflow({ workspaceId, definition, input: { topic: 'security', nested: { a: 1, b: 2 } }, resources });
    const second = await dryRunWorkflow({ workspaceId, definition, input: { nested: { b: 2, a: 1 }, topic: 'security' }, resources });
    expect(second.manifest.previewHash).toBe(first.manifest.previewHash);
  });

  it('rejects an MCP tool that is not allowlisted for the selected agent', async () => {
    // Break caught: treating a tenant-owned MCP tool as usable without agent-scoped access.
    const mcpToolId = '00000000-0000-4000-8000-000000000014';
    const result = await dryRunWorkflow({
      workspaceId,
      input: {},
      resources: { ...resources, mcpTools: new Map([[mcpToolId, { id: mcpToolId, kind: 'mcp', risk: 'read', permissions: [], agentIds: ['00000000-0000-4000-8000-000000000099'] }]]) },
      definition: {
        nodes: [{ id: 'start', type: 'trigger', config: {} }, { id: 'call', type: 'mcp_action', config: { agentId, mcpToolId, input: {} } }, { id: 'finish', type: 'output', config: {} }],
        edges: [{ source: 'start', target: 'call' }, { source: 'call', target: 'finish' }],
      },
    });
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'MCP_ACCESS_DENIED', nodeId: 'call' }));
  });

  it('pins MCP-only agents and includes mutable resource identities in the preview hash', async () => {
    const mcpToolId = '00000000-0000-4000-8000-000000000014';
    const base = { workspaceId, input: {}, definition: { nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'call', type: 'mcp_action' as const, config: { agentId, mcpToolId, input: {} } }, { id: 'finish', type: 'output' as const, config: {} }], edges: [{ source: 'start', target: 'call' }, { source: 'call', target: 'finish' }] } };
    const allowed = { ...resources, mcpTools: new Map([[mcpToolId, { id: mcpToolId, kind: 'mcp', risk: 'read', permissions: ['calendar:read'], agentIds: [agentId], schema: { type: 'object', properties: { title: { type: 'string' } } }, permissionHash: 'v1' }]]) };
    const first = await dryRunWorkflow({ ...base, resources: allowed });
    const changed = await dryRunWorkflow({ ...base, resources: { ...allowed, mcpTools: new Map([[mcpToolId, { ...allowed.mcpTools.get(mcpToolId)!, permissionHash: 'v2' }]]) } });
    expect(first.errors).not.toContainEqual(expect.objectContaining({ code: 'AGENT_VERSION_REQUIRED' }));
    expect(first.pinnedAgents).toEqual([expect.objectContaining({ nodeId: 'call', agentId })]);
    expect(changed.manifest.previewHash).not.toBe(first.manifest.previewHash);
  });

  it('hashes the authoritative production dependency snapshot into the preview', async () => {
    // Break caught: preview hashing ad-hoc resource rows while production freezes more identities.
    const dependencies = {
      agents: {},
      prompts: { '00000000-0000-4000-8000-000000000020': { versionId: '00000000-0000-4000-8000-000000000020', contentHash: 'a'.repeat(64) } },
      models: {},
      apiTools: {},
      mcpActions: {},
      policy: { version: '1' },
      adapters: { start: 'logic:1', finish: 'file:1' },
      outputContracts: { finish: 'b'.repeat(64) },
      artifactTemplates: {},
      runtime: { version: '0.1.0', stateSchemaVersion: 1 as const },
    };
    const simple = { nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'finish', type: 'output' as const, config: {} }], edges: [{ source: 'start', target: 'finish' }] };
    const first = await dryRunWorkflow({ workspaceId, definition: simple, input: {}, resources: { ...resources, dependencies } });
    const changed = await dryRunWorkflow({ workspaceId, definition: simple, input: {}, resources: {
      ...resources,
      dependencies: { ...dependencies, prompts: { ...dependencies.prompts, '00000000-0000-4000-8000-000000000020': { versionId: '00000000-0000-4000-8000-000000000020', contentHash: 'c'.repeat(64) } } },
    } });

    expect(first.manifest.dependenciesHash).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.manifest.dependenciesHash).not.toBe(first.manifest.dependenciesHash);
    expect(changed.manifest.previewHash).not.toBe(first.manifest.previewHash);
  });

  it('validates deep contracts, nullable required ports, registered transforms, and fixture-resolved paths', async () => {
    const result = await dryRunWorkflow({ workspaceId, resources, input: { take: true }, definition: {
      nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'check', type: 'condition' as const, config: { path: 'input.take', operator: 'equals', value: true } }, { id: 'yes', type: 'output' as const, config: {} }, { id: 'no', type: 'output' as const, config: {} }],
      edges: [
        { source: 'start', target: 'check' },
        { source: 'check', target: 'yes', condition: 'true', sourceSchema: { type: 'object', properties: { nested: { type: 'array', items: { type: 'string' } } } }, targetSchema: { type: 'object', properties: { nested: { type: 'array', items: { type: 'number' } } } }, required: true },
        { source: 'check', target: 'no', condition: 'false' },
      ],
    } });
    expect(result.executionPath).toEqual(['start', 'check', 'yes']);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'NODE_SCHEMA_INCOMPATIBLE', nodeId: 'yes' }));
  });

  it('derives nested nullability only from the nested schemas', async () => {
    // Break caught: leaking the edge's top-level nullable flag into recursive child checks.
    const result = await dryRunWorkflow({ workspaceId, resources, input: {}, definition: {
      nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'finish', type: 'output' as const, config: {} }],
      edges: [{
        source: 'start',
        target: 'finish',
        nullable: true,
        sourceSchema: { type: 'object', nullable: true, properties: { value: { type: 'string' } }, required: ['value'] },
        targetSchema: { type: 'object', nullable: true, properties: { value: { type: 'string' } }, required: ['value'] },
      }],
    } });

    expect(result.errors).not.toContainEqual(expect.objectContaining({ code: 'NODE_SCHEMA_INCOMPATIBLE' }));
    expect(result.valid).toBe(true);
  });

  it('multiplies only selected nodes inside each bounded loop body region', async () => {
    // Break caught: reverse ancestry multiplying loop done paths and later sequential loops.
    const result = await dryRunWorkflow({ workspaceId, resources, input: { outer: [1], inner: [1], later: [1] }, definition: {
      nodes: [
        { id: 'start', type: 'trigger' as const, config: {} },
        { id: 'outer', type: 'loop' as const, config: { mode: 'forEach', collectionPath: 'input.outer', maxIterations: 3, onLimit: 'fail' } },
        { id: 'before_inner', type: 'agent' as const, config: { agentId } },
        { id: 'inner', type: 'loop' as const, config: { mode: 'forEach', collectionPath: 'input.inner', maxIterations: 2, onLimit: 'fail' } },
        { id: 'nested_work', type: 'agent' as const, config: { agentId } },
        { id: 'outer_tail', type: 'agent' as const, config: { agentId } },
        { id: 'after_outer', type: 'agent' as const, config: { agentId } },
        { id: 'later', type: 'loop' as const, config: { mode: 'forEach', collectionPath: 'input.later', maxIterations: 5, onLimit: 'fail' } },
        { id: 'later_work', type: 'agent' as const, config: { agentId } },
        { id: 'finish', type: 'output' as const, config: {} },
      ],
      edges: [
        { source: 'start', target: 'outer' },
        { source: 'outer', target: 'before_inner', condition: 'body' },
        { source: 'outer', target: 'after_outer', condition: 'done' },
        { source: 'before_inner', target: 'inner' },
        { source: 'inner', target: 'nested_work', condition: 'body' },
        { source: 'inner', target: 'outer_tail', condition: 'done' },
        { source: 'nested_work', target: 'inner', condition: 'continue' },
        { source: 'outer_tail', target: 'outer', condition: 'continue' },
        { source: 'after_outer', target: 'later' },
        { source: 'later', target: 'later_work', condition: 'body' },
        { source: 'later', target: 'finish', condition: 'done' },
        { source: 'later_work', target: 'later', condition: 'continue' },
      ],
    } });

    expect(result.estimatedBudgets).toEqual({
      agentCalls: 18,
      maxLoopIterations: 10,
      externalActions: 0,
      maxNodeExecutions: 39,
    });
  });

  it('counts a loop controller for every iteration and its terminal evaluation', async () => {
    // Break caught: counting the controller once even though runtime evaluates it before each body pass and once to exit.
    const result = await dryRunWorkflow({ workspaceId, resources, input: { items: [1] }, definition: {
      nodes: [
        { id: 'start', type: 'trigger' as const, config: {} },
        { id: 'loop', type: 'loop' as const, config: { mode: 'forEach', collectionPath: 'input.items', maxIterations: 3, onLimit: 'fail' } },
        { id: 'work', type: 'agent' as const, config: { agentId } },
        { id: 'finish', type: 'output' as const, config: {} },
      ],
      edges: [
        { source: 'start', target: 'loop' },
        { source: 'loop', target: 'work', condition: 'body' },
        { source: 'loop', target: 'finish', condition: 'done' },
        { source: 'work', target: 'loop', condition: 'continue' },
      ],
    } });

    expect(result.estimatedBudgets).toMatchObject({
      agentCalls: 3,
      maxNodeExecutions: 9,
    });
  });
});

describe('workflow regression evaluation', () => {
  const evaluationDefinition = {
    nodes: [
      { id: 'start', type: 'trigger' as const, config: {} },
      { id: 'weather', type: 'api_action' as const, config: { toolId, operation: 'weather.lookup', input: { city: '{{ input.city }}' } } },
      { id: 'finish', type: 'output' as const, config: { fromNodeId: 'weather' } },
    ],
    edges: [{ source: 'start', target: 'weather' }, { source: 'weather', target: 'finish' }],
  };

  it('uses a stable fixture identity instead of a live external adapter', async () => {
    // Break caught: an external action reaching a production adapter during an evaluation.
    const result = await runFixtureEvaluation({
      definition: evaluationDefinition,
      input: { city: 'Kuala Lumpur' },
      manifest: evaluationManifest,
      fixtures: { [evaluationFixtureKey('api', toolId, 'invoke')]: { temperature: 31 } },
      assertions: [{ kind: 'output.json_path', path: 'temperature', operator: 'equals', expected: 31 }],
    });

    expect(result.status).toBe('passed');
    expect(result.output).toEqual({ temperature: 31 });
    expect(result.assertionResults).toEqual([{ index: 0, kind: 'output.json_path', passed: true, actual: 31, expected: 31 }]);
  });

  it('fails closed with a stable code when an external fixture is absent', async () => {
    // Break caught: treating a missing fixture as permission to call a live integration.
    await expect(runFixtureEvaluation({
      definition: evaluationDefinition,
      input: { city: 'Kuala Lumpur' },
      manifest: evaluationManifest,
      fixtures: {},
      assertions: [],
    })).rejects.toMatchObject({ code: 'EVALUATION_FIXTURE_REQUIRED' });
  });

  it('resolves the production template input before matching an external fixture', async () => {
    // Break caught: fixtures returning output even when their captured request no longer matches the workflow mapping.
    const result = await runFixtureEvaluation({
      definition: evaluationDefinition, input: { city: 'Kuala Lumpur' }, manifest: evaluationManifest,
      fixtures: { [evaluationFixtureKey('api', toolId, 'invoke')]: { expectedInput: { city: 'Kuala Lumpur' }, output: { temperature: 31 } } },
      assertions: [],
    });
    expect(result.output).toEqual({ temperature: 31 });
  });

  it('rejects external resources absent from the pinned manifest', async () => {
    // Break caught: evaluation fixture keys bypassing the version-pinned dependency snapshot.
    await expect(runFixtureEvaluation({
      definition: evaluationDefinition, input: {}, fixtures: { [evaluationFixtureKey('api', toolId, 'invoke')]: {} }, assertions: [],
      manifest: { ...evaluationManifest, apiTools: {} },
    })).rejects.toMatchObject({ code: 'EVALUATION_MANIFEST_RESOURCE_MISSING' });
  });

  it('requires a fixture for file-backed knowledge sources instead of reading workspace data', async () => {
    // Break caught: an evaluation quietly querying a live knowledge/file source.
    const result = await runFixtureEvaluation({
      definition: {
        nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'knowledge', type: 'knowledge_search' as const, config: { documentId: 'doc-1', operation: 'search' } }, { id: 'finish', type: 'output' as const, config: { fromNodeId: 'knowledge' } }],
        edges: [{ source: 'start', target: 'knowledge' }, { source: 'knowledge', target: 'finish' }],
      },
      input: {}, fixtures: { [evaluationFixtureKey('file', 'doc-1', 'read')]: { matches: [] } }, assertions: [],
      manifest: evaluationManifest,
    });
    expect(result.output).toEqual({ matches: [] });
  });

  it('executes bounded fixture-backed loop bodies without reaching a live adapter', async () => {
    // Break caught: a regression evaluator rejecting normal bounded control flow or losing its loop cursor.
    const result = await runFixtureEvaluation({
      definition: {
        nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'loop', type: 'loop' as const, config: { mode: 'forEach', collectionPath: 'input.items', maxIterations: 2 } }, { id: 'lookup', type: 'api_action' as const, config: { toolId, operation: 'lookup' } }, { id: 'finish', type: 'output' as const, config: { fromNodeId: 'lookup' } }],
        edges: [{ source: 'start', target: 'loop' }, { source: 'loop', target: 'lookup', condition: 'body' }, { source: 'lookup', target: 'loop', condition: 'continue' }, { source: 'loop', target: 'finish', condition: 'done' }],
      },
      input: { items: ['one', 'two'] }, fixtures: { [evaluationFixtureKey('api', toolId, 'invoke')]: { ok: true } }, assertions: [],
      manifest: evaluationManifest,
    });
    expect(result.status).toBe('passed');
    expect(result.output).toEqual({ ok: true });
  });

  it('rejects malformed assertions rather than treating them as passing', () => {
    // Break caught: a typo in a regression rule silently producing a successful evaluation.
    expect(() => validateRegressionAssertions([{ kind: 'cost_usd', operator: '<=', expected: -1 }])).toThrow(expect.objectContaining({ code: 'EVALUATION_ASSERTION_INVALID' }));
  });

  it('evaluates bounded quality, cost, duration, contains, and schema assertions deterministically', async () => {
    // Break caught: independently valid assertion kinds being skipped or using inconsistent pass semantics.
    const result = await runFixtureEvaluation({
      definition: {
        nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'finish', type: 'output' as const, config: { output: { summary: 'safe output', score: 0.9 } } }],
        edges: [{ source: 'start', target: 'finish' }],
      },
      input: {},
      manifest: evaluationManifest,
      fixtures: {},
      measurements: { costUsd: 0.02, durationMs: 15, qualityScore: 0.9 },
      assertions: [
        { kind: 'output.json_path', path: 'summary', operator: 'contains', expected: 'safe' },
        { kind: 'output.schema', schema: { type: 'object', required: ['summary', 'score'], properties: { summary: { type: 'string' }, score: { type: 'number' } } } },
        { kind: 'cost_usd', operator: '<=', expected: 0.02 },
        { kind: 'duration_ms', operator: '<=', expected: 15 },
        { kind: 'quality.score', operator: '>=', expected: 0.9 },
      ],
    });

    expect(result.status).toBe('passed');
    expect(result.assertionResults.map((assertion) => assertion.passed)).toEqual([true, true, true, true, true]);
  });

  it('uses canonical deep JSON equality and validates only the supported schema subset', async () => {
    // Break caught: object key order changing equality or unsupported JSON Schema keywords being silently ignored.
    const result = await runFixtureEvaluation({
      definition: { nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'finish', type: 'output' as const, config: { output: { nested: [{ b: 2, a: 1 }] } } }], edges: [{ source: 'start', target: 'finish' }] },
      input: {}, manifest: evaluationManifest, fixtures: {},
      assertions: [{ kind: 'output.json_path', path: 'nested', operator: 'equals', expected: [{ a: 1, b: 2 }] }, { kind: 'output.schema', schema: { type: 'object', required: ['nested'], properties: { nested: { type: 'array', items: { type: 'object', required: ['a'], properties: { a: { type: 'number' } } } } } } }],
    });
    expect(result.status).toBe('passed');
    expect(() => validateRegressionAssertions([{ kind: 'output.schema', schema: { type: 'object', unknownKeyword: true } }])).toThrow(expect.objectContaining({ code: 'EVALUATION_ASSERTION_INVALID' }));
    expect(() => validateRegressionAssertions([{ kind: 'output.schema', schema: { type: 'object', required: 'not-an-array' } }])).toThrow(expect.objectContaining({ code: 'EVALUATION_ASSERTION_INVALID' }));
  });

  it('fails closed when a workflow approval has no explicit evaluation fixture', async () => {
    // Break caught: silently auto-approving a workflow branch in evaluation mode.
    await expect(runFixtureEvaluation({
      definition: { nodes: [{ id: 'start', type: 'trigger' as const, config: {} }, { id: 'approve', type: 'approval' as const, config: {} }, { id: 'finish', type: 'output' as const, config: {} }], edges: [{ source: 'start', target: 'approve' }, { source: 'approve', target: 'finish' }] },
      input: {}, manifest: evaluationManifest, fixtures: {}, assertions: [],
    })).rejects.toMatchObject({ code: 'EVALUATION_APPROVAL_FIXTURE_REQUIRED' });
  });
});
