import { query } from '../db/client.js';
import { actionArgumentHash, limitedActionResult, safeActionSummary } from '../lib/action-safety.js';
import { decryptJsonWithContext, encryptJsonWithContext, type EncryptedPayload } from '../lib/crypto.js';
import type { WorkflowNodeRisk } from '../workflows/registry.js';

export type WorkflowActionAdapter = 'api' | 'mcp' | 'browser';
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
};

type AuthorizationRow = {
  id: string;
  status: 'awaiting_confirmation' | 'approved' | 'executing' | 'rejected' | 'expired' | 'consumed' | 'failed';
  result_summary: unknown;
  encrypted_result: EncryptedPayload | null;
  error_message: string | null;
  expires_at: string;
  workspace_id: string;
  workflow_run_id: string;
};

function resultContext(workspaceId: string, workflowRunId: string, authorizationId: string) {
  return `workflow-action-result:${workspaceId}:${workflowRunId}:${authorizationId}`;
}

export function workflowActionNeedsConfirmation(risk: WorkflowNodeRisk) {
  return risk !== 'read';
}

export async function authorizeWorkflowAction(input: WorkflowActionRequest) {
  const hash = actionArgumentHash(input.arguments);
  const values = [input.workflowRunId, input.nodeId, input.iterationKey, input.attempt, input.adapter, input.resourceId, input.operation, hash];
  const existing = (await query<AuthorizationRow>(
    `SELECT id,status,result_summary,encrypted_result,error_message,expires_at,workspace_id,workflow_run_id
     FROM workflow_action_authorizations
     WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND attempt=$4
       AND adapter=$5 AND resource_id=$6 AND operation=$7 AND arguments_hash=$8
     ORDER BY requested_at DESC LIMIT 1`,
    values,
  )).rows[0];

  if (existing) {
    if (existing.status === 'awaiting_confirmation' && new Date(existing.expires_at).getTime() <= Date.now()) {
      await query("UPDATE workflow_action_authorizations SET status='expired',resolved_at=now() WHERE id=$1 AND status='awaiting_confirmation'", [existing.id]);
      return { status: 'denied' as const, authorizationId: existing.id, reason: 'Action confirmation expired' };
    }
    if (existing.status === 'awaiting_confirmation') return { status: 'awaiting_confirmation' as const, authorizationId: existing.id };
    if (existing.status === 'approved') return { status: 'allowed' as const, authorizationId: existing.id };
    if (existing.status === 'executing') return { status: 'denied' as const, authorizationId: existing.id, reason: 'The previous external action may still be executing. Woody stopped instead of risking a duplicate write.' };
    if (existing.status === 'consumed') {
      const result = existing.encrypted_result
        ? decryptJsonWithContext(existing.encrypted_result, resultContext(existing.workspace_id, existing.workflow_run_id, existing.id)).value
        : existing.result_summary;
      return { status: 'completed' as const, authorizationId: existing.id, result };
    }
    return { status: 'denied' as const, authorizationId: existing.id, reason: existing.error_message ?? `Action was ${existing.status}` };
  }

  const status = workflowActionNeedsConfirmation(input.riskLevel) ? 'awaiting_confirmation' : 'approved';
  let inserted;
  try {
    inserted = await query<{ id: string }>(
      `INSERT INTO workflow_action_authorizations(
         workspace_id,workflow_run_id,node_id,iteration_key,attempt,adapter,resource_id,operation,target_summary,
         risk_level,arguments_summary,arguments_hash,status,requested_by,resolved_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CASE WHEN $13='approved' THEN now() ELSE NULL END)
       RETURNING id`,
      [
        input.workspaceId,
        input.workflowRunId,
        input.nodeId,
        input.iterationKey,
        input.attempt,
        input.adapter,
        input.resourceId,
        input.operation,
        input.targetSummary?.slice(0, 1_000) ?? null,
        input.riskLevel,
        JSON.stringify(safeActionSummary(input.arguments)),
        hash,
        status,
        input.requestedBy,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return authorizeWorkflowAction(input);
    throw error;
  }
  return status === 'approved'
    ? { status: 'allowed' as const, authorizationId: inserted.rows[0].id }
    : { status: 'awaiting_confirmation' as const, authorizationId: inserted.rows[0].id };
}

export async function beginWorkflowAction(authorizationId: string) {
  const claimed = await query<{ id: string }>(
    "UPDATE workflow_action_authorizations SET status='executing' WHERE id=$1 AND status='approved' RETURNING id",
    [authorizationId],
  );
  return Boolean(claimed.rowCount);
}

export async function completeWorkflowAction(authorizationId: string, result: unknown) {
  const authorization = (await query<{ workspace_id: string; workflow_run_id: string }>(
    "SELECT workspace_id,workflow_run_id FROM workflow_action_authorizations WHERE id=$1 AND status='executing'",
    [authorizationId],
  )).rows[0];
  if (!authorization) return;
  const encrypted = encryptJsonWithContext({ value: result }, resultContext(authorization.workspace_id, authorization.workflow_run_id, authorizationId));
  await query(
    `UPDATE workflow_action_authorizations SET status='consumed',result_summary=$1,encrypted_result=$2,consumed_at=now()
     WHERE id=$3 AND status='executing'`,
    [JSON.stringify(limitedActionResult(result)), JSON.stringify(encrypted), authorizationId],
  );
}

export async function failWorkflowAction(authorizationId: string, error: unknown) {
  const message = (error instanceof Error ? error.message : 'External action failed').slice(0, 2_000);
  await query(
    `UPDATE workflow_action_authorizations SET status='failed',error_message=$1,consumed_at=now()
     WHERE id=$2 AND status='executing'`,
    [message, authorizationId],
  );
}
