import { db } from '../db/client.js';
import type { PoolClient } from 'pg';
import {
  redactRuntimeValue,
  runtimeError,
  serializeRuntimeError,
  type SerializedRuntimeError,
} from './errors.js';

export type ExpirationPolicy = 'auto_reject' | 'fail' | 'escalate';

export function expirationPolicy(value: unknown): ExpirationPolicy {
  return value === 'fail' || value === 'escalate' || value === 'auto_reject'
    ? value
    : 'auto_reject';
}

export type ExpirationResult = {
  expiredIds: string[];
  escalatedIds: string[];
  autoRejectedIds: string[];
  failedIds: string[];
};

type DueAuthorization = {
  id: string;
  workspace_id: string;
  subject_type: 'task' | 'workflow_run';
  task_id: string | null;
  workflow_run_id: string | null;
  on_expiration: ExpirationPolicy;
  escalation_level: number;
  expires_at: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
};

const MAX_BATCH_SIZE = 500;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_INTERVAL_MS = 30_000;

function boundedBatchSize(batchSize: number) {
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new RangeError('Approval expiration batch size must be a positive finite number');
  }
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(batchSize)));
}

function approvalExpiredError(policy: 'auto_reject' | 'fail') {
  return serializeRuntimeError(runtimeError('APPROVAL_EXPIRED', {
    category: policy === 'auto_reject' ? 'cancelled' : 'permanent',
    retryable: false,
    message: 'Approval expired',
    details: { policy },
  }));
}

async function expireAuthorization(
  client: PoolClient,
  authorization: DueAuthorization,
  policy: 'auto_reject' | 'fail',
) {
  const error = approvalExpiredError(policy);
  const errorJson = JSON.stringify(error);
  const expired = await client.query(
    `/* approval-expiry:expire */
     UPDATE action_authorizations
        SET status='expired',
            error_message=$3,
            runtime_error=$2,
            decision_comment=COALESCE(decision_comment,$3),
            resolved_at=now()
      WHERE id=$1
        AND workspace_id=$4
        AND status='awaiting_confirmation'
        AND expires_at<=now()
      RETURNING id`,
    [authorization.id, errorJson, error.message, authorization.workspace_id],
  );
  if (!expired.rowCount) return false;

  const checkpointStatus = policy === 'auto_reject' ? 'rejected' : 'failed';
  const confirmationStatus = 'expired';
  const callStatus = policy === 'auto_reject' ? 'rejected' : 'failed';
  const subjectStatus = policy === 'auto_reject' ? 'cancelled' : 'failed';
  const artifactStatus = policy === 'auto_reject' ? 'skipped' : 'failed';
  const artifactError = policy === 'auto_reject' ? null : error.message;

  await client.query(
    `/* approval-expiry:checkpoint */
     UPDATE task_runtime_checkpoints
        SET status=$2,updated_at=now()
      WHERE pending_action_authorization_id=$1
        AND status='awaiting_confirmation'`,
    [authorization.id, checkpointStatus],
  );
  await client.query(
    `/* approval-expiry:confirmation */
     UPDATE mcp_tool_confirmations confirmation
        SET status=$2,
            decision_comment=COALESCE(decision_comment,$3),
            resolved_at=now()
       FROM mcp_tool_calls call
      WHERE call.action_authorization_id=$1
        AND confirmation.tool_call_id=call.id
        AND confirmation.status='pending'`,
    [authorization.id, confirmationStatus, error.message],
  );
  await client.query(
    `/* approval-expiry:call */
     UPDATE mcp_tool_calls
        SET status=$2,
            error_code=$3,
            error_message=$4,
            runtime_error=$5,
            completed_at=now()
      WHERE action_authorization_id=$1
        AND status='awaiting_confirmation'`,
    [authorization.id, callStatus, error.code, error.message, errorJson],
  );
  await client.query(
    `/* approval-expiry:task */
     UPDATE tasks task
        SET status=$2,error=$3,completed_at=now(),updated_at=now()
       FROM action_authorizations authorization
      WHERE authorization.id=$1
        AND authorization.workspace_id=task.workspace_id
        AND authorization.subject_type='task'
        AND task.id=authorization.task_id
        AND task.status='awaiting_approval'`,
    [authorization.id, subjectStatus, errorJson],
  );
  await client.query(
    `/* approval-expiry:workflow */
     UPDATE workflow_runs run
        SET status=$2,error=$3,output=$4,completed_at=now(),updated_at=now()
       FROM action_authorizations authorization
       LEFT JOIN tasks task ON task.id=authorization.task_id
      WHERE authorization.id=$1
        AND run.workspace_id=authorization.workspace_id
        AND run.id=COALESCE(authorization.workflow_run_id,task.workflow_run_id)
        AND run.status='awaiting_approval'`,
    [authorization.id, subjectStatus, errorJson, JSON.stringify({ error })],
  );
  await client.query(
    `/* approval-expiry:artifacts */
     UPDATE artifacts artifact
        SET status=$2,error_message=$3,updated_at=now()
       FROM action_authorizations authorization
       LEFT JOIN tasks task ON task.id=authorization.task_id
      WHERE authorization.id=$1
        AND artifact.status='pending'
        AND (
          artifact.task_id=authorization.task_id
          OR artifact.workflow_run_id=COALESCE(authorization.workflow_run_id,task.workflow_run_id)
        )`,
    [authorization.id, artifactStatus, artifactError],
  );
  return true;
}

