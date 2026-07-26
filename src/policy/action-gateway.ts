import { query } from '../db/client.js';
import { actionArgumentHash, limitedActionResult, safeActionSummary } from '../lib/action-safety.js';
import { decryptJsonWithContext, encryptJsonWithContext, type EncryptedPayload } from '../lib/crypto.js';
import type { WorkflowNodeRisk } from '../workflows/registry.js';
import { serializeRuntimeError } from '../runtime/errors.js';
import { assertFencedMutation, type ExecutionLeaseContext } from '../runtime/leases.js';
import type { TraceContext } from '../runtime/trace.js';
import type { ExpirationPolicy } from '../runtime/approval-expiry.js';

export type ActionAdapter = 'api' | 'mcp' | 'browser';
export type ActionSubject =
  | {
    type: 'workflow_run';
    workflowRunId: string;
    nodeId: string;
    iterationKey: string;
    attempt: number;
  }
  | {
    type: 'task';
    taskId: string;
    agentId: string;
  };

export type ActionRequest = {
  workspaceId: string;
  subject: ActionSubject;
  actionKey: string;
  adapter: ActionAdapter;
  resourceId: string;
  operation: string;
  riskLevel: WorkflowNodeRisk;
  arguments: Record<string, unknown>;
  requestedBy: string;
  targetSummary?: string | null;
  onExpiration?: ExpirationPolicy;
  leaseOwnerId?: string;
  trace: TraceContext;
};

export type WorkflowActionAdapter = ActionAdapter;
export type WorkflowActionIdentity = {
  workspaceId: string;
  workflowRunId: string;
  nodeId: string;
  iterationKey: string;
  attempt: number;
  adapter: WorkflowActionAdapter;
  resourceId: string;
  operation: string;
};
export type WorkflowActionRequest = WorkflowActionIdentity & {
  riskLevel: WorkflowNodeRisk;
  arguments: Record<string, unknown>;
  requestedBy: string;
  targetSummary?: string | null;
  onExpiration?: ExpirationPolicy;
  leaseOwnerId?: string;
  trace: TraceContext;
  precedingApproval?: {
    nodeId: string;
    iterationKey: string;
  };
};

type AuthorizationRow = {
  id: string;
  status: 'awaiting_confirmation' | 'approved' | 'executing' | 'rejected' | 'expired' | 'consumed' | 'failed';
  result_summary: unknown;
  encrypted_result: EncryptedPayload | null;
  error_message: string | null;
  expires_at: string;
  workspace_id: string;
  subject_type: 'workflow_run' | 'task';
  workflow_run_id: string | null;
  task_id: string | null;
};

function resultContext(row: Pick<AuthorizationRow, 'workspace_id' | 'subject_type' | 'workflow_run_id' | 'task_id' | 'id'>) {
  if (row.subject_type === 'workflow_run') return `workflow-action-result:${row.workspace_id}:${row.workflow_run_id}:${row.id}`;
  return `task-action-result:${row.workspace_id}:${row.task_id}:${row.id}`;
}

export function actionNeedsConfirmation(risk: WorkflowNodeRisk) {
  return risk !== 'read';
}

export const workflowActionNeedsConfirmation = actionNeedsConfirmation;

function subjectColumns(subject: ActionSubject) {
  return subject.type === 'workflow_run'
    ? {
      workflowRunId: subject.workflowRunId,
      taskId: null,
      agentId: null,
      nodeId: subject.nodeId,
      iterationKey: subject.iterationKey,
      attempt: subject.attempt,
    }
    : {
      workflowRunId: null,
      taskId: subject.taskId,
      agentId: subject.agentId,
      nodeId: null,
      iterationKey: null,
      attempt: null,
    };
}

