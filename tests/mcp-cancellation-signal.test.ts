import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  executionInput: null as Record<string, unknown> | null,
  identityRows: null as unknown,
  registeredIdentity: null as unknown,
  loadedTool: {
    id: '00000000-0000-4000-8000-000000000010',
    agent_id: '00000000-0000-4000-8000-000000000006',
    remote_name: 'lookup',
    title: 'Lookup',
    description: '',
    input_schema: { type: 'object' },
    risk_level: 'read',
    connection_id: '00000000-0000-4000-8000-000000000011',
    connection_name: 'Test',
    workspace_id: '00000000-0000-4000-8000-000000000004',
    transport: 'streamable-http',
    endpoint_url: 'https://example.test/mcp',
    auth_type: 'none',
    encrypted_credentials: null,
    connection_permission: 'read',
    tool_permission: 'read',
  },
}));

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
}));
vi.mock('../src/mcp/runtime.js', () => ({
  authorizedMcpTool: vi.fn(async () => state.loadedTool),
  authorizedMcpAction: vi.fn(async () => ({
    tool: state.loadedTool,
    manifestRows: [state.loadedTool],
  })),
  executeAuthorizedMcpTool: vi.fn(async (input: Record<string, unknown>) => {
    state.executionInput = input;
    return { callId: '00000000-0000-4000-8000-000000000012', result: { ok: true } };
  }),
}));
vi.mock('../src/policy/action-gateway.js', () => ({
  authorizeWorkflowAction: vi.fn(async () => ({
    status: 'allowed',
    authorizationId: '00000000-0000-4000-8000-000000000020',
  })),
  beginWorkflowAction: vi.fn(async () => true),
  completeWorkflowAction: vi.fn(async () => undefined),
  failWorkflowAction: vi.fn(async () => undefined),
}));
vi.mock('../src/runtime/manifest.js', () => ({
  assertWorkflowRunManifestDependencies: vi.fn(async () => undefined),
  mcpActionManifestEntry: vi.fn((rows: unknown) => {
    state.identityRows = rows;
    return {
      connectionId: state.loadedTool.connection_id,
      toolId: state.loadedTool.id,
      schemaHash: 'a'.repeat(64),
      permissionHash: 'b'.repeat(64),
      riskLevel: 'read',
    };
  }),
}));

import { executeMcpActionNode } from '../src/workflows/adapters/mcp.js';

describe('MCP workflow cancellation propagation', () => {
  it('passes the workflow cancellation signal into MCP execution', async () => {
    const controller = new AbortController();
    await executeMcpActionNode({
      execution: {
        mode: 'test',
        manifest: null,
        signal: controller.signal,
        trace: {
          traceId: '00000000-0000-4000-8000-000000000001',
          spanId: '00000000-0000-4000-8000-000000000002',
          parentSpanId: null,
        },
      },
      run: {
        id: '00000000-0000-4000-8000-000000000003',
        workspace_id: '00000000-0000-4000-8000-000000000004',
        created_by: '00000000-0000-4000-8000-000000000005',
        state: {},
      },
      node: {
        id: 'lookup',
        type: 'mcp_action',
        config: {
          agentId: '00000000-0000-4000-8000-000000000006',
          mcpToolId: '00000000-0000-4000-8000-000000000010',
          input: {},
        },
      },
      cursor: { nodeId: 'lookup', loops: {}, attempt: 1 },
      iterationKey: 'root',
      resolve: (value: unknown) => value,
      emitEvent: async () => undefined,
      setNodeOutput: () => undefined,
      registerActionIdentity: (identity: unknown) => {
        state.registeredIdentity = identity;
      },
    } as never);

    expect(state.executionInput?.signal).toBe(controller.signal);
    expect(state.executionInput?.tool).toBe(state.loadedTool);
    expect(state.identityRows).toEqual([state.loadedTool]);
    expect(state.registeredIdentity).toMatchObject({
      adapter: 'mcp',
      resourceId: state.loadedTool.id,
      agentId: state.loadedTool.agent_id,
      riskLevel: 'read',
      manifestEntry: { toolId: state.loadedTool.id },
    });
  });
});
