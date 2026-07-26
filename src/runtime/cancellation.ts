import { db, query } from '../db/client.js';
import { runtimeError, serializeRuntimeError } from './errors.js';

export type CancellationSubject = {
  kind: 'task' | 'workflow_run';
  id: string;
};

export type CancellationContext = {
  signal: AbortSignal;
  stop(): void;
  cleanup(): void;
};

type CancellationStatus =
  | 'cancel_requested'
  | 'cancelling'
  | 'cancelled'
  | 'cancelled_with_side_effects';

const cancellationStatuses = new Set<CancellationStatus>([
  'cancel_requested',
  'cancelling',
  'cancelled',
  'cancelled_with_side_effects',
]);

function subjectTable(subject: CancellationSubject) {
  return subject.kind === 'task' ? 'tasks' : 'workflow_runs';
}

export function cancellationError(cause?: unknown) {
  return runtimeError('RUNTIME_CANCELLED', {
    category: 'cancelled',
    retryable: false,
    message: 'Execution was cancelled',
    ...(cause === undefined ? {} : {
      details: { cause: serializeRuntimeError(cause) },
      cause,
    }),
  });
}

export function combineAbortSignals(signals: Array<AbortSignal | null | undefined>) {
  const available = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (available.length === 0) return new AbortController().signal;
  if (available.length === 1) return available[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(available);
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of available) {
    if (signal.aborted) abort(signal);
    else signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

export function combinedAbortSignal(callerSignal: AbortSignal | undefined, timeoutMs: number) {
  return combineAbortSignals([callerSignal, AbortSignal.timeout(timeoutMs)]);
}

export function cancellationRequested(signal?: AbortSignal) {
  return Boolean(signal?.aborted);
}

export async function createCancellationContext(
  subject: CancellationSubject,
  options: { pollIntervalMs?: number } = {},
): Promise<CancellationContext> {
  const controller = new AbortController();
  const intervalMs = Math.min(1_000, Math.max(10, options.pollIntervalMs ?? 500));
  let stopped = false;
  let polling = false;

  const poll = async () => {
    if (stopped || polling || controller.signal.aborted) return;
    polling = true;
    try {
      const table = subjectTable(subject);
      const current = (await query<{ status: string }>(
        `SELECT status FROM ${table} WHERE id=$1`,
        [subject.id],
      )).rows[0]?.status;
      if (current === 'cancel_requested') {
        await query(
          `UPDATE ${table} SET status='cancelling',updated_at=now()
            WHERE id=$1 AND status='cancel_requested' RETURNING status`,
          [subject.id],
        );
        controller.abort(cancellationError());
      } else if (current === 'cancelling' || current === 'cancelled' || current === 'cancelled_with_side_effects') {
        controller.abort(cancellationError());
      }
    } finally {
      polling = false;
    }
  };

  await poll();
  const timer = setInterval(() => {
    void poll().catch(() => undefined);
  }, intervalMs);
  timer.unref();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  return { signal: controller.signal, stop, cleanup: stop };
}

export async function requestCancellation(input: CancellationSubject & {
  workspaceId: string;
  actorId: string;
}) {
  const table = subjectTable(input);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = (await client.query<{
      id: string;
      status: string;
      trace_id: string;
      span_id: string;
      parent_span_id: string | null;
    }>(
      `SELECT id,status,trace_id,span_id,parent_span_id
         FROM ${table} WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [input.id, input.workspaceId],
    )).rows[0];
    if (!current) {
      await client.query('COMMIT');
      return null;
    }
    const eligible = ['queued', 'running', 'awaiting_approval'];
    if (!eligible.includes(current.status) && !cancellationStatuses.has(current.status as CancellationStatus)) {
      await client.query('COMMIT');
      return null;
    }
    let status = current.status;
    if (eligible.includes(current.status)) {
      status = (await client.query<{ status: string }>(
        `UPDATE ${table} SET status='cancel_requested',updated_at=now()
          WHERE id=$1 AND workspace_id=$2 AND status IN ('queued','running','awaiting_approval')
          RETURNING status`,
        [input.id, input.workspaceId],
      )).rows[0]?.status ?? 'cancel_requested';
    }
    if (input.kind === 'task') {
      await client.query(
        `UPDATE action_authorizations SET status='rejected',resolved_by=$1,
                decision_comment='Source task cancellation was requested',resolved_at=now()
          WHERE task_id=$2 AND workspace_id=$3 AND status='awaiting_confirmation'`,
        [input.actorId, input.id, input.workspaceId],
      );
      await client.query(
        `UPDATE task_runtime_checkpoints SET status='failed',updated_at=now()
          WHERE task_id=$1 AND workspace_id=$2 AND status='awaiting_confirmation'`,
        [input.id, input.workspaceId],
      );
      await client.query(
        `UPDATE mcp_tool_confirmations SET status='expired',resolved_by=$1,
                decision_comment='Source task cancellation was requested',resolved_at=now()
          WHERE tool_call_id IN (
            SELECT id FROM mcp_tool_calls WHERE task_id=$2 AND workspace_id=$3
          ) AND status='pending'`,
        [input.actorId, input.id, input.workspaceId],
      );
      await client.query(
        `UPDATE mcp_tool_calls SET status='cancelled',completed_at=now()
          WHERE task_id=$1 AND workspace_id=$2 AND status IN ('pending','awaiting_confirmation')`,
        [input.id, input.workspaceId],
      );
    } else {
      await client.query(
        `UPDATE workflow_approvals SET status='rejected',resolved_by=$1,
                comment='Workflow cancellation was requested',resolved_at=now()
          WHERE workflow_run_id=$2 AND workspace_id=$3 AND status='pending'`,
        [input.actorId, input.id, input.workspaceId],
      );
      await client.query(
        `UPDATE action_authorizations SET status='rejected',resolved_by=$1,
                decision_comment='Workflow cancellation was requested',resolved_at=now()
          WHERE workspace_id=$3 AND status='awaiting_confirmation'
            AND (workflow_run_id=$2 OR task_id IN (
              SELECT id FROM tasks WHERE workflow_run_id=$2 AND workspace_id=$3
            ))`,
        [input.actorId, input.id, input.workspaceId],
      );
      await client.query(
        `UPDATE task_runtime_checkpoints SET status='failed',updated_at=now()
          WHERE workspace_id=$2 AND status='awaiting_confirmation'
            AND task_id IN (SELECT id FROM tasks WHERE workflow_run_id=$1 AND workspace_id=$2)`,
        [input.id, input.workspaceId],
      );
      await client.query(
        `UPDATE tasks SET status='cancel_requested',updated_at=now()
          WHERE workflow_run_id=$1 AND workspace_id=$2
            AND status IN ('queued','running','awaiting_approval')`,
        [input.id, input.workspaceId],
      );
      await client.query(
        `UPDATE mcp_tool_confirmations SET status='expired',resolved_by=$1,
                decision_comment='Workflow cancellation was requested',resolved_at=now()
          WHERE tool_call_id IN (
            SELECT call.id FROM mcp_tool_calls call
            LEFT JOIN tasks task ON task.id=call.task_id
            WHERE call.workspace_id=$3 AND (call.workflow_run_id=$2 OR task.workflow_run_id=$2)
          ) AND status='pending'`,
        [input.actorId, input.id, input.workspaceId],
      );
      await client.query(
        `UPDATE mcp_tool_calls call SET status='cancelled',completed_at=now()
          WHERE call.workspace_id=$2 AND call.status IN ('pending','awaiting_confirmation')
            AND (call.workflow_run_id=$1 OR call.task_id IN (
              SELECT id FROM tasks WHERE workflow_run_id=$1 AND workspace_id=$2
            ))`,
        [input.id, input.workspaceId],
      );
    }
    await client.query('COMMIT');
    return { ...current, status };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeCancellation(subject: CancellationSubject) {
  const sideEffects = (await query<{ side_effects: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM action_authorizations authorization
       WHERE ${
         subject.kind === 'task'
           ? 'authorization.task_id=$1'
           : `(authorization.workflow_run_id=$1 OR authorization.task_id IN (
                SELECT id FROM tasks WHERE workflow_run_id=$1
              ))`
       }
       AND (
         authorization.status IN ('consumed','executing')
         OR authorization.runtime_error->>'code'='ACTION_OUTCOME_UNCERTAIN'
       )
     ) side_effects`,
    [subject.id],
  )).rows[0]?.side_effects ?? true;
  const status: CancellationStatus = sideEffects ? 'cancelled_with_side_effects' : 'cancelled';
  const serialized = serializeRuntimeError(cancellationError());
  const table = subjectTable(subject);
  await query(
    `UPDATE ${table} SET status=$1,error=$2,completed_at=now(),updated_at=now()
      WHERE id=$3 AND status IN ('queued','running','awaiting_approval','cancel_requested','cancelling')
      RETURNING status`,
    [status, JSON.stringify(serialized), subject.id],
  );
  if (subject.kind === 'task') {
    await query(
      "UPDATE artifacts SET status='failed',error_message='Source task was cancelled',updated_at=now() WHERE task_id=$1 AND status='pending'",
      [subject.id],
    );
  } else {
    await query(
      "UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'",
      [subject.id],
    );
  }
  return status;
}
