import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { asyncRoute, parse } from '../../lib/http.js';
import { enqueueTask } from '../../queue/task-queue.js';
import {
  assertTaskManifestDependencies,
  assertWorkflowManifestDependencies,
} from '../../runtime/manifest.js';
import type { WorkflowDefinition } from '../../workflows/definition.js';
import { serializeRuntimeError } from '../../runtime/errors.js';
import { authoritativeTraceContext } from '../../runtime/trace.js';
import type { PoolClient } from 'pg';

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  status: z.string().max(100).optional(),
  connectionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const decisionInput = z.object({
  decision: z.enum(['approved', 'rejected']),
  comment: z.string().max(2_000).optional(),
});

type McpDecision = {
  id: string;
  workspaceId: string;
  userId: string;
  decision: 'approved' | 'rejected';
  comment?: string;
};

type PendingMcpDecision = {
  task_id: string;
  agent_id: string;
  workflow_run_id: string | null;
  run_mode: 'test' | 'production' | null;
  workflow_version_id: string | null;
  definition_snapshot: WorkflowDefinition | null;
  action_authorization_id: string | null;
  execution_manifest: unknown;
  run_execution_manifest: unknown;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
};

async function lockLinkedAuthorization(client: PoolClient, input: McpDecision) {
  const linked = await client.query<{ action_authorization_id: string | null }>(
    'SELECT action_authorization_id FROM mcp_tool_calls WHERE id=$1 AND workspace_id=$2',
    [input.id, input.workspaceId],
  );
  const authorizationId = linked.rows[0]?.action_authorization_id ?? null;
  if (!authorizationId) return { valid: true, authorizationId: null };
  const locked = await client.query(
    `SELECT id FROM action_authorizations
     WHERE id=$1 AND workspace_id=$2 AND status='awaiting_confirmation' AND expires_at>now()
     FOR UPDATE`,
    [authorizationId, input.workspaceId],
  );
  return { valid: Boolean(locked.rowCount), authorizationId };
}

async function lockPendingMcpDecision(client: PoolClient, input: McpDecision, authorizationId: string | null) {
  const pending = await client.query<PendingMcpDecision>(
    `SELECT calls.task_id,tasks.agent_id,calls.workflow_run_id,run.run_mode,
            run.workflow_version_id,run.definition_snapshot,
            calls.action_authorization_id,tasks.execution_manifest,
            run.execution_manifest run_execution_manifest,tasks.trace_id,
            tasks.span_id,tasks.parent_span_id
     FROM mcp_tool_calls calls JOIN mcp_tool_confirmations confirmation ON confirmation.tool_call_id=calls.id
     JOIN tasks ON tasks.id=calls.task_id
     LEFT JOIN workflow_runs run ON run.id=tasks.workflow_run_id
     WHERE calls.id=$1 AND calls.workspace_id=$2 AND calls.status='awaiting_confirmation'
     AND calls.action_authorization_id IS NOT DISTINCT FROM $3::uuid
     AND confirmation.status='pending' AND confirmation.expires_at > now()
     FOR UPDATE OF calls,confirmation,tasks`,
    [input.id, input.workspaceId, authorizationId],
  );
  const row = pending.rows[0];
  return row?.task_id ? row : null;
}

async function assertMcpDecisionDependencies(client: PoolClient, input: McpDecision, pending: PendingMcpDecision) {
  if (pending.run_mode === 'test') return;
  if (pending.workflow_run_id && pending.workflow_version_id && pending.definition_snapshot) {
    await assertWorkflowManifestDependencies({
      workspaceId: input.workspaceId,
      workflowVersionId: pending.workflow_version_id,
      definition: pending.definition_snapshot,
      manifest: pending.run_execution_manifest,
    }, client);
    return;
  }
  await assertTaskManifestDependencies({
    workspaceId: input.workspaceId,
    agentId: pending.agent_id,
    manifest: pending.execution_manifest,
  }, client);
}

async function writeMcpDecision(client: PoolClient, input: McpDecision, pending: PendingMcpDecision) {
  const authorizationId = pending.action_authorization_id;
  if (authorizationId) {
    const authorizationUpdated = await client.query(
      `UPDATE action_authorizations SET status=$1,resolved_by=$2,decision_comment=$3,resolved_at=now()
       WHERE id=$4 AND workspace_id=$5 AND status='awaiting_confirmation' AND expires_at>now()
       RETURNING id`,
      [input.decision, input.userId, input.comment ?? null, authorizationId, input.workspaceId],
    );
    if (authorizationUpdated.rowCount !== 1) return false;
  }
  await client.query(
    `UPDATE mcp_tool_confirmations SET status=$1,resolved_by=$2,decision_comment=$3,resolved_at=now()
     WHERE tool_call_id=$4 AND status='pending'`,
    [input.decision, input.userId, input.comment ?? null, input.id],
  );
  await client.query(
    `UPDATE mcp_tool_calls SET status=$1,completed_at=CASE WHEN $1='rejected' THEN now() ELSE NULL END
     WHERE id=$2 AND workspace_id=$3 AND status='awaiting_confirmation'`,
    [input.decision === 'approved' ? 'pending' : 'rejected', input.id, input.workspaceId],
  );
  await client.query(
    `UPDATE task_runtime_checkpoints SET status=$1,updated_at=now()
     WHERE task_id=$2 AND pending_tool_call_id=$3 AND status='awaiting_confirmation'`,
    [input.decision, pending.task_id, input.id],
  );
  await client.query(
    `UPDATE tasks SET status='queued',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status='awaiting_approval'`,
    [pending.task_id, input.workspaceId],
  );
  return true;
}

