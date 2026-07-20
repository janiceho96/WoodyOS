import { db, query } from '../db/client.js';
import { decryptJsonWithContext, encryptJsonWithContext, type EncryptedPayload } from '../lib/crypto.js';
import type { AuthorizedMcpTool } from './runtime.js';
import { argumentHash, safeArgumentsSummary } from './runtime.js';

export type McpCheckpointState = {
  provider: 'anthropic' | 'openai-compatible';
  system: string;
  messages: unknown[];
  finalText: string;
  inputTokens: number;
  outputTokens: number;
  toolCallCount: number;
  nextTurn: number;
  pending: {
    toolId: string;
    providerCallId: string;
    arguments: Record<string, unknown>;
  };
};

function checkpointContext(workspaceId: string, taskId: string) {
  return `mcp-checkpoint:${workspaceId}:${taskId}`;
}

function targetSummary(arguments_: Record<string, unknown>) {
  const safe = safeArgumentsSummary(arguments_);
  return Object.entries(safe).slice(0, 5).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ').slice(0, 1_000) || null;
}

export async function pauseForMcpConfirmation(input: {
  workspaceId: string;
  taskId: string;
  workflowRunId?: string | null;
  agentId: string;
  requestedBy: string;
  tool: AuthorizedMcpTool;
  state: McpCheckpointState;
}) {
  const encrypted = encryptJsonWithContext(input.state as unknown as Record<string, unknown>, checkpointContext(input.workspaceId, input.taskId));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const call = await client.query<{ id: string }>(
      `INSERT INTO mcp_tool_calls(
         workspace_id,connection_id,mcp_tool_id,agent_id,task_id,workflow_run_id,status,risk_level,
         arguments_summary,arguments_hash
       ) VALUES($1,$2,$3,$4,$5,$6,'awaiting_confirmation',$7,$8,$9) RETURNING id`,
      [
        input.workspaceId,
        input.tool.connection_id,
        input.tool.id,
        input.agentId,
        input.taskId,
        input.workflowRunId ?? null,
        input.tool.risk_level,
        JSON.stringify(safeArgumentsSummary(input.state.pending.arguments)),
        argumentHash(input.state.pending.arguments),
      ],
    );
    const callId = call.rows[0].id;
    await client.query(
      `INSERT INTO mcp_tool_confirmations(tool_call_id,action_summary,target_summary,requested_by)
       VALUES($1,$2,$3,$4)`,
      [
        callId,
        `${input.tool.title ?? input.tool.remote_name} via ${input.tool.connection_name}`,
        targetSummary(input.state.pending.arguments),
        input.requestedBy,
      ],
    );
    await client.query(
      `INSERT INTO task_runtime_checkpoints(
         task_id,workspace_id,provider,encrypted_state,pending_tool_call_id,status
       ) VALUES($1,$2,$3,$4,$5,'awaiting_confirmation')
       ON CONFLICT(task_id) DO UPDATE SET provider=EXCLUDED.provider,encrypted_state=EXCLUDED.encrypted_state,
       pending_tool_call_id=EXCLUDED.pending_tool_call_id,status='awaiting_confirmation',updated_at=now()`,
      [input.taskId, input.workspaceId, input.state.provider, JSON.stringify(encrypted), callId],
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
    return callId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function loadMcpCheckpoint(workspaceId: string, taskId: string) {
  const result = await query<{
    status: 'approved' | 'rejected';
    encrypted_state: EncryptedPayload;
    pending_tool_call_id: string;
  }>(
    `SELECT status,encrypted_state,pending_tool_call_id FROM task_runtime_checkpoints
     WHERE task_id=$1 AND workspace_id=$2 AND status IN ('approved','rejected')`,
    [taskId, workspaceId],
  );
  if (!result.rowCount) return null;
  return {
    status: result.rows[0].status,
    callId: result.rows[0].pending_tool_call_id,
    state: decryptJsonWithContext(
      result.rows[0].encrypted_state,
      checkpointContext(workspaceId, taskId),
    ) as unknown as McpCheckpointState,
  };
}
