import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  taskStatus: 'running',
  workflowStatus: 'running',
  sideEffects: false,
  statements: [] as Array<{ sql: string; values: unknown[] }>,
}));

function subjectStatus(sql: string) {
  return sql.includes('workflow_runs') ? state.workflowStatus : state.taskStatus;
}

function setSubjectStatus(sql: string, status: string) {
  if (sql.includes('workflow_runs')) state.workflowStatus = status;
  else state.taskStatus = status;
}

const client = {
  async query(sql: string, values: unknown[] = []) {
    state.statements.push({ sql, values });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rowCount: null, rows: [] };
    if (sql.includes('FOR UPDATE')) {
      return {
        rowCount: 1,
        rows: [{
          id: values[0],
          status: subjectStatus(sql),
          trace_id: '00000000-0000-4000-8000-000000000010',
          span_id: '00000000-0000-4000-8000-000000000011',
          parent_span_id: null,
        }],
      };
    }
    if (sql.includes("SET status='cancel_requested'")) {
      setSubjectStatus(sql, 'cancel_requested');
      return {
        rowCount: 1,
        rows: [{ id: values[0], status: 'cancel_requested' }],
      };
    }
    return { rowCount: 1, rows: [] };
  },
  release() {},
};

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => client) },
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    if (sql.includes('side_effects')) {
      return { rowCount: 1, rows: [{ side_effects: state.sideEffects }] };
    }
    if (sql.includes("SET status='cancelling'")) {
      if (subjectStatus(sql) === 'cancel_requested') {
        setSubjectStatus(sql, 'cancelling');
        return { rowCount: 1, rows: [{ status: 'cancelling' }] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT status')) {
      return { rowCount: 1, rows: [{ status: subjectStatus(sql) }] };
    }
    if (sql.includes('SET status=$1')) {
      setSubjectStatus(sql, String(values[0]));
      return { rowCount: 1, rows: [{ status: values[0] }] };
    }
    return { rowCount: 1, rows: [] };
  }),
}));

import {
  cancellationError,
  createCancellationContext,
  finalizeCancellation,
  requestCancellation,
} from '../src/runtime/cancellation.js';
import { retryDecision, serializeRuntimeError } from '../src/runtime/errors.js';

const task = {
  kind: 'task' as const,
  id: '00000000-0000-4000-8000-000000000001',
};
const workflow = {
  kind: 'workflow_run' as const,
  id: '00000000-0000-4000-8000-000000000002',
};
const actor = {
  workspaceId: '00000000-0000-4000-8000-000000000003',
  actorId: '00000000-0000-4000-8000-000000000004',
};

describe('cooperative distributed cancellation', () => {
  beforeEach(() => {
    state.taskStatus = 'running';
    state.workflowStatus = 'running';
    state.sideEffects = false;
    state.statements = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts active work and transitions the authoritative request to cancelling', async () => {
    vi.useFakeTimers();
    const context = await createCancellationContext(workflow, { pollIntervalMs: 25 });

    const requested = await requestCancellation({ ...workflow, ...actor });
    expect(requested?.status).toBe('cancel_requested');
    await vi.advanceTimersByTimeAsync(25);

    expect(context.signal.aborted).toBe(true);
    expect(state.workflowStatus).toBe('cancelling');
    context.stop();
  });

  it.each([
    { subject: task, cleanupTable: 'task_runtime_checkpoints' },
    { subject: workflow, cleanupTable: 'workflow_approvals' },
  ])('requests $subject.kind cancellation idempotently and resolves approvals', async ({ subject, cleanupTable }) => {
    const first = await requestCancellation({ ...subject, ...actor });
    const second = await requestCancellation({ ...subject, ...actor });

    expect(first?.status).toBe('cancel_requested');
    expect(second?.status).toBe('cancel_requested');
    expect(state.statements.some(({ sql }) => sql.includes(cleanupTable))).toBe(true);
    expect(state.statements.some(({ sql }) => (
      sql.includes('action_authorizations') && sql.includes("status='awaiting_confirmation'")
    ))).toBe(true);
  });

  it.each([
    { sideEffects: false, expected: 'cancelled' },
    { sideEffects: true, expected: 'cancelled_with_side_effects' },
  ] as const)('finalizes conservatively when side effects are $sideEffects', async ({ sideEffects, expected }) => {
    state.taskStatus = 'cancelling';
    state.sideEffects = sideEffects;

    await expect(finalizeCancellation(task)).resolves.toBe(expected);
    expect(state.taskStatus).toBe(expected);
  });

  it('normalizes cancellation as non-retryable without exposing the raw abort error', () => {
    const error = cancellationError(new Error('aborted with token=do-not-persist'));
    const serialized = serializeRuntimeError(error);

    expect(serialized).toMatchObject({
      code: 'RUNTIME_CANCELLED',
      category: 'cancelled',
      retryable: false,
    });
    expect(JSON.stringify(serialized)).not.toContain('do-not-persist');
    expect(retryDecision(error, {
      attempt: 1,
      nodeRetryable: true,
      policy: { maxAttempts: 3, initialDelayMs: 100, multiplier: 2, maxDelayMs: 1_000 },
    })).toMatchObject({ retry: false });
  });
});
