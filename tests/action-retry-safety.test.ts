import { describe, expect, it, vi } from 'vitest';

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
  invokeTool: vi.fn(async () => {
    throw new Error('connection dropped with token=remote-secret');
  }),
  toolRiskLevel: vi.fn(() => 'write'),
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
}));

import { executeApiActionNode } from '../src/workflows/adapters/api.js';
import { serializeRuntimeError } from '../src/runtime/errors.js';

describe('action retry safety', () => {
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
});
