import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { enqueueWorkflowRun } from '../queue/task-queue.js';
import { assertWorkflowManifestDependencies } from '../runtime/manifest.js';
import type { WorkflowDefinition } from '../workflows/definition.js';
import { serializeRuntimeError } from '../runtime/errors.js';

const paramsSchema = z.object({ id: z.string().uuid() });
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2_000).optional() });

export async function workflowActionRoutes(app: FastifyInstance) {
  app.post('/:id/decision', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const params = parse(paramsSchema, request.params, reply);
    const input = parse(decisionSchema, request.body, reply);
    if (!params || !input) return;
    const client = await db.connect();
    let workflowRunId = '';
    try {
      await client.query('BEGIN');
      const pending = await client.query<{
        workflow_run_id: string;
        run_mode: 'test' | 'production';
        workflow_version_id: string;
        definition_snapshot: WorkflowDefinition;
        execution_manifest: unknown;
        trace_id: string;
      }>(
        `SELECT authorization.workflow_run_id,run.run_mode,run.workflow_version_id,
                run.definition_snapshot,run.execution_manifest,run.trace_id
         FROM action_authorizations authorization
         JOIN workflow_runs run ON run.id=authorization.workflow_run_id
         WHERE authorization.id=$1 AND authorization.workspace_id=$2
           AND authorization.status='awaiting_confirmation' AND authorization.expires_at>now()
         FOR UPDATE OF authorization,run`,
        [params.id, request.user.workspaceId],
      );
      if (!pending.rowCount) {
        await client.query(
          `UPDATE action_authorizations SET status='expired',resolved_at=now()
           WHERE id=$1 AND workspace_id=$2 AND status='awaiting_confirmation' AND expires_at<=now()`,
          [params.id, request.user.workspaceId],
        );
        await client.query('COMMIT');
        return reply.code(409).send({ error: 'WORKFLOW_ACTION_CONFIRMATION_NOT_PENDING' });
      }
      workflowRunId = pending.rows[0].workflow_run_id;
      if (input.decision === 'approved' && pending.rows[0].run_mode === 'production') {
        await assertWorkflowManifestDependencies({
          workspaceId: request.user.workspaceId,
          workflowVersionId: pending.rows[0].workflow_version_id,
          definition: pending.rows[0].definition_snapshot,
          manifest: pending.rows[0].execution_manifest,
        }, client);
      }
      await client.query(
        `UPDATE action_authorizations SET status=$1,resolved_by=$2,decision_comment=$3,resolved_at=now()
         WHERE id=$4`,
        [input.decision, request.user.sub, input.comment ?? null, params.id],
      );
      if (input.decision === 'approved') {
        await client.query(
          `UPDATE workflow_runs SET status='queued',updated_at=now()
           WHERE id=$1 AND workspace_id=$2 AND status='awaiting_approval'`,
          [workflowRunId, request.user.workspaceId],
        );
      } else {
        const error = serializeRuntimeError('External action was rejected by the user');
        await client.query(
          `UPDATE workflow_runs SET status='cancelled',output=$1,error=$2,completed_at=now(),updated_at=now()
           WHERE id=$3 AND workspace_id=$4 AND status='awaiting_approval'`,
          [JSON.stringify({ error }), JSON.stringify(error), workflowRunId, request.user.workspaceId],
        );
        await client.query(
          "UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'",
          [workflowRunId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (input.decision === 'approved') {
      try {
        const traceId = (await query<{ trace_id: string }>(
          'SELECT trace_id FROM workflow_runs WHERE id=$1 AND workspace_id=$2',
          [workflowRunId, request.user.workspaceId],
        )).rows[0]?.trace_id;
        await enqueueWorkflowRun(workflowRunId, `${workflowRunId}-action-${params.id}-approved`, 0, traceId);
      } catch (error) {
        const serialized = serializeRuntimeError(error);
        await query(
          "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3 AND status='queued'",
          [JSON.stringify({ error: serialized }), JSON.stringify(serialized), workflowRunId],
        );
        throw error;
      }
    }
    await audit(request.user.workspaceId, request.user.sub, `workflow.action.${input.decision}`, 'workflow_run', workflowRunId, { authorizationId: params.id });
    return { id: params.id, workflowRunId, decision: input.decision };
  }));
}
