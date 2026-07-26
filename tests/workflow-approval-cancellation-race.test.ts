import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  workspace: '00000000-0000-4000-8000-000000000001',
  user: '00000000-0000-4000-8000-000000000002',
  run: '00000000-0000-4000-8000-000000000003',
  approval: '00000000-0000-4000-8000-000000000004',
  trace: '00000000-0000-4000-8000-000000000005',
  span: '00000000-0000-4000-8000-000000000006',
}));

const state = vi.hoisted(() => ({
  runStatus: 'awaiting_approval',
  approvalStatus: 'pending',
  queueFailure: false,
  timeline: [] as string[],
  statements: [] as Array<{ sql: string; values: unknown[] }>,
}));

const runRow = () => ({
  run_mode: 'test',
  execution_manifest: null,
  trace_id: ids.trace,
  span_id: ids.span,
  parent_span_id: null,
  status: state.runStatus,
});

const approvalRow = () => ({
  id: ids.approval,
  workflow_run_id: ids.run,
  workspace_id: ids.workspace,
  status: state.approvalStatus,
});

async function executeSql(sql: string, values: unknown[] = []) {
  state.statements.push({ sql, values });
  const normalized = sql.trim();
  if (normalized === 'BEGIN' || normalized === 'ROLLBACK') {
    state.timeline.push(normalized);
    return { rowCount: null, rows: [] };
  }
  if (normalized === 'COMMIT') {
    state.timeline.push('COMMIT');
    return { rowCount: null, rows: [] };
  }
  if (sql.includes('FROM workflow_runs') && sql.includes('FOR UPDATE')) {
    return state.runStatus === 'awaiting_approval' || state.runStatus === 'queued'
      ? { rowCount: 1, rows: [runRow()] }
      : { rowCount: 0, rows: [] };
  }
  if (sql.includes('FROM workflow_approvals') && sql.includes('FOR UPDATE')) {
    return state.approvalStatus === 'pending'
      ? { rowCount: 1, rows: [approvalRow()] }
      : { rowCount: 0, rows: [] };
  }
  if (sql.includes('UPDATE workflow_approvals') && sql.includes('SET status=$1')) {
    if (state.approvalStatus !== 'pending') return { rowCount: 0, rows: [] };
    state.approvalStatus = String(values[0]);
    return { rowCount: 1, rows: [{ ...approvalRow(), status: values[0] }] };
  }
  if (sql.includes("UPDATE workflow_runs SET status='queued'")) {
    if (state.runStatus !== 'awaiting_approval' && sql.includes("status='awaiting_approval'")) {
      return { rowCount: 0, rows: [] };
    }
    state.runStatus = 'queued';
    return { rowCount: 1, rows: [{ id: ids.run }] };
  }
  if (sql.includes("UPDATE workflow_runs SET status='cancelled'")) {
    if (state.runStatus !== 'awaiting_approval' && sql.includes("status='awaiting_approval'")) {
      return { rowCount: 0, rows: [] };
    }
    state.runStatus = 'cancelled';
    return { rowCount: 1, rows: [{ id: ids.run }] };
  }
  if (sql.includes("SET status='pending'")) {
    state.approvalStatus = 'pending';
    return { rowCount: 1, rows: [approvalRow()] };
  }
  if (sql.includes("SET status='awaiting_approval'")) {
    state.runStatus = 'awaiting_approval';
    return { rowCount: 1, rows: [{ id: ids.run }] };
  }
  return { rowCount: 1, rows: [] };
}

const client = {
  query: executeSql,
  release: vi.fn(),
};

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => client) },
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('SELECT run_mode')) return { rowCount: 1, rows: [runRow()] };
    return executeSql(sql, values);
  }),
}));
vi.mock('../src/queue/task-queue.js', () => ({
  enqueueTask: vi.fn(),
  enqueueWorkflowRun: vi.fn(async () => {
    state.timeline.push('ENQUEUE');
    if (state.queueFailure) {
      state.runStatus = 'cancel_requested';
      throw new Error('queue unavailable');
    }
  }),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/ai-usage.js', () => ({ assertWorkspaceAiBudgetAvailable: vi.fn() }));
vi.mock('../src/artifacts/service.js', () => ({ requestWorkflowArtifacts: vi.fn() }));
vi.mock('../src/runtime/cancellation.js', () => ({ requestCancellation: vi.fn() }));

import { workflowRoutes } from '../src/routes/workflows.js';

async function app() {
  const instance = Fastify();
  instance.decorate('authenticate', async () => undefined);
  instance.decorate('authorize', async () => undefined);
  instance.addHook('preHandler', async (request) => {
    request.user = { sub: ids.user, workspaceId: ids.workspace, email: 'approval@example.test' };
  });
  await instance.register(workflowRoutes);
  return instance;
}

describe('native workflow approval cancellation race', () => {
  beforeEach(() => {
    state.runStatus = 'awaiting_approval';
    state.approvalStatus = 'pending';
    state.queueFailure = false;
    state.timeline = [];
    state.statements = [];
  });

  it('locks tenant-qualified run and approval state and queues only after commit', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: `/runs/${ids.run}/approvals/${ids.approval}`,
      payload: { decision: 'approved', comment: 'Ship it' },
    });
    await instance.close();

    expect(response.statusCode).toBe(200);
    expect(state.runStatus).toBe('queued');
    expect(state.approvalStatus).toBe('approved');
    expect(state.timeline.indexOf('COMMIT')).toBeGreaterThan(state.timeline.indexOf('BEGIN'));
    expect(state.timeline.indexOf('ENQUEUE')).toBeGreaterThan(state.timeline.indexOf('COMMIT'));
    const locks = state.statements.filter(({ sql }) => sql.includes('FOR UPDATE'));
    expect(locks).toHaveLength(2);
    expect(locks.every(({ sql }) => sql.includes('workspace_id'))).toBe(true);
    expect(state.statements.some(({ sql, values }) => (
      sql.includes('UPDATE workflow_approvals')
      && values.includes(ids.user)
      && values.includes('Ship it')
    ))).toBe(true);
  });

  it('does not consume approval state after cancellation wins the run lock', async () => {
    state.runStatus = 'cancel_requested';
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: `/runs/${ids.run}/approvals/${ids.approval}`,
      payload: { decision: 'approved' },
    });
    await instance.close();

    expect(response.statusCode).toBe(409);
    expect(state.runStatus).toBe('cancel_requested');
    expect(state.approvalStatus).toBe('pending');
    expect(state.timeline).not.toContain('ENQUEUE');
  });

  it('does not restore waiting state when cancellation wins after enqueue failure', async () => {
    state.queueFailure = true;
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: `/runs/${ids.run}/approvals/${ids.approval}`,
      payload: { decision: 'approved' },
    });
    await instance.close();

    expect(response.statusCode).toBe(500);
    expect(state.runStatus).toBe('cancel_requested');
    expect(state.approvalStatus).toBe('approved');
  });
});