async function applyMcpDecision(input: McpDecision) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const linked = await lockLinkedAuthorization(client, input);
    if (!linked.valid) {
      await client.query('ROLLBACK');
      return null;
    }
    const pending = await lockPendingMcpDecision(client, input, linked.authorizationId);
    if (!pending) {
      await client.query('ROLLBACK');
      return null;
    }
    await assertMcpDecisionDependencies(client, input, pending);
    if (!await writeMcpDecision(client, input, pending)) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');
    return {
      taskId: pending.task_id,
      workflowRunId: pending.workflow_run_id,
      traceId: authoritativeTraceContext(pending).traceId,
      linkedAuthorizationId: linked.authorizationId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function restoreMcpDecisionAfterQueueFailure(input: McpDecision, taskId: string, linkedAuthorizationId: string | null) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (linkedAuthorizationId) {
      const authorizationRestored = await client.query(
        `UPDATE action_authorizations SET status='awaiting_confirmation',
                resolved_by=NULL,decision_comment=NULL,resolved_at=NULL
          WHERE id=$1 AND workspace_id=$2 AND status=$3
          RETURNING id`,
        [linkedAuthorizationId, input.workspaceId, input.decision],
      );
      if (authorizationRestored.rowCount !== 1) {
        throw new Error('Unable to restore linked action authorization after enqueue failure');
      }
    }
    await client.query(
      `UPDATE mcp_tool_confirmations SET status='pending',
              resolved_by=NULL,decision_comment=NULL,resolved_at=NULL
        WHERE tool_call_id=$1 AND status=$2`,
      [input.id, input.decision],
    );
    await client.query(
      `UPDATE mcp_tool_calls SET status='awaiting_confirmation',completed_at=NULL
        WHERE id=$1 AND status=$2`,
      [input.id, input.decision === 'approved' ? 'pending' : 'rejected'],
    );
    await client.query(
      `UPDATE task_runtime_checkpoints SET status='awaiting_confirmation',updated_at=now()
        WHERE task_id=$1 AND pending_tool_call_id=$2 AND status=$3`,
      [taskId, input.id, input.decision],
    );
    await client.query(
      `UPDATE tasks SET status='awaiting_approval',updated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND status='queued'`,
      [taskId, input.workspaceId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function registerMcpToolCallListRoute(app: FastifyInstance) {
  app.get('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const input = parse(listQuery, request.query, reply);
    if (!input) return;
    const values: unknown[] = [request.user.workspaceId];
    const clauses = ['calls.workspace_id=$1'];
    if (input.status) { values.push(input.status); clauses.push(`calls.status=$${values.length}`); }
    if (input.connectionId) { values.push(input.connectionId); clauses.push(`calls.connection_id=$${values.length}`); }
    values.push(input.limit);
    const result = await query(
      `SELECT calls.id,calls.status,calls.risk_level,calls.arguments_summary,
       calls.error_code,calls.error_message,calls.runtime_error,calls.duration_ms,calls.requested_at,calls.completed_at,
       tools.remote_name,tools.title tool_title,connections.name connection_name,agents.id agent_id,agents.name agent_name,agents.role agent_role,agents.avatar_config agent_avatar,
       tasks.title task_title,confirmations.status confirmation_status,confirmations.action_summary,
       confirmations.target_summary,confirmations.expires_at
       FROM mcp_tool_calls calls
       JOIN mcp_connection_tools tools ON tools.id=calls.mcp_tool_id
       JOIN mcp_connections connections ON connections.id=calls.connection_id
       LEFT JOIN agents ON agents.id=calls.agent_id
       LEFT JOIN tasks ON tasks.id=calls.task_id
       LEFT JOIN mcp_tool_confirmations confirmations ON confirmations.tool_call_id=calls.id
       WHERE ${clauses.join(' AND ')}
       ORDER BY calls.requested_at DESC LIMIT $${values.length}`,
      values,
    );
    return {
      data: result.rows.map((row) => {
        const error = row.runtime_error ?? row.error_message;
        const serialized = error == null ? null : serializeRuntimeError(error);
        return {
          ...row,
          error_message: serialized?.message ?? null,
          runtime_error: serialized,
        };
      }),
    };
  }));
}

function registerMcpToolCallDecisionRoute(app: FastifyInstance) {
  app.post('/:id/decision', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(decisionInput, request.body, reply);
    if (!params || !input) return;
    const decision = {
      id: params.id,
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      decision: input.decision,
      comment: input.comment,
    };
    const applied = await applyMcpDecision(decision);
    if (!applied) return reply.code(409).send({ error: 'MCP_CONFIRMATION_NOT_PENDING' });
    const { taskId, workflowRunId, traceId, linkedAuthorizationId } = applied;
    try {
      await enqueueTask(taskId, taskId + ':' + params.id + ':' + input.decision, traceId);
    } catch (queueError) {
      await restoreMcpDecisionAfterQueueFailure(decision, taskId, linkedAuthorizationId);
      throw queueError;
    }    await audit(request.user.workspaceId, request.user.sub, `mcp.tool_call.${input.decision}`, 'mcp_tool_call', params.id, {
      taskId,
      workflowRunId,
    });
    return { id: params.id, taskId, decision: input.decision };
  }));
}

export async function mcpToolCallRoutes(app: FastifyInstance) {
  registerMcpToolCallListRoute(app);
  registerMcpToolCallDecisionRoute(app);
}