async function subjectAllowsActions(input: Pick<ActionRequest, 'workspaceId' | 'subject' | 'leaseOwnerId'>) {
  const result = input.subject.type === 'task'
    ? await query<{ subject_allows_actions: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM tasks WHERE id=$1 AND workspace_id=$2
           AND status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
           AND (
             $3::text IS NULL
             OR EXISTS(
               SELECT 1 FROM execution_leases lease
               WHERE lease.subject_type='task' AND lease.subject_id=$1
                 AND lease.owner_id=$3 AND lease.expires_at>now()
             )
           )
       ) subject_allows_actions`,
      [input.subject.taskId, input.workspaceId, input.leaseOwnerId ?? null],
    )
    : await query<{ subject_allows_actions: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM workflow_runs WHERE id=$1 AND workspace_id=$2
           AND status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
           AND (
             $3::text IS NULL
             OR EXISTS(
               SELECT 1 FROM execution_leases lease
               WHERE lease.subject_type='workflow_run' AND lease.subject_id=$1
                 AND lease.owner_id=$3 AND lease.expires_at>now()
             )
           )
       ) subject_allows_actions`,
      [input.subject.workflowRunId, input.workspaceId, input.leaseOwnerId ?? null],
    );
  return result.rows[0]?.subject_allows_actions !== false;
}

