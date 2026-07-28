import { beforeEach, describe, expect, it, vi } from 'vitest';

const gateway = vi.hoisted(() => ({
  failWorkflowAction: vi.fn(async () => undefined),
  invokeTool: vi.fn(async () => {
    throw new Error('connection dropped with token=remote-secret');
  }),
}));

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM tools')) {
      return {
        rowCount: 1,
        rows: [{
          id: '00000000-0000-4000-8000-000000000010',
          name: 'send_update',
          kind: 'api',
          config: {},
          permissions: ['write'],
        }],
      };
    }
    return { rowCount: 0, rows: [] };
  }),
}));
vi.mock('../src/tools/runtime.js', () => ({
  invokeTool: gateway.invokeTool,
  toolRiskLevel: vi.fn(() => 'write'),
}));
vi.mock('../src/policy/action-gateway.js', () => ({
  authorizeWorkflowAction: vi.fn(async () => ({
    status: 'allowed',
    authorizationId: '00000000-0000-4000-8000-000000000020',
  })),
  beginWorkflowAction: vi.fn(async () => true),
  completeWorkflowAction: vi.fn(async () => undefined),
  failWorkflowAction: gateway.failWorkflowAction,
}));
vi.mock('../src/runtime/manifest.js', () => ({
  assertWorkflowRunManifestDependencies: vi.fn(async () => undefined),
}));

import { executeApiActionNode } from '../src/workflows/adapters/api.js';
import { serializeRuntimeError } from '../src/runtime/errors.js';

describe('action retry safety', () => {
  beforeEach(() => {
    gateway.failWorkflowAction.mockReset();
    gateway.failWorkflowAction.mockResolvedValue(undefined);
    gateway.invokeTool.mockClear();
  });

  it('maps an uncertain write outcome before it reaches workflow retry authority', async () => {
    let failure: unknown;
    try {
      await executeApiActionNode({
        execution: {
          mode: 'test',
          manifest: null,
          signal: new AbortController().signal,
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
          id: 'write',
          type: 'api_action',
          config: { toolId: '00000000-0000-4000-8000-000000000010', input: {} },
        },
        cursor: { nodeId: 'write', loops: {}, attempt: 1 },
        iterationKey: 'root',
        resolve: (value: unknown) => value,
        emitEvent: async () => undefined,
        setNodeOutput: () => undefined,
        registerActionIdentity: () => undefined,
      } as never);
    } catch (error) {
      failure = error;
    }

    expect(serializeRuntimeError(failure)).toMatchObject({
      code: 'ACTION_OUTCOME_UNCERTAIN',
      category: 'permanent',
      retryable: false,
    });
    expect(JSON.stringify(serializeRuntimeError(failure))).not.toContain('remote-secret');
  });

  it('preserves an uncertain workflow action error when ledger failure persistence rejects', async () => {
    gateway.failWorkflowAction.mockRejectedValueOnce(
      new Error('ledger update failed with token=ledger-secret'),
    );

    let failure: unknown;
    try {
      await executeApiActionNode({
        execution: {
          mode: 'test',
          manifest: null,
          signal: new AbortController().signal,
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
          id: 'write',
          type: 'api_action',
          config: { toolId: '00000000-0000-4000-8000-000000000010', input: {} },
        },
        cursor: { nodeId: 'write', loops: {}, attempt: 1 },
        iterationKey: 'root',
        resolve: (value: unknown) => value,
        emitEvent: async () => undefined,
        setNodeOutput: () => undefined,
        registerActionIdentity: () => undefined,
      } as never);
    } catch (error) {
      failure = error;
    }

    const serialized = serializeRuntimeError(failure);
    expect(serialized).toMatchObject({
      code: 'ACTION_OUTCOME_UNCERTAIN',
      category: 'permanent',
      retryable: false,
      details: {
        operatorContext: {
          actionFailurePersistence: {
            code: 'RUNTIME_ERROR',
            category: 'unknown',
            retryable: false,
          },
        },
      },
    });
    expect(JSON.stringify(serialized)).not.toContain('remote-secret');
    expect(JSON.stringify(serialized)).not.toContain('ledger-secret');
  });

  it('passes the workflow cancellation signal into the API tool call', async () => {
    const controller = new AbortController();
    await executeApiActionNode({
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
        id: 'write',
        type: 'api_action',
        config: { toolId: '00000000-0000-4000-8000-000000000010', input: {} },
      },
      cursor: { nodeId: 'write', loops: {}, attempt: 1 },
      iterationKey: 'root',
      resolve: (value: unknown) => value,
      emitEvent: async () => undefined,
      setNodeOutput: () => undefined,
      registerActionIdentity: () => undefined,
    } as never).catch(() => undefined);

    expect(gateway.invokeTool.mock.calls[0]?.[3]).toBe(controller.signal);
  });
});
