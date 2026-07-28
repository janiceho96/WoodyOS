import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  statements: [] as Array<{ sql: string; values: unknown[] }>,
  enqueued: [] as Array<{ runId: string; phaseId: string; delay: number; traceId: string }>,
  actionNode: null as null | {
    id: string;
    type: 'action';
    config: Record<string, unknown>;
  },
  actionIdentity: null as null | {
    adapter: 'api';
    resourceId: string;
    riskLevel: 'read' | 'write' | 'unknown';
  },
}));

const run = {
  id: '00000000-0000-4000-8000-000000000001',
  workspace_id: '00000000-0000-4000-8000-000000000002',
  workflow_id: '00000000-0000-4000-8000-000000000003',
  workflow_version_id: '00000000-0000-4000-8000-000000000004',
  input: {},
  definition_snapshot: {
    nodes: [
      {
        id: 'agent',
        type: 'agent',
        config: {
          retry: {
            maxAttempts: 3,
            initialDelayMs: 250,
            multiplier: 2,
            maxDelayMs: 1_000,
          },
        },
      },
      { id: 'finish', type: 'output', config: {} },
    ],
    edges: [{ source: 'agent', target: 'finish' }],
  },
  state: { input: {}, nodes: {}, variables: {} },
  cursor: { nodeId: 'agent', loops: {}, attempt: 1 },
  step_count: 0,
  run_mode: 'test',
  execution_manifest: null,
  test_target_node_id: null,
  name: 'Retry workflow',
  created_by: '00000000-0000-4000-8000-000000000005',
  trace_id: '00000000-0000-4000-8000-000000000006',
  span_id: '00000000-0000-4000-8000-000000000007',
  parent_span_id: null,
};

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    if (sql.includes('UPDATE workflow_runs r SET')) {
      const claimed = structuredClone(run);
      if (state.actionNode) {
        claimed.definition_snapshot.nodes[0] = structuredClone(state.actionNode);
        claimed.definition_snapshot.edges[0].source = state.actionNode.id;
        claimed.cursor.nodeId = state.actionNode.id;
      }
      return { rowCount: 1, rows: [claimed] };
    }
    return { rowCount: 1, rows: [] };
  }),
}));
vi.mock('../src/workflows/adapters/index.js', async () => {
  const { runtimeError } = await import('../src/runtime/errors.js');
  return {
    executeRegisteredWorkflowNode: vi.fn(async (context) => {
      if (state.actionIdentity) context.registerActionIdentity(state.actionIdentity);
      throw runtimeError('UPSTREAM_TIMEOUT', {
        category: 'timeout',
        retryable: true,
        message: 'upstream timed out with token=do-not-persist',
      });
    }),
  };
});
vi.mock('../src/queue/task-queue.js', () => ({
  enqueueWorkflowRun: vi.fn(async (
    runId: string,
    phaseId: string,
    delay: number,
    traceId: string,
  ) => {
    state.enqueued.push({ runId, phaseId, delay, traceId });
  }),
}));
vi.mock('../src/artifacts/service.js', () => ({
  requestWorkflowArtifacts: vi.fn(async () => []),
}));

import { executeWorkflowStep } from '../src/workflows/runtime.js';

describe('workflow retry scheduling', () => {
  beforeEach(() => {
    state.statements = [];
    state.enqueued = [];
    state.actionNode = null;
    state.actionIdentity = null;
  });

  it('persists one decision and schedules exactly one logical next attempt', async () => {
    await executeWorkflowStep(run.id, async () => null);

    expect(state.enqueued).toEqual([{
      runId: run.id,
      phaseId: `${run.id}:step:1:agent:root:2`,
      delay: 250,
      traceId: run.trace_id,
    }]);
    const failedNode = state.statements.find((entry) => (
      entry.sql.includes("workflow_run_node_states SET status='failed'")
    ));
    const persisted = JSON.parse(String(failedNode?.values[0]));
    expect(persisted).toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      category: 'timeout',
      retryable: true,
      retryDecision: {
        retry: true,
        delayMs: 250,
        reason: 'retry_scheduled',
      },
    });
    expect(JSON.stringify(state.statements)).not.toContain('do-not-persist');
    expect(state.statements.filter((entry) => (
      entry.sql.includes("UPDATE workflow_runs SET status='queued',cursor=")
    ))).toHaveLength(1);
  });

  it.each([
    ['write', 'write'],
    ['unknown', 'unknown'],
  ] as const)('vetoes retryable adapter failures for authoritative %s actions', async (_name, riskLevel) => {
    const toolId = '00000000-0000-4000-8000-000000000010';
    state.actionNode = {
      id: 'action',
      type: 'action',
      config: {
        toolId,
        retry: {
          maxAttempts: 3,
          initialDelayMs: 250,
          multiplier: 2,
          maxDelayMs: 1_000,
        },
      },
    };
    state.actionIdentity = { adapter: 'api', resourceId: toolId, riskLevel };

    await executeWorkflowStep(run.id, async () => null);

    expect(state.enqueued).toEqual([]);
    const failedNode = state.statements.find((entry) => (
      entry.sql.includes("workflow_run_node_states SET status='failed'")
    ));
    expect(JSON.parse(String(failedNode?.values[0]))).toMatchObject({
      retryDecision: { retry: false, reason: 'action_not_retryable' },
    });
  });

  it('preserves one legacy read retry without a second resource query or duplicate schedule', async () => {
    const toolId = '00000000-0000-4000-8000-000000000010';
    state.actionNode = {
      id: 'action',
      type: 'action',
      config: {
        toolId,
        retry: {
          maxAttempts: 3,
          initialDelayMs: 250,
          multiplier: 2,
          maxDelayMs: 1_000,
        },
      },
    };
    state.actionIdentity = { adapter: 'api', resourceId: toolId, riskLevel: 'read' };

    await executeWorkflowStep(run.id, async () => null);

    expect(state.enqueued).toHaveLength(1);
    expect(state.statements.filter((entry) => entry.sql.includes('FROM tools'))).toHaveLength(0);
    expect(state.statements.filter((entry) => (
      entry.sql.includes("UPDATE workflow_runs SET status='queued',cursor=")
    ))).toHaveLength(1);
  });

  it('treats an action without an authoritative resource identity as unknown and non-retryable', async () => {
    state.actionNode = {
      id: 'action',
      type: 'action',
      config: {
        toolId: '00000000-0000-4000-8000-000000000010',
        retry: {
          maxAttempts: 3,
          initialDelayMs: 250,
          multiplier: 2,
          maxDelayMs: 1_000,
        },
      },
    };

    await executeWorkflowStep(run.id, async () => null);

    expect(state.enqueued).toEqual([]);
    const failedNode = state.statements.find((entry) => (
      entry.sql.includes("workflow_run_node_states SET status='failed'")
    ));
    expect(JSON.parse(String(failedNode?.values[0]))).toMatchObject({
      retryDecision: { retry: false, reason: 'action_not_retryable' },
    });
  });
});
