import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  statements: [] as Array<{ sql: string; values: unknown[] }>,
  contexts: [] as Array<Record<string, unknown>>,
}));

const run = {
  id: '00000000-0000-4000-8000-000000000001',
  workspace_id: '00000000-0000-4000-8000-000000000002',
  workflow_id: '00000000-0000-4000-8000-000000000003',
  workflow_version_id: '00000000-0000-4000-8000-000000000004',
  input: {},
  definition_snapshot: {
    nodes: [{ id: 'start', type: 'trigger', config: {} }],
    edges: [],
  },
  state: { input: {}, nodes: {}, variables: {} },
  cursor: { nodeId: 'start', loops: {}, attempt: 1 },
  step_count: 0,
  run_mode: 'test',
  execution_manifest: null,
  test_target_node_id: null,
  name: 'Persistence workflow',
  created_by: '00000000-0000-4000-8000-000000000005',
  trace_id: '00000000-0000-4000-8000-000000000006',
  span_id: '00000000-0000-4000-8000-000000000007',
  parent_span_id: null,
};

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    if (sql.includes('UPDATE workflow_runs r SET')) return { rowCount: 1, rows: [structuredClone(run)] };
    return { rowCount: 1, rows: [] };
  }),
}));
vi.mock('../src/workflows/adapters/index.js', () => ({
  executeRegisteredWorkflowNode: vi.fn(async (context: Record<string, unknown>) => {
    state.contexts.push(context);
    throw new Error('Provider failed with {"apiKey":"do-not-persist","retryAfterMs":2000}');
  }),
}));
vi.mock('../src/queue/task-queue.js', () => ({ enqueueWorkflowRun: vi.fn(async () => undefined) }));
vi.mock('../src/artifacts/service.js', () => ({ requestWorkflowArtifacts: vi.fn(async () => []) }));

import { executeWorkflowStep } from '../src/workflows/runtime.js';

describe('structured runtime error persistence', () => {
  beforeEach(() => {
    state.statements = [];
    state.contexts = [];
  });

  it('stores only serialized redacted errors in node, run, and event records', async () => {
    await executeWorkflowStep(run.id, async () => null);

    const nodeFailure = state.statements.find((entry) => entry.sql.includes("workflow_run_node_states SET status='failed'"));
    const runFailure = state.statements.find((entry) => entry.sql.includes("workflow_runs SET status='failed',output="));
    const allPersisted = JSON.stringify(state.statements);
    const nodeError = JSON.parse(String(nodeFailure?.values[0]));
    const runOutput = JSON.parse(String(runFailure?.values[0]));

    expect(nodeError).toMatchObject({
      code: 'RUNTIME_ERROR',
      category: 'unknown',
      retryable: false,
    });
    expect(runOutput.error).toMatchObject({
      code: 'RUNTIME_ERROR',
      category: 'unknown',
      retryable: false,
    });
    expect(allPersisted).not.toContain('do-not-persist');
    const nodeStart = state.statements.find((entry) => entry.sql.includes('INSERT INTO workflow_run_node_states'));
    expect(nodeStart?.sql).toContain('trace_id');
    const events = state.statements.filter((entry) => entry.sql.includes('INSERT INTO workflow_run_events'));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.sql.includes('trace_id'))).toBe(true);
    expect(state.contexts[0]).toMatchObject({
      execution: {
        trace: {
          traceId: run.trace_id,
          parentSpanId: run.span_id,
        },
        signal: { aborted: false },
        manifest: null,
      },
    });
  });

  it('same-statement fences workflow claims, node mutations, events, and terminal transitions', async () => {
    await executeWorkflowStep(run.id, async () => null, new AbortController().signal, 'worker-owner');

    const workerMutations = state.statements.filter(({ sql }) => (
      sql.includes('UPDATE workflow_runs r SET')
      || sql.includes('INSERT INTO workflow_run_node_states')
      || sql.includes("workflow_run_node_states SET status='failed'")
      || sql.includes("workflow_runs SET status='failed',output=")
      || sql.includes('INSERT INTO workflow_run_events')
    ));
    expect(workerMutations.length).toBeGreaterThan(4);
    expect(workerMutations.every(({ sql, values }) => (
      sql.includes('execution_leases')
      && sql.includes('expires_at>now()')
      && values.includes('worker-owner')
    ))).toBe(true);
  });
});
