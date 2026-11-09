import { db, query } from '../db/client.js';
import { safeActionSummary } from '../lib/action-safety.js';
import { decryptJsonWithContext, encryptJsonWithContext, type EncryptedPayload } from '../lib/crypto.js';
import type { AuthorizedMcpTool } from './runtime.js';
import { argumentHash, safeArgumentsSummary } from './runtime.js';
import type { TraceContext } from '../runtime/trace.js';
import { redactRuntimeMessage, redactRuntimeValue } from '../runtime/errors.js';
import { cancellationError } from '../runtime/cancellation.js';
import { executionLeaseLost } from '../runtime/leases.js';
import type { PoolClient } from 'pg';

export type TaskActionCheckpointState = {
  provider: 'anthropic' | 'openai-compatible';
  system: string;
  messages: unknown[];
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  nextTurn: number;
  pending: {
    adapter: 'api' | 'mcp';
    toolId: string;
    providerCallId: string;
    arguments: Record<string, unknown>;
    authorizationId: string;
  };
};

export type McpCheckpointState = TaskActionCheckpointState;

function checkpointContext(workspaceId: string, taskId: string) {
  // Keep the original context stable so checkpoints created before this refactor remain decryptable.
  return `mcp-checkpoint:${workspaceId}:${taskId}`;
}

function targetSummary(arguments_: Record<string, unknown>) {
  const safe = safeActionSummary(arguments_);
  return Object.entries(safe).slice(0, 5).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ').slice(0, 1_000) || null;
}

export function sanitizeTaskActionCheckpointState(
  state: TaskActionCheckpointState,
): TaskActionCheckpointState {
  return {
    ...state,
    system: redactRuntimeMessage(state.system),
    messages: redactRuntimeValue(state.messages) as unknown[],
    finalText: redactRuntimeMessage(state.finalText),
    pending: {
      ...state.pending,
      // Pending arguments are encrypted execution input and must remain exact.
      arguments: state.pending.arguments,
      authorizationId: state.pending.authorizationId,
    },
  };
}

type PauseConfirmationInput = {
  workspaceId: string;
  taskId: string;
  workflowRunId?: string | null;
  agentId: string;
  requestedBy: string;
  authorizationId: string;
  state: TaskActionCheckpointState;
  mcpTool?: AuthorizedMcpTool;
  trace: TraceContext;
  leaseOwnerId?: string;
};

type CheckpointClient = PoolClient;

async function assertCheckpointTaskActive(client: CheckpointClient, input: PauseConfirmationInput) {
  const taskReference = (await client.query<{ workflow_run_id: string | null }>(
    'SELECT workflow_run_id FROM tasks WHERE id=$1 AND workspace_id=$2',
    [input.taskId, input.workspaceId],
  )).rows[0];
  if (!taskReference) throw cancellationError();
  if (taskReference.workflow_run_id) {
    const workflowStatus = (await client.query<{ status: string }>(
      'SELECT status FROM workflow_runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
      [taskReference.workflow_run_id, input.workspaceId],
    )).rows[0]?.status;
    if (['cancel_requested', 'cancelling', 'cancelled', 'cancelled_with_side_effects'].includes(String(workflowStatus))) {
      throw cancellationError();
    }
  }
  const taskStatus = (await client.query<{ status: string }>(
    'SELECT status FROM tasks WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
    [input.taskId, input.workspaceId],
  )).rows[0]?.status;
  if (['cancel_requested', 'cancelling', 'cancelled', 'cancelled_with_side_effects'].includes(String(taskStatus))) {
    throw cancellationError();
  }
}

async function createMcpConfirmation(client: CheckpointClient, input: PauseConfirmationInput) {
  if (!input.mcpTool) return null;
  const call = await client.query<{ id: string }>(
    `INSERT INTO mcp_tool_calls(
       workspace_id,connection_id,mcp_tool_id,agent_id,task_id,workflow_run_id,action_authorization_id,status,risk_level,
       arguments_summary,arguments_hash,trace_id,span_id,parent_span_id
     )
     SELECT $1,$2,$3,$4,$5,$6,$7,'awaiting_confirmation',$8,$9,$10,$11,$12,$13
     WHERE (
       $14::text IS NULL
       OR EXISTS(
         SELECT 1 FROM execution_leases
         WHERE subject_type='task' AND subject_id=$5
           AND owner_id=$14 AND expires_at>now()
       )
     )
     RETURNING id`,
    [
      input.workspaceId,
      input.mcpTool.connection_id,
      input.mcpTool.id,
      input.agentId,
      input.taskId,
      input.workflowRunId ?? null,
      input.authorizationId,
      input.mcpTool.risk_level,
      JSON.stringify(safeArgumentsSummary(input.state.pending.arguments)),
      argumentHash(input.state.pending.arguments),
      input.trace.traceId,
      input.trace.spanId,
      input.trace.parentSpanId,
      input.leaseOwnerId ?? null,
    ],
  );
  if (!call.rowCount) throw executionLeaseLost();
  const callId = call.rows[0].id;
  const confirmation = await client.query(
    `INSERT INTO mcp_tool_confirmations(tool_call_id,action_summary,target_summary,requested_by)
     SELECT $1,$2,$3,$4
     WHERE (
       $5::text IS NULL
       OR EXISTS(
         SELECT 1 FROM execution_leases
         WHERE subject_type='task' AND subject_id=$6
           AND owner_id=$5 AND expires_at>now()
       )
     )
     RETURNING id`,
    [
      callId,
      `${input.mcpTool.title ?? input.mcpTool.remote_name} via ${input.mcpTool.connection_name}`,
      targetSummary(input.state.pending.arguments),
      input.requestedBy,
      input.leaseOwnerId ?? null,
      input.taskId,
    ],
  );
  if (!confirmation.rowCount) throw executionLeaseLost();
  return callId;
}

