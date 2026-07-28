import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  workspace: '00000000-0000-4000-8000-000000000001',
  run: '00000000-0000-4000-8000-000000000002',
  user: '00000000-0000-4000-8000-000000000003',
  tool: '00000000-0000-4000-8000-000000000004',
  authorization: '00000000-0000-4000-8000-000000000005',
  trace: '00000000-0000-4000-8000-000000000006',
  span: '00000000-0000-4000-8000-000000000007',
}));
const state = vi.hoisted(() => ({
  statements: [] as Array<{ sql: string; values: unknown[] }>,
  ledger: null as null | {
    id: string;
    status: string;
    result: unknown;
    runtimeError: Record<string, unknown> | null;
  },
  insertValues: null as unknown[] | null,
  invokeCount: 0,
  invokeError: null as Error | null,
  identitySource: null as unknown,
  invokedTool: null as unknown,
  loadedTool: {
    id: ids.tool,
    name: 'send_update',
    kind: 'api',
    config: {},
    permissions: ['write'],
  },
  workflowStatus: 'running',
}));

vi.mock('../src/tools/runtime.js', () => ({
  toolRequiresApproval: vi.fn(() => true),
  toolRiskLevel: vi.fn(() => 'write'),
  invokeTool: vi.fn(async (tool: unknown) => {
    state.invokedTool = tool;
    state.invokeCount += 1;
    if (state.invokeError) throw state.invokeError;
    return { delivered: true };
  }),
}));
vi.mock('../src/runtime/manifest.js', () => ({
  assertWorkflowRunManifestDependencies: vi.fn(async () => undefined),
  apiToolManifestEntry: vi.fn((tool: unknown) => {
    state.identitySource = tool;
    return {
      toolId: ids.tool,
      schemaHash: 'a'.repeat(64),
      permissionHash: 'b'.repeat(64),
      riskLevel: 'write',
    };
  }),
}));
vi.mock('../src/lib/crypto.js', () => ({
  encryptJsonWithContext: vi.fn(() => ({
    version: 1,
    iv: 'iv',
    tag: 'tag',
    data: 'encrypted',
  })),
  decryptJsonWithContext: vi.fn(() => ({ value: state.ledger?.result })),
}));
vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    if (sql.includes('FROM tools')) {
      return {
        rowCount: 1,
        rows: [state.loadedTool],
      };
    }
    if (sql.includes('workflow_run_node_states') && sql.includes('approved')) {
      return { rowCount: 1, rows: [{ approved: true }] };
    }
    if (sql.includes('subject_allows_actions')) {
      return { rowCount: 1, rows: [{ subject_allows_actions: true }] };
    }
    if (sql.includes('FROM action_authorizations') && sql.includes('ORDER BY requested_at')) {
      if (!state.ledger) return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          id: state.ledger.id,
          status: state.ledger.status,
          result_summary: state.ledger.result,
          encrypted_result: null,
          error_message: null,
          expires_at: '2099-01-01T00:00:00.000Z',
          workspace_id: ids.workspace,
          subject_type: 'workflow_run',
          workflow_run_id: ids.run,
          task_id: null,
        }],
      };
    }
    if (sql.includes('INSERT INTO action_authorizations')) {
      state.insertValues = values;
      state.ledger = {
        id: ids.authorization,
        status: String(values[16]),
        result: null,
        runtimeError: null,
      };
      return { rowCount: 1, rows: [{ id: ids.authorization }] };
    }
    if (sql.includes("SET status='executing'")) {
      if (state.ledger?.status !== 'approved') return { rowCount: 0, rows: [] };
      state.ledger.status = 'executing';
      return { rowCount: 1, rows: [{ id: ids.authorization }] };
    }
    if (sql.includes('FROM action_authorizations WHERE id=$1') && sql.includes("status='executing'")) {
      if (state.ledger?.status !== 'executing') return { rowCount: 0, rows: [] };
      return {
        rowCount: 1,
        rows: [{
          id: ids.authorization,
          workspace_id: ids.workspace,
          subject_type: 'workflow_run',
          workflow_run_id: ids.run,
          task_id: null,
          status: 'executing',
          result_summary: null,
          encrypted_result: null,
          error_message: null,
          expires_at: '2099-01-01T00:00:00.000Z',
        }],
      };
    }
    if (sql.includes("SET status='consumed'")) {
      if (state.ledger) {
        state.ledger.status = 'consumed';
        state.ledger.result = JSON.parse(String(values[0]));
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SET status='failed'") && sql.includes('action_authorizations')) {
      if (state.ledger) {
        state.ledger.status = 'failed';
        state.ledger.runtimeError = JSON.parse(String(values[1]));
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('side_effects')) {
      const sideEffects = state.ledger?.status === 'consumed'
        || state.ledger?.status === 'executing'
        || state.ledger?.runtimeError?.code === 'ACTION_OUTCOME_UNCERTAIN';
      return { rowCount: 1, rows: [{ side_effects: sideEffects }] };
    }
    if (sql.includes('UPDATE workflow_runs SET status=$1')) {
      state.workflowStatus = String(values[0]);
      return { rowCount: 1, rows: [{ status: values[0] }] };
    }
    return { rowCount: 1, rows: [] };
  }),
}));

