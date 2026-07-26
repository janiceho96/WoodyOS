import { beforeEach, describe, expect, it, vi } from 'vitest';

type Authorization = {
  id: string;
  workspace_id: string;
  subject_type: 'task' | 'workflow_run';
  task_id: string | null;
  workflow_run_id: string | null;
  on_expiration: 'auto_reject' | 'fail' | 'escalate';
  escalation_level: number;
  status: string;
  expires_at: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  runtime_error?: unknown;
};

const ids = {
  workspace: '00000000-0000-4000-8000-000000000001',
  authorization: '00000000-0000-4000-8000-000000000002',
  task: '00000000-0000-4000-8000-000000000003',
  workflow: '00000000-0000-4000-8000-000000000004',
  call: '00000000-0000-4000-8000-000000000005',
  trace: '00000000-0000-4000-8000-000000000006',
  span: '00000000-0000-4000-8000-000000000007',
};

const state = vi.hoisted(() => ({
  authorizations: new Map<string, Authorization>(),
  tasks: new Map<string, { status: string; error: unknown; workflowRunId: string | null }>(),
  workflows: new Map<string, { status: string; error: unknown }>(),
  checkpoints: new Map<string, { authorizationId: string; status: string; toolCallId: string | null }>(),
  calls: new Map<string, { authorizationId: string; status: string; errorCode: string | null }>(),
  confirmations: new Map<string, { status: string }>(),
  artifacts: [] as Array<{ taskId: string | null; workflowRunId: string | null; status: string; error: string | null }>,
  events: [] as Array<{ authorizationId: string; type: string; payload: unknown }>,
  locked: new Set<string>(),
  statements: [] as string[],
  failMarker: null as string | null,
}));

function cloneStore() {
  return {
    authorizations: structuredClone(state.authorizations),
    tasks: structuredClone(state.tasks),
    workflows: structuredClone(state.workflows),
    checkpoints: structuredClone(state.checkpoints),
    calls: structuredClone(state.calls),
    confirmations: structuredClone(state.confirmations),
    artifacts: structuredClone(state.artifacts),
    events: structuredClone(state.events),
  };
}

function restoreStore(snapshot: ReturnType<typeof cloneStore>) {
  state.authorizations = snapshot.authorizations;
  state.tasks = snapshot.tasks;
  state.workflows = snapshot.workflows;
  state.checkpoints = snapshot.checkpoints;
  state.calls = snapshot.calls;
  state.confirmations = snapshot.confirmations;
  state.artifacts = snapshot.artifacts;
  state.events = snapshot.events;
}

vi.mock('../src/db/client.js', () => ({
  db: {
    connect: vi.fn(async () => {
      let snapshot: ReturnType<typeof cloneStore> | null = null;
      const claimed: string[] = [];
      return {
        query: vi.fn(async (sql: string, values: unknown[] = []) => {
          state.statements.push(sql);
          if (sql === 'BEGIN') {
            snapshot = cloneStore();
            return { rowCount: null, rows: [] };
          }
          if (sql === 'COMMIT') {
            for (const id of claimed) state.locked.delete(id);
            return { rowCount: null, rows: [] };
          }
          if (sql === 'ROLLBACK') {
            if (snapshot) restoreStore(snapshot);
            for (const id of claimed) state.locked.delete(id);
            return { rowCount: null, rows: [] };
          }
          if (state.failMarker && sql.includes(state.failMarker)) throw new Error('injected mid-row failure');
          if (sql.includes('approval-expiry:claim')) {
            const limit = Number(values[0]);
            const due = [...state.authorizations.values()]
              .filter((row) => (
                row.status === 'awaiting_confirmation'
                && new Date(row.expires_at).getTime() <= Date.now()
                && !state.locked.has(row.id)
              ))
              .sort((left, right) => left.expires_at.localeCompare(right.expires_at) || left.id.localeCompare(right.id))
              .slice(0, limit);
            for (const row of due) {
              state.locked.add(row.id);
              claimed.push(row.id);
            }
            return { rowCount: due.length, rows: structuredClone(due) };
          }
          const authorizationId = String(values[0]);
          const authorization = state.authorizations.get(authorizationId);
          if (sql.includes('approval-expiry:escalate')) {
            if (!authorization || authorization.status !== 'awaiting_confirmation' || authorization.escalation_level !== 0) {
              return { rowCount: 0, rows: [] };
            }
            authorization.escalation_level = 1;
            authorization.expires_at = new Date(new Date(authorization.expires_at).getTime() + 86_400_000).toISOString();
            return { rowCount: 1, rows: [{ id: authorizationId }] };
          }
          if (sql.includes('approval-expiry:expire')) {
            if (!authorization || authorization.status !== 'awaiting_confirmation') return { rowCount: 0, rows: [] };
            authorization.status = 'expired';
            authorization.runtime_error = values[1] ? JSON.parse(String(values[1])) : null;
            return { rowCount: 1, rows: [{ id: authorizationId }] };
          }
          if (sql.includes('approval-expiry:checkpoint')) {
            for (const checkpoint of state.checkpoints.values()) {
              if (checkpoint.authorizationId === authorizationId && checkpoint.status === 'awaiting_confirmation') {
                checkpoint.status = String(values[1]);
              }
            }
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('approval-expiry:confirmation')) {
            for (const call of state.calls.values()) {
              if (call.authorizationId === authorizationId) {
                const confirmation = state.confirmations.get(
                  [...state.calls.entries()].find(([, candidate]) => candidate === call)?.[0] ?? '',
                );
                if (confirmation?.status === 'pending') confirmation.status = String(values[1]);
              }
            }
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('approval-expiry:call')) {
            for (const call of state.calls.values()) {
              if (call.authorizationId === authorizationId && call.status === 'awaiting_confirmation') {
                call.status = String(values[1]);
                call.errorCode = values[2] ? String(values[2]) : null;
              }
            }
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('approval-expiry:task')) {
            if (authorization?.task_id) {
              const task = state.tasks.get(authorization.task_id);
              if (task?.status === 'awaiting_approval') {
                task.status = String(values[1]);
                task.error = values[2] ? JSON.parse(String(values[2])) : null;
              }
            }
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('approval-expiry:workflow')) {
            const workflowId = authorization?.workflow_run_id
              ?? (authorization?.task_id ? state.tasks.get(authorization.task_id)?.workflowRunId : null);
            if (workflowId) {
              const workflow = state.workflows.get(workflowId);
              if (workflow?.status === 'awaiting_approval') {
                workflow.status = String(values[1]);
                workflow.error = values[2] ? JSON.parse(String(values[2])) : null;
              }
            }
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('approval-expiry:artifacts')) {
            for (const artifact of state.artifacts) {
              const workflowId = authorization?.workflow_run_id
                ?? (authorization?.task_id ? state.tasks.get(authorization.task_id)?.workflowRunId : null);
              if (
                artifact.status === 'pending'
                && (artifact.taskId === authorization?.task_id || artifact.workflowRunId === workflowId)
              ) {
                artifact.status = String(values[1]);
                artifact.error = values[2] ? String(values[2]) : null;
              }
            }
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('approval-expiry:event')) {
            state.events.push({
              authorizationId,
              type: String(values[1]),
              payload: JSON.parse(String(values[2])),
            });
            return { rowCount: 1, rows: [{ id: authorizationId }] };
          }
          return { rowCount: 0, rows: [] };
        }),
        release: vi.fn(),
      };
    }),
  },
}));