async function saveConfirmationCheckpoint(client: CheckpointClient, input: PauseConfirmationInput, encrypted: EncryptedPayload, callId: string | null) {
  const checkpoint = await client.query(
    `INSERT INTO task_runtime_checkpoints(
       task_id,workspace_id,provider,encrypted_state,pending_tool_call_id,pending_action_authorization_id,status
     )
     SELECT $1,$2,$3,$4,$5,$6,'awaiting_confirmation'
     WHERE (
       $7::text IS NULL
       OR EXISTS(
         SELECT 1 FROM execution_leases
         WHERE subject_type='task' AND subject_id=$1
           AND owner_id=$7 AND expires_at>now()
       )
     )
     ON CONFLICT(task_id) DO UPDATE SET provider=EXCLUDED.provider,encrypted_state=EXCLUDED.encrypted_state,
     pending_tool_call_id=EXCLUDED.pending_tool_call_id,pending_action_authorization_id=EXCLUDED.pending_action_authorization_id,
     status='awaiting_confirmation',updated_at=now()
     WHERE (
       $7::text IS NULL
       OR EXISTS(
         SELECT 1 FROM execution_leases
         WHERE subject_type='task' AND subject_id=$1
           AND owner_id=$7 AND expires_at>now()
       )
     )
     RETURNING task_id`,
    [input.taskId, input.workspaceId, input.state.provider, JSON.stringify(encrypted), callId, input.authorizationId, input.leaseOwnerId ?? null],
  );
  if (!checkpoint.rowCount) throw executionLeaseLost();
}

function assertPauseWrite(rowCount: number | null, leaseOwnerId?: string) {
  if (rowCount) return;
  if (leaseOwnerId) throw executionLeaseLost();
  throw cancellationError();
}

async function pauseCheckpointTask(client: CheckpointClient, input: PauseConfirmationInput) {
  const result = await client.query(
    `UPDATE tasks SET status='awaiting_approval',updated_at=now()
      WHERE id=$1 AND workspace_id=$2
        AND status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
        AND (
          $3::text IS NULL
          OR EXISTS(
            SELECT 1 FROM execution_leases
            WHERE subject_type='task' AND subject_id=$1
              AND owner_id=$3 AND expires_at>now()
          )
        )
      RETURNING id`,
    [input.taskId, input.workspaceId, input.leaseOwnerId ?? null],
  );
  assertPauseWrite(result.rowCount, input.leaseOwnerId);
}

async function pauseCheckpointWorkflow(client: CheckpointClient, input: PauseConfirmationInput) {
  if (!input.workflowRunId) return;
  const result = await client.query(
    `UPDATE workflow_runs SET status='awaiting_approval'
      WHERE id=$1 AND workspace_id=$2
        AND status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
        AND (
          $3::text IS NULL
          OR EXISTS(
            SELECT 1 FROM execution_leases
            WHERE subject_type='task' AND subject_id=$4
              AND owner_id=$3 AND expires_at>now()
          )
        )
      RETURNING id`,
    [input.workflowRunId, input.workspaceId, input.leaseOwnerId ?? null, input.taskId],
  );
  assertPauseWrite(result.rowCount, input.leaseOwnerId);
}

export async function pauseForActionConfirmation(input: PauseConfirmationInput) {
  const sanitizedState = sanitizeTaskActionCheckpointState(input.state);
  const encrypted = encryptJsonWithContext(
    sanitizedState as unknown as Record<string, unknown>,
    checkpointContext(input.workspaceId, input.taskId),
  );
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertCheckpointTaskActive(client, input);
    const callId = await createMcpConfirmation(client, input);
    await saveConfirmationCheckpoint(client, input, encrypted, callId);
    await pauseCheckpointTask(client, input);
    await pauseCheckpointWorkflow(client, input);
    await client.query('COMMIT');
    return { authorizationId: input.authorizationId, toolCallId: callId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function loadTaskActionCheckpoint(workspaceId: string, taskId: string) {
  const result = await query<{
    status: 'approved' | 'rejected';
    encrypted_state: EncryptedPayload;
    pending_tool_call_id: string | null;
    pending_action_authorization_id: string;
  }>(
    `SELECT status,encrypted_state,pending_tool_call_id,pending_action_authorization_id FROM task_runtime_checkpoints
     WHERE task_id=$1 AND workspace_id=$2 AND status IN ('approved','rejected')`,
    [taskId, workspaceId],
  );
  if (!result.rowCount) return null;
  return {
    status: result.rows[0].status,
    callId: result.rows[0].pending_tool_call_id,
    authorizationId: result.rows[0].pending_action_authorization_id,
    state: decryptJsonWithContext(
      result.rows[0].encrypted_state,
      checkpointContext(workspaceId, taskId),
    ) as unknown as TaskActionCheckpointState,
  };
}

export const loadMcpCheckpoint = loadTaskActionCheckpoint;