async function escalateAuthorization(
  client: PoolClient,
  authorization: DueAuthorization,
) {
  const escalated = await client.query(
    `/* approval-expiry:escalate */
     UPDATE action_authorizations
        SET escalation_level=1,
            escalated_at=now(),
            expires_at=expires_at+interval '24 hours'
      WHERE id=$1
        AND workspace_id=$2
        AND status='awaiting_confirmation'
        AND on_expiration='escalate'
        AND escalation_level=0
        AND expires_at<=now()
      RETURNING id`,
    [authorization.id, authorization.workspace_id],
  );
  if (!escalated.rowCount) return false;

  const payload = JSON.stringify(redactRuntimeValue({
    authorizationId: authorization.id,
    attentionRoles: ['owner', 'admin'],
    escalationLevel: 1,
    traceId: authorization.trace_id,
  }));
  if (authorization.subject_type === 'task') {
    await client.query(
      `/* approval-expiry:event */
       INSERT INTO task_events(
         workspace_id,task_id,event_type,message,payload,trace_id,span_id,parent_span_id
       )
       SELECT authorization.workspace_id,authorization.task_id,$2,
              'Action confirmation expired and requires owner or admin attention',$3,
              COALESCE(authorization.trace_id,task.trace_id),gen_random_uuid(),
              COALESCE(authorization.span_id,task.span_id)
         FROM action_authorizations authorization
         JOIN tasks task ON task.id=authorization.task_id
        WHERE authorization.id=$1
          AND authorization.workspace_id=$4
          AND authorization.status='awaiting_confirmation'
          AND authorization.escalation_level=1
       RETURNING id`,
      [authorization.id, 'action.authorization.escalated', payload, authorization.workspace_id],
    );
  } else {
    await client.query(
      `/* approval-expiry:event */
       INSERT INTO workflow_run_events(
         workspace_id,workflow_run_id,node_id,event_type,message,payload,trace_id,span_id,parent_span_id
       )
       SELECT authorization.workspace_id,authorization.workflow_run_id,authorization.node_id,$2,
              'Action confirmation expired and requires owner or admin attention',$3,
              COALESCE(authorization.trace_id,run.trace_id),gen_random_uuid(),
              COALESCE(authorization.span_id,run.span_id)
         FROM action_authorizations authorization
         JOIN workflow_runs run ON run.id=authorization.workflow_run_id
        WHERE authorization.id=$1
          AND authorization.workspace_id=$4
          AND authorization.status='awaiting_confirmation'
          AND authorization.escalation_level=1
       RETURNING id`,
      [authorization.id, 'action.authorization.escalated', payload, authorization.workspace_id],
    );
  }
  return true;
}

export async function expireDueAuthorizations(
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ExpirationResult> {
  const limit = boundedBatchSize(batchSize);
  const client = await db.connect();
  const expiredIds: string[] = [];
  const escalatedIds: string[] = [];
  const autoRejectedIds: string[] = [];
  const failedIds: string[] = [];
  try {
    await client.query('BEGIN');
    const due = await client.query<DueAuthorization>(
      `/* approval-expiry:claim */
       SELECT authorization.id,authorization.workspace_id,authorization.subject_type,
              authorization.task_id,authorization.workflow_run_id,
              authorization.on_expiration,authorization.escalation_level,
              authorization.expires_at,authorization.trace_id,
              authorization.span_id,authorization.parent_span_id
         FROM action_authorizations authorization
        WHERE authorization.status='awaiting_confirmation'
          AND authorization.expires_at<=now()
        ORDER BY authorization.expires_at,authorization.id
        LIMIT $1
        FOR UPDATE OF authorization SKIP LOCKED`,
      [limit],
    );
    for (const authorization of due.rows) {
      const policy = authorization.on_expiration === 'escalate'
        && authorization.escalation_level === 0
        ? 'escalate'
        : authorization.on_expiration === 'fail'
          ? 'fail'
          : 'auto_reject';
      if (policy === 'escalate') {
        if (await escalateAuthorization(client, authorization)) {
          escalatedIds.push(authorization.id);
        }
        continue;
      }
      if (!await expireAuthorization(client, authorization, policy)) continue;
      expiredIds.push(authorization.id);
      if (policy === 'fail') failedIds.push(authorization.id);
      else autoRejectedIds.push(authorization.id);
    }
    await client.query('COMMIT');
    return { expiredIds, escalatedIds, autoRejectedIds, failedIds };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type ApprovalExpiryScheduler = {
  stop(): void;
};

export function startApprovalExpiryScheduler(options: {
  batchSize?: number;
  intervalMs?: number;
  process?: (batchSize: number) => Promise<ExpirationResult>;
  onError?: (error: SerializedRuntimeError) => void;
} = {}): ApprovalExpiryScheduler {
  const batchSize = boundedBatchSize(options.batchSize ?? DEFAULT_BATCH_SIZE);
  const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? DEFAULT_INTERVAL_MS));
  const process = options.process ?? expireDueAuthorizations;
  const onError = options.onError ?? ((error) => {
    console.error('Approval expiration scheduler failed', { error });
  });
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await process(batchSize);
    } catch (error) {
      onError(serializeRuntimeError(error));
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => {
    void run();
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
