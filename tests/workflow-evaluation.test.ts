import { describe, expect, it, vi } from 'vitest';
import { dryRunWorkflow } from '../src/workflows/dry-run.js';
import { workflowDefinitionSchema } from '../src/workflows/definition.js';

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
      maxNodeExecutions: 25,
    });
  });
});
