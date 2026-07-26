import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  statements: [] as Array<{ sql: string; values: unknown[] }>,
  seenSignal: null as AbortSignal | null,
  enqueued: 0,
}));
const controller = new AbortController();
const run = {
  id: '00000000-0000-4000-8000-000000000001',
  workspace_id: '00000000-0000-4000-8000-000000000002',
  workflow_id: '00000000-0000-4000-8000-000000000003',
  input: {},
  definition_snapshot: {
    nodes: [{ id: 'agent', type: 'agent', config: {} }],
    edges: [],
  },
  state: { input: {}, nodes: {}, variables: {} },
  cursor: { nodeId: 'agent', loops: {}, attempt: 1 },
  step_count: 0,
  run_mode: 'test',
  execution_manifest: null,
  test_target_node_id: null,
  name: 'Cancellation workflow',
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
  const { cancellationError } = await import('../src/runtime/cancellation.js');
  return {
    executeRegisteredWorkflowNode: vi.fn(async (context: { execution: { signal: AbortSignal } }) => {
      state.seenSignal = context.execution.signal;
      controller.abort();
      throw cancellationError(new Error('provider aborted with token=secret'));
    }),
  };
});
vi.mock('../src/queue/task-queue.js', () => ({
  enqueueWorkflowRun: vi.fn(async () => {
    state.enqueued += 1;
  }),
}));
vi.mock('../src/artifacts/service.js', () => ({
  requestWorkflowArtifacts: vi.fn(async () => []),
}));

import { executeWorkflowStep } from '../src/workflows/runtime.js';
import { serializeRuntimeError } from '../src/runtime/errors.js';

describe('workflow cancellation execution', () => {
  beforeEach(() => {
    state.statements = [];
    state.seenSignal = null;
    state.enqueued = 0;
  });

  it('propagates caller cancellation without persisting a retry or failure transition', async () => {
    let failure: unknown;
    try {
      await executeWorkflowStep(run.id, async () => null, controller.signal);
    } catch (error) {
      failure = error;
    }

    expect(state.seenSignal).toBe(controller.signal);
    expect(serializeRuntimeError(failure)).toMatchObject({
      code: 'RUNTIME_CANCELLED',
      category: 'cancelled',
      retryable: false,
    });
    expect(state.enqueued).toBe(0);
    expect(state.statements.some(({ sql }) => (
      sql.includes("workflow_runs SET status='failed'")
    ))).toBe(false);
    expect(JSON.stringify(state.statements)).not.toContain('secret');
  });
});
