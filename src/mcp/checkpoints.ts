import { db, query } from '../db/client.js';
import { safeActionSummary } from '../lib/action-safety.js';
import { decryptJsonWithContext, encryptJsonWithContext, type EncryptedPayload } from '../lib/crypto.js';
import type { AuthorizedMcpTool } from './runtime.js';
import { argumentHash, safeArgumentsSummary } from './runtime.js';
import type { TraceContext } from '../runtime/trace.js';

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

export async function pauseForActionConfirmation(input: {
  workspaceId: string;
  taskId: string;
  workflowRunId?: string | null;
  agentId: string;
  requestedBy: string;
  authorizationId: string;
  state: TaskActionCheckpointState;
  mcpTool?: AuthorizedMcpTool;
  trace: TraceContext;
}) {
  const encrypted = encryptJsonWithContext(input.state as unknown as Record<string, unknown>, checkpointContext(input.workspaceId, input.taskId));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let callId: string | null = null;
    if (input.mcpTool) {
      const call = await client.query<{ id: string }>(
        `INSERT INTO mcp_tool_calls(
           workspace_id,connection_id,mcp_tool_id,agent_id,task_id,workflow_run_id,action_authorization_id,status,risk_level,
           arguments_summary,arguments_hash,trace_id,span_id,parent_span_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'awaiting_confirmation',$8,$9,$10,$11,$12,$13) RETURNING id`,
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
        ],
      );
      callId = call.rows[0].id;
      await client.query(
        `INSERT INTO mcp_tool_confirmations(tool_call_id,action_summary,target_summary,requested_by)
         VALUES($1,$2,$3,$4)`,
        [
          callId,
          `${input.mcpTool.title ?? input.mcpTool.remote_name} via ${input.mcpTool.connection_name}`,
          targetSummary(input.state.pending.arguments),
          input.requestedBy,
        ],
      );
    }
    await client.query(
      `INSERT INTO task_runtime_checkpoints(
         task_id,workspace_id,provider,encrypted_state,pending_tool_call_id,pending_action_authorization_id,status
       ) VALUES($1,$2,$3,$4,$5,$6,'awaiting_confirmation')
       ON CONFLICT(task_id) DO UPDATE SET provider=EXCLUDED.provider,encrypted_state=EXCLUDED.encrypted_state,
       pending_tool_call_id=EXCLUDED.pending_tool_call_id,pending_action_authorization_id=EXCLUDED.pending_action_authorization_id,
       status='awaiting_confirmation',updated_at=now()`,
      [input.taskId, input.workspaceId, input.state.provider, JSON.stringify(encrypted), callId, input.authorizationId],
    );
    await client.query(
      `UPDATE tasks SET status='awaiting_approval',updated_at=now() WHERE id=$1 AND workspace_id=$2`,
      [input.taskId, input.workspaceId],
    );
    if (input.workflowRunId) {
      await client.query(
        `UPDATE workflow_runs SET status='awaiting_approval' WHERE id=$1 AND workspace_id=$2`,
        [input.workflowRunId, input.workspaceId],
      );
    }
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