import { finalizeCancellation } from '../src/runtime/cancellation.js';
import { serializeRuntimeError } from '../src/runtime/errors.js';
import { executeLegacyToolNode } from '../src/workflows/adapters/legacy-tool.js';

function context() {
  return {
    execution: {
      mode: 'test',
      manifest: null,
      signal: new AbortController().signal,
      trace: { traceId: ids.trace, spanId: ids.span, parentSpanId: null },
    },
    run: {
      id: ids.run,
      workspace_id: ids.workspace,
      workflow_id: '00000000-0000-4000-8000-000000000008',
      input: {},
      definition_snapshot: {
        nodes: [
          { id: 'approve', type: 'approval', config: {} },
          { id: 'legacy-write', type: 'action', config: { toolId: ids.tool, input: { message: 'hello' } } },
        ],
        edges: [{ source: 'approve', target: 'legacy-write' }],
      },
      state: {},
      cursor: { nodeId: 'legacy-write', previousNodeId: 'approve', loops: {}, attempt: 1 },
      step_count: 2,
      run_mode: 'test',
      execution_manifest: null,
      trace_id: ids.trace,
      span_id: ids.span,
      parent_span_id: null,
      name: 'Legacy write',
      created_by: ids.user,
    },
    node: { id: 'legacy-write', type: 'action', config: { toolId: ids.tool, input: { message: 'hello' } } },
    cursor: { nodeId: 'legacy-write', previousNodeId: 'approve', loops: {}, attempt: 1 },
    iterationKey: 'loop:2',
    executeAgentTask: async () => null,
    emitEvent: async () => undefined,
    resolve: (value: unknown) => value,
    setNodeOutput: () => undefined,
    registerActionIdentity: () => undefined,
  } as never;
}

describe('legacy workflow action ledger', () => {
  beforeEach(() => {
    state.statements = [];
    state.ledger = null;
    state.insertValues = null;
    state.invokeCount = 0;
    state.invokeError = null;
    state.identitySource = null;
    state.invokedTool = null;
    state.workflowStatus = 'running';
  });

  it('records a preceding-approved write without a second prompt and preserves dedup identity', async () => {
    await expect(executeLegacyToolNode(context())).resolves.toMatchObject({
      output: { delivered: true },
    });
    await expect(executeLegacyToolNode(context())).resolves.toMatchObject({
      output: { delivered: true },
    });

    expect(state.ledger?.status).toBe('consumed');
    expect(state.invokeCount).toBe(1);
    expect(state.insertValues?.[8]).toBe('legacy-write:loop:2:1');
    expect(state.insertValues?.[9]).toBe('api');
    expect(state.insertValues?.[13]).toBe('write');
    expect(state.insertValues?.[16]).toBe('approved');
    expect(String(state.insertValues?.[15])).toHaveLength(64);
    expect(state.identitySource).toBe(state.loadedTool);
    expect(state.invokedTool).toBe(state.loadedTool);
  });

  it('persists an uncertain write outcome so cancellation cannot finalize false-clean', async () => {
    state.invokeError = new Error('connection dropped after dispatch');

    const failure = await executeLegacyToolNode(context()).catch((error: unknown) => error);
    expect(serializeRuntimeError(failure)).toMatchObject({
      code: 'ACTION_OUTCOME_UNCERTAIN',
      category: 'permanent',
      retryable: false,
    });
    expect(state.ledger?.runtimeError).toMatchObject({
      code: 'ACTION_OUTCOME_UNCERTAIN',
    });

    state.workflowStatus = 'cancel_requested';
    await expect(finalizeCancellation({ kind: 'workflow_run', id: ids.run }))
      .resolves.toBe('cancelled_with_side_effects');
    expect(state.workflowStatus).toBe('cancelled_with_side_effects');
  });
});