import {
  expireDueAuthorizations,
  startApprovalExpiryScheduler,
} from '../src/runtime/approval-expiry.js';

function seed(input: {
  policy?: Authorization['on_expiration'];
  level?: number;
  subject?: Authorization['subject_type'];
  taskStatus?: string;
  workflowStatus?: string;
  withMcp?: boolean;
} = {}) {
  const subject = input.subject ?? 'task';
  state.authorizations.set(ids.authorization, {
    id: ids.authorization,
    workspace_id: ids.workspace,
    subject_type: subject,
    task_id: subject === 'task' ? ids.task : null,
    workflow_run_id: subject === 'workflow_run' ? ids.workflow : null,
    on_expiration: input.policy ?? 'auto_reject',
    escalation_level: input.level ?? 0,
    status: 'awaiting_confirmation',
    expires_at: '2020-01-01T00:00:00.000Z',
    trace_id: ids.trace,
    span_id: ids.span,
    parent_span_id: null,
  });
  state.tasks.set(ids.task, {
    status: input.taskStatus ?? 'awaiting_approval',
    error: null,
    workflowRunId: ids.workflow,
  });
  state.workflows.set(ids.workflow, {
    status: input.workflowStatus ?? 'awaiting_approval',
    error: null,
  });
  state.checkpoints.set(ids.task, {
    authorizationId: ids.authorization,
    status: 'awaiting_confirmation',
    toolCallId: input.withMcp ? ids.call : null,
  });
  if (input.withMcp) {
    state.calls.set(ids.call, {
      authorizationId: ids.authorization,
      status: 'awaiting_confirmation',
      errorCode: null,
    });
    state.confirmations.set(ids.call, { status: 'pending' });
  }
  state.artifacts.push({
    taskId: subject === 'task' ? ids.task : null,
    workflowRunId: ids.workflow,
    status: 'pending',
    error: null,
  });
}

