import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  statements: [] as Array<{ sql: string; values: unknown[] }>,
  enqueued: [] as Array<{ runId: string; phaseId: string; delay: number; traceId: string }>,
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
      return { rowCount: 1, rows: [structuredClone(run)] };
    }
    return { rowCount: 1, rows: [] };
  }),
}));
vi.mock('../src/workflows/adapters/index.js', async () => {
  const { runtimeError } = await import('../src/runtime/errors.js');
  return {
    executeRegisteredWorkflowNode: vi.fn(async () => {
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
});
