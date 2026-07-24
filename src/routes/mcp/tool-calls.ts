import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { asyncRoute, parse } from '../../lib/http.js';
import { enqueueTask } from '../../queue/task-queue.js';

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

export async function mcpToolCallRoutes(app: FastifyInstance) {
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
       calls.error_code,calls.error_message,calls.duration_ms,calls.requested_at,calls.completed_at,
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
    return { data: result.rows };
  }));

  app.post('/:id/decision', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const input = parse(decisionInput, request.body, reply);
    if (!params || !input) return;
    const client = await db.connect();
    let taskId = '';
    let workflowRunId: string | null = null;
    try {
      await client.query('BEGIN');
      const linkedAuthorization = await client.query<{ action_authorization_id: string | null }>(
        `SELECT action_authorization_id FROM mcp_tool_calls WHERE id=$1 AND workspace_id=$2`,
        [params.id, request.user.workspaceId],
      );
      const linkedAuthorizationId = linkedAuthorization.rows[0]?.action_authorization_id ?? null;
      if (linkedAuthorizationId) {
        const locked = await client.query(
          `SELECT id FROM action_authorizations
           WHERE id=$1 AND workspace_id=$2 AND status='awaiting_confirmation' AND expires_at>now()
           FOR UPDATE`,
          [linkedAuthorizationId, request.user.workspaceId],
        );
        if (!locked.rowCount) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error: 'MCP_CONFIRMATION_NOT_PENDING' });
        }
      }
      const pending = await client.query<{ task_id: string; workflow_run_id: string | null; action_authorization_id: string | null }>(
        `SELECT calls.task_id,calls.workflow_run_id,calls.action_authorization_id
         FROM mcp_tool_calls calls JOIN mcp_tool_confirmations confirmation ON confirmation.tool_call_id=calls.id
         WHERE calls.id=$1 AND calls.workspace_id=$2 AND calls.status='awaiting_confirmation'
         AND confirmation.status='pending' AND confirmation.expires_at > now()
         FOR UPDATE`,
        [params.id, request.user.workspaceId],
      );
      if (!pending.rowCount || !pending.rows[0].task_id) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'MCP_CONFIRMATION_NOT_PENDING' });
      }
      taskId = pending.rows[0].task_id;
      workflowRunId = pending.rows[0].workflow_run_id;
      const actionAuthorizationId = pending.rows[0].action_authorization_id;
      await client.query(
        `UPDATE mcp_tool_confirmations SET status=$1,resolved_by=$2,decision_comment=$3,resolved_at=now()
         WHERE tool_call_id=$4`,
        [input.decision, request.user.sub, input.comment ?? null, params.id],
      );
      await client.query(
        `UPDATE mcp_tool_calls SET status=$1,completed_at=CASE WHEN $1='rejected' THEN now() ELSE NULL END
         WHERE id=$2`,
        [input.decision === 'approved' ? 'pending' : 'rejected', params.id],
      );
      await client.query(
        `UPDATE task_runtime_checkpoints SET status=$1,updated_at=now()
         WHERE task_id=$2 AND pending_tool_call_id=$3`,
        [input.decision, taskId, params.id],
      );
      if (actionAuthorizationId) {
        await client.query(
          `UPDATE action_authorizations SET status=$1,resolved_by=$2,decision_comment=$3,resolved_at=now()
           WHERE id=$4 AND status='awaiting_confirmation'`,
          [input.decision, request.user.sub, input.comment ?? null, actionAuthorizationId],
        );
      }
      await client.query(
        `UPDATE tasks SET status='queued',updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status='awaiting_approval'`,
        [taskId, request.user.workspaceId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await enqueueTask(taskId, `${taskId}:${params.id}:${input.decision}`);
    await audit(request.user.workspaceId, request.user.sub, `mcp.tool_call.${input.decision}`, 'mcp_tool_call', params.id, {
      taskId,
      workflowRunId,
    });
    return { id: params.id, taskId, decision: input.decision };
  }));
}
