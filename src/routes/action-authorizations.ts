import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { enqueueTask } from '../queue/task-queue.js';
import {
  assertTaskManifestDependencies,
  assertWorkflowManifestDependencies,
} from '../runtime/manifest.js';
import type { WorkflowDefinition } from '../workflows/definition.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2_000).optional() });

export async function actionAuthorizationRoutes(app: FastifyInstance) {
  app.post('/:id/decision', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const params = parse(paramsSchema, request.params, reply);
    const input = parse(decisionSchema, request.body, reply);
    if (!params || !input) return;
    const client = await db.connect();
    let taskId = '';
    let workflowRunId: string | null = null;
    let toolCallId: string | null = null;
    let traceId = '';
    try {
      await client.query('BEGIN');
      const pending = await client.query<{
        task_id: string;
        agent_id: string;
        workflow_run_id: string | null;
        run_mode: 'test' | 'production' | null;
        workflow_version_id: string | null;
        definition_snapshot: WorkflowDefinition | null;
        pending_tool_call_id: string | null;
        execution_manifest: unknown;
        run_execution_manifest: unknown;
        trace_id: string;
      }>(
        `SELECT authorization.task_id,tasks.agent_id,tasks.workflow_run_id,run.run_mode,
                run.workflow_version_id,run.definition_snapshot,
                checkpoint.pending_tool_call_id,tasks.execution_manifest,
                run.execution_manifest run_execution_manifest,tasks.trace_id
         FROM action_authorizations authorization
         JOIN task_runtime_checkpoints checkpoint ON checkpoint.pending_action_authorization_id=authorization.id
         JOIN tasks ON tasks.id=authorization.task_id
         LEFT JOIN workflow_runs run ON run.id=tasks.workflow_run_id
         WHERE authorization.id=$1 AND authorization.workspace_id=$2 AND authorization.subject_type='task'
           AND authorization.status='awaiting_confirmation' AND authorization.expires_at>now()
           AND checkpoint.status='awaiting_confirmation'
         FOR UPDATE OF authorization,checkpoint,tasks`,
        [params.id, request.user.workspaceId],
      );
      if (!pending.rowCount) {
        await client.query(
          `UPDATE action_authorizations SET status='expired',resolved_at=now()
           WHERE id=$1 AND workspace_id=$2 AND status='awaiting_confirmation' AND expires_at<=now()`,
          [params.id, request.user.workspaceId],
        );
        await client.query('COMMIT');
        return reply.code(409).send({ error: 'ACTION_CONFIRMATION_NOT_PENDING' });
      }
      taskId = pending.rows[0].task_id;
      workflowRunId = pending.rows[0].workflow_run_id;
      toolCallId = pending.rows[0].pending_tool_call_id;
      traceId = pending.rows[0].trace_id;
      if (pending.rows[0].run_mode !== 'test') {
        const row = pending.rows[0];
        if (row.workflow_run_id && row.workflow_version_id && row.definition_snapshot) {
          await assertWorkflowManifestDependencies({
            workspaceId: request.user.workspaceId,
            workflowVersionId: row.workflow_version_id,
            definition: row.definition_snapshot,
            manifest: row.run_execution_manifest,
          }, client);
        } else {
          await assertTaskManifestDependencies({
            workspaceId: request.user.workspaceId,
            agentId: row.agent_id,
            manifest: row.execution_manifest,
          }, client);
        }
      }
      await client.query(
        `UPDATE action_authorizations SET status=$1,resolved_by=$2,decision_comment=$3,resolved_at=now()
         WHERE id=$4 AND status='awaiting_confirmation'`,
        [input.decision, request.user.sub, input.comment ?? null, params.id],
      );
      await client.query(
        `UPDATE task_runtime_checkpoints SET status=$1,updated_at=now()
         WHERE task_id=$2 AND pending_action_authorization_id=$3`,
        [input.decision, taskId, params.id],
      );
      if (toolCallId) {
        await client.query(
          `UPDATE mcp_tool_confirmations SET status=$1,resolved_by=$2,decision_comment=$3,resolved_at=now()
           WHERE tool_call_id=$4 AND status='pending'`,
          [input.decision, request.user.sub, input.comment ?? null, toolCallId],
        );
        await client.query(
          `UPDATE mcp_tool_calls SET status=$1,completed_at=CASE WHEN $1='rejected' THEN now() ELSE NULL END
           WHERE id=$2`,
          [input.decision === 'approved' ? 'pending' : 'rejected', toolCallId],
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
    await enqueueTask(taskId, `${taskId}:action:${params.id}:${input.decision}`, traceId);
    await audit(request.user.workspaceId, request.user.sub, `agent.action.${input.decision}`, 'task', taskId, {
      authorizationId: params.id,
      workflowRunId,
      toolCallId,
    });
    return { id: params.id, taskId, decision: input.decision };
  }));
}