describe('approval expiration processing', () => {
  beforeEach(() => {
    state.authorizations = new Map();
    state.tasks = new Map();
    state.workflows = new Map();
    state.checkpoints = new Map();
    state.calls = new Map();
    state.confirmations = new Map();
    state.artifacts = [];
    state.events = [];
    state.locked = new Set();
    state.statements = [];
    state.failMarker = null;
    vi.useRealTimers();
  });

  it('claims an overdue authorization exactly once across concurrent batches', async () => {
    seed();

    const [first, second] = await Promise.all([
      expireDueAuthorizations(100),
      expireDueAuthorizations(100),
    ]);

    expect([...first.expiredIds, ...second.expiredIds]).toEqual([ids.authorization]);
    expect(state.statements.some((sql) => (
      /FOR UPDATE(?: OF authorization)? SKIP LOCKED/.test(sql)
      && /ORDER BY\s+authorization\.expires_at,\s*authorization\.id/.test(sql)
    ))).toBe(true);
  });

  it('auto-rejects all confirmation surfaces without approving, invoking, or enqueueing', async () => {
    seed({ policy: 'auto_reject', withMcp: true });

    const result = await expireDueAuthorizations(100);

    expect(result).toMatchObject({
      expiredIds: [ids.authorization],
      autoRejectedIds: [ids.authorization],
      escalatedIds: [],
      failedIds: [],
    });
    expect(state.authorizations.get(ids.authorization)?.status).toBe('expired');
    expect(state.checkpoints.get(ids.task)?.status).toBe('rejected');
    expect(state.confirmations.get(ids.call)?.status).toBe('expired');
    expect(state.calls.get(ids.call)?.status).toBe('rejected');
    expect(state.tasks.get(ids.task)?.status).toBe('cancelled');
    expect(state.workflows.get(ids.workflow)?.status).toBe('cancelled');
    expect(state.statements.join('\n')).not.toMatch(/\bapproved\b|beginAction|invokeTool|enqueue/i);
  });

  it('fails the subject with a structured nonretrying error and reconciles artifacts', async () => {
    seed({ policy: 'fail', withMcp: true });

    const result = await expireDueAuthorizations(100);

    expect(result.failedIds).toEqual([ids.authorization]);
    expect(state.tasks.get(ids.task)?.status).toBe('failed');
    expect(state.workflows.get(ids.workflow)?.status).toBe('failed');
    expect(state.tasks.get(ids.task)?.error).toMatchObject({
      code: 'APPROVAL_EXPIRED',
      retryable: false,
    });
    expect(state.calls.get(ids.call)).toMatchObject({
      status: 'failed',
      errorCode: 'APPROVAL_EXPIRED',
    });
    expect(state.artifacts).toEqual([
      expect.objectContaining({ status: 'failed', error: 'Approval expired' }),
    ]);
  });

  it('escalates once for 24 hours with trace-linked owner/admin attention and never approves', async () => {
    seed({ policy: 'escalate' });
    const before = new Date(state.authorizations.get(ids.authorization)!.expires_at).getTime();

    const result = await expireDueAuthorizations(100);

    const authorization = state.authorizations.get(ids.authorization)!;
    expect(result).toMatchObject({
      expiredIds: [],
      escalatedIds: [ids.authorization],
    });
    expect(authorization.status).toBe('awaiting_confirmation');
    expect(authorization.escalation_level).toBe(1);
    expect(new Date(authorization.expires_at).getTime() - before).toBe(86_400_000);
    expect(state.events).toEqual([expect.objectContaining({
      authorizationId: ids.authorization,
      type: 'action.authorization.escalated',
      payload: expect.objectContaining({
        attentionRoles: ['owner', 'admin'],
        traceId: ids.trace,
      }),
    })]);
    expect(state.statements.join('\n')).not.toMatch(/\bapproved\b|enqueue/i);
  });

  it('auto-rejects the second expiry even when policy remains escalate', async () => {
    seed({ policy: 'escalate', level: 1 });

    const result = await expireDueAuthorizations(100);

    expect(result.autoRejectedIds).toEqual([ids.authorization]);
    expect(result.escalatedIds).toEqual([]);
    expect(state.authorizations.get(ids.authorization)?.status).toBe('expired');
  });

  it('preserves cancellation and terminal subject states', async () => {
    seed({
      policy: 'fail',
      taskStatus: 'cancel_requested',
      workflowStatus: 'completed',
    });

    await expireDueAuthorizations(100);

    expect(state.tasks.get(ids.task)?.status).toBe('cancel_requested');
    expect(state.workflows.get(ids.workflow)?.status).toBe('completed');
  });

  it('rolls the transaction back when reconciliation fails mid-row', async () => {
    seed({ policy: 'fail', withMcp: true });
    state.failMarker = 'approval-expiry:call';

    await expect(expireDueAuthorizations(100)).rejects.toThrow('injected mid-row failure');

    expect(state.authorizations.get(ids.authorization)?.status).toBe('awaiting_confirmation');
    expect(state.checkpoints.get(ids.task)?.status).toBe('awaiting_confirmation');
    expect(state.confirmations.get(ids.call)?.status).toBe('pending');
    expect(state.tasks.get(ids.task)?.status).toBe('awaiting_approval');
  });
});

describe('approval expiration scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('runs at startup, skips overlap, isolates errors, and stops without timer leaks', async () => {
    let calls = 0;
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const errors: unknown[] = [];
    const process = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await first;
      else if (calls === 2) throw new Error('scheduler failed token=secret');
      return { expiredIds: [], escalatedIds: [], autoRejectedIds: [], failedIds: [] };
    });

    const scheduler = startApprovalExpiryScheduler({
      intervalMs: 30_000,
      process,
      onError: (error) => errors.push(error),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(process).toHaveBeenCalledTimes(1);

    finishFirst();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(process).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errors)).not.toContain('secret');

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(process).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