async function authorizeActionWithTrust(input: ActionRequest, precedingApprovalSatisfied = false) {
  if (!(await subjectAllowsActions(input))) {
    return {
      status: 'denied' as const,
      authorizationId: null,
      reason: 'Execution cancellation has been requested',
    };
  }
  const hash = actionArgumentHash(input.arguments);
  const subject = subjectColumns(input.subject);
  const existing = (await query<AuthorizationRow>(
    `SELECT id,status,result_summary,encrypted_result,error_message,expires_at,workspace_id,subject_type,workflow_run_id,task_id
     FROM action_authorizations
     WHERE subject_type=$1
       AND workflow_run_id IS NOT DISTINCT FROM $2::uuid
       AND task_id IS NOT DISTINCT FROM $3::uuid
       AND action_key=$4 AND adapter=$5 AND resource_id=$6 AND operation=$7 AND arguments_hash=$8
     ORDER BY requested_at DESC LIMIT 1`,
    [input.subject.type, subject.workflowRunId, subject.taskId, input.actionKey, input.adapter, input.resourceId, input.operation, hash],
  )).rows[0];

  if (existing) {
    if (existing.status === 'awaiting_confirmation' && new Date(existing.expires_at).getTime() <= Date.now()) {
      return { status: 'denied' as const, authorizationId: existing.id, reason: 'Action confirmation expired' };
    }
    if (existing.status === 'awaiting_confirmation') return { status: 'awaiting_confirmation' as const, authorizationId: existing.id };
    if (existing.status === 'approved') return { status: 'allowed' as const, authorizationId: existing.id };
    if (existing.status === 'executing') return { status: 'denied' as const, authorizationId: existing.id, reason: 'The previous external action may still be executing. Woody stopped instead of risking a duplicate write.' };
    if (existing.status === 'consumed') {
      const result = existing.encrypted_result
        ? decryptJsonWithContext(existing.encrypted_result, resultContext(existing)).value
        : existing.result_summary;
      return { status: 'completed' as const, authorizationId: existing.id, result };
    }
    return { status: 'denied' as const, authorizationId: existing.id, reason: existing.error_message ?? `Action was ${existing.status}` };
  }

  const status = actionNeedsConfirmation(input.riskLevel) && !precedingApprovalSatisfied
    ? 'awaiting_confirmation'
    : 'approved';
  let inserted;
  try {
    inserted = await query<{ id: string }>(
      `INSERT INTO action_authorizations(
         workspace_id,subject_type,workflow_run_id,task_id,agent_id,node_id,iteration_key,attempt,action_key,
         adapter,resource_id,operation,target_summary,risk_level,arguments_summary,arguments_hash,status,requested_by,resolved_at,
         trace_id,span_id,parent_span_id,on_expiration
       ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                CASE WHEN $17='approved' THEN now() ELSE NULL END,$19,$20,$21,$22
         WHERE (
           (
             $2='task'
             AND EXISTS(
               SELECT 1 FROM tasks task
               WHERE task.id=$4 AND task.workspace_id=$1
                 AND task.status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
                 AND (
                   $23::text IS NULL
                   OR EXISTS(
                     SELECT 1 FROM execution_leases lease
                     WHERE lease.subject_type='task' AND lease.subject_id=$4
                       AND lease.owner_id=$23 AND lease.expires_at>now()
                   )
                 )
             )
           )
           OR (
             $2='workflow_run'
             AND EXISTS(
               SELECT 1 FROM workflow_runs run
               WHERE run.id=$3 AND run.workspace_id=$1
                 AND run.status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
                 AND (
                   $23::text IS NULL
                   OR EXISTS(
                     SELECT 1 FROM execution_leases lease
                     WHERE lease.subject_type='workflow_run' AND lease.subject_id=$3
                       AND lease.owner_id=$23 AND lease.expires_at>now()
                   )
                 )
             )
           )
         )
       RETURNING id`,
      [
        input.workspaceId,
        input.subject.type,
        subject.workflowRunId,
        subject.taskId,
        subject.agentId,
        subject.nodeId,
        subject.iterationKey,
        subject.attempt,
        input.actionKey.slice(0, 500),
        input.adapter,
        input.resourceId,
        input.operation.slice(0, 500),
        input.targetSummary?.slice(0, 1_000) ?? null,
        input.riskLevel,
        JSON.stringify(safeActionSummary(input.arguments)),
        hash,
        status,
        input.requestedBy,
        input.trace.traceId,
        input.trace.spanId,
        input.trace.parentSpanId,
        input.onExpiration ?? 'auto_reject',
        input.leaseOwnerId ?? null,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return authorizeActionWithTrust(input, precedingApprovalSatisfied);
    }
    throw error;
  }
  if (!inserted.rowCount) {
    return {
      status: 'denied' as const,
      authorizationId: null,
      reason: 'Execution cancellation has been requested',
    };
  }
  return status === 'approved'
    ? { status: 'allowed' as const, authorizationId: inserted.rows[0].id }
    : { status: 'awaiting_confirmation' as const, authorizationId: inserted.rows[0].id };
}

export function authorizeAction(input: ActionRequest) {
  return authorizeActionWithTrust(input);
}

export function authorizeWorkflowAction(input: WorkflowActionRequest) {
  const precedingApprovalSatisfied = Boolean(
    input.precedingApproval
    && input.precedingApproval.iterationKey === input.iterationKey,
  );
  return authorizeActionWithTrust({
    workspaceId: input.workspaceId,
    subject: {
      type: 'workflow_run',
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      iterationKey: input.iterationKey,
      attempt: input.attempt,
    },
    actionKey: `${input.nodeId}:${input.iterationKey}:${input.attempt}`,
    adapter: input.adapter,
    resourceId: input.resourceId,
    operation: input.operation,
    riskLevel: input.riskLevel,
    arguments: input.arguments,
    requestedBy: input.requestedBy,
    targetSummary: input.targetSummary,
    onExpiration: input.onExpiration,
    leaseOwnerId: input.leaseOwnerId,
    trace: input.trace,
  }, precedingApprovalSatisfied);
}

export async function beginAction(authorizationId: string, leaseOwnerId?: string) {
  const claimed = await query<{ id: string }>(
    `UPDATE action_authorizations authorization SET status='executing'
      WHERE authorization.id=$1 AND authorization.status='approved'
        AND (
          (
            authorization.subject_type='task'
            AND EXISTS(
              SELECT 1 FROM tasks task
              WHERE task.id=authorization.task_id
                AND task.status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
                AND (
                  $2::text IS NULL
                  OR EXISTS(
                    SELECT 1 FROM execution_leases lease
                    WHERE lease.subject_type='task' AND lease.subject_id=task.id
                      AND lease.owner_id=$2 AND lease.expires_at>now()
                  )
                )
            )
          )
          OR (
            authorization.subject_type='workflow_run'
            AND EXISTS(
              SELECT 1 FROM workflow_runs run
              WHERE run.id=authorization.workflow_run_id
                AND run.status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
                AND (
                  $2::text IS NULL
                  OR EXISTS(
                    SELECT 1 FROM execution_leases lease
                    WHERE lease.subject_type='workflow_run' AND lease.subject_id=run.id
                      AND lease.owner_id=$2 AND lease.expires_at>now()
                  )
                )
            )
          )
        )
      RETURNING authorization.id`,
    [authorizationId, leaseOwnerId ?? null],
  );
  return Boolean(claimed.rowCount);
}

export const beginWorkflowAction = beginAction;

function authorizationLeaseContext(
  authorization: Pick<AuthorizationRow, 'subject_type' | 'task_id' | 'workflow_run_id'>,
  ownerId: string | undefined,
): ExecutionLeaseContext | undefined {
  if (!ownerId) return undefined;
  const id = authorization.subject_type === 'task'
    ? authorization.task_id
    : authorization.workflow_run_id;
  return id ? { subject: { kind: authorization.subject_type, id }, ownerId } : undefined;
}

export async function completeAction(authorizationId: string, result: unknown, leaseOwnerId?: string) {
  const authorization = (await query<AuthorizationRow>(
    `SELECT id,workspace_id,subject_type,workflow_run_id,task_id,status,result_summary,encrypted_result,error_message,expires_at
     FROM action_authorizations WHERE id=$1 AND status='executing'`,
    [authorizationId],
  )).rows[0];
  if (!authorization) return;
  const encrypted = encryptJsonWithContext({ value: result }, resultContext(authorization));
  const settled = await query(
    `UPDATE action_authorizations SET status='consumed',result_summary=$1,encrypted_result=$2,consumed_at=now()
     WHERE id=$3 AND status='executing'
       AND (
         $4::text IS NULL
         OR EXISTS(
           SELECT 1 FROM execution_leases lease
           WHERE lease.subject_type=action_authorizations.subject_type
             AND lease.subject_id=COALESCE(action_authorizations.task_id,action_authorizations.workflow_run_id)
             AND lease.owner_id=$4 AND lease.expires_at>now()
         )
       )
     RETURNING id`,
    [JSON.stringify(limitedActionResult(result)), JSON.stringify(encrypted), authorizationId, leaseOwnerId ?? null],
  );
  await assertFencedMutation(settled.rowCount, authorizationLeaseContext(authorization, leaseOwnerId));
}

export const completeWorkflowAction = completeAction;

export async function failAction(authorizationId: string, error: unknown, leaseOwnerId?: string) {
  const serialized = serializeRuntimeError(error);
  const authorization = leaseOwnerId
    ? (await query<AuthorizationRow>(
      `SELECT id,workspace_id,subject_type,workflow_run_id,task_id,status,result_summary,encrypted_result,error_message,expires_at
       FROM action_authorizations WHERE id=$1`,
      [authorizationId],
    )).rows[0]
    : undefined;
  const settled = await query(
    `UPDATE action_authorizations
        SET status='failed',error_message=$1,runtime_error=$2,consumed_at=now()
      WHERE id=$3 AND status='executing'
        AND (
          $4::text IS NULL
          OR EXISTS(
            SELECT 1 FROM execution_leases lease
            WHERE lease.subject_type=action_authorizations.subject_type
              AND lease.subject_id=COALESCE(action_authorizations.task_id,action_authorizations.workflow_run_id)
              AND lease.owner_id=$4 AND lease.expires_at>now()
          )
        )
      RETURNING id`,
    [serialized.message, JSON.stringify(serialized), authorizationId, leaseOwnerId ?? null],
  );
  await assertFencedMutation(
    settled.rowCount,
    authorization ? authorizationLeaseContext(authorization, leaseOwnerId) : undefined,
  );
}

export const failWorkflowAction = failAction;
