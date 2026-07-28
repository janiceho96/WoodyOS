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
    expect(result.externalActions).toEqual([{ nodeId: 'send', adapter: 'api', resourceId: toolId, risk: 'write', requiresConfirmation: true }]);
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
});
