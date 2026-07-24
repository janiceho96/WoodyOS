import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { enqueueTask } from '../queue/task-queue.js';
import { assertWorkspaceAiBudgetAvailable } from '../lib/ai-usage.js';
import { requestTaskArtifacts } from '../artifacts/service.js';
import { artifactFormatSchema, inferredArtifactFormats } from '../artifacts/types.js';

const taskInput = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(2).max(300),
  input: z.record(z.unknown()).default({}),
  artifactFormats: z.array(artifactFormatSchema).max(4).default([]),
});
const feedbackInput = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(4000).optional() });

export async function taskRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const result = await query(
      `SELECT t.*,a.name agent_name,a.role agent_role,a.avatar_config agent_avatar,w.name workflow_name,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object('format',artifact.format,'status',artifact.status)
            ORDER BY artifact.created_at
          )
          FROM artifacts artifact
          WHERE artifact.task_id=t.id
        ),'[]'::jsonb) artifact_summary
       FROM tasks t
       JOIN agents a ON a.id=t.agent_id
       LEFT JOIN workflow_runs workflow_run ON workflow_run.id=t.workflow_run_id
       LEFT JOIN workflows w ON w.id=workflow_run.workflow_id
       WHERE t.workspace_id=$1
       ORDER BY t.created_at DESC
       LIMIT 100`,
      [request.user.workspaceId],
    );
    return { data: result.rows };
  }));
  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(taskInput, request.body, reply); if (!input) return;
    const agent = await query('SELECT id,status FROM agents WHERE id=$1 AND workspace_id=$2', [input.agentId, request.user.workspaceId]);
    if (!agent.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    if (agent.rows[0].status !== 'active') return reply.code(409).send({ error: 'AGENT_NOT_ACTIVE' });
    await assertWorkspaceAiBudgetAvailable(request.user.workspaceId);
    const task = (await query('INSERT INTO tasks(workspace_id,agent_id,title,input,requested_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [request.user.workspaceId, input.agentId, input.title, JSON.stringify(input.input), request.user.sub])).rows[0];
    const taskPayload = input.input ?? {};
    const requestText = typeof taskPayload.request === 'string' ? taskPayload.request : '';
    const artifactFormats = [...new Set([...(input.artifactFormats ?? []), ...inferredArtifactFormats(requestText)])];
    if (artifactFormats.length) {
      await requestTaskArtifacts({ workspaceId: request.user.workspaceId, createdBy: request.user.sub, taskId: task.id, title: task.title, formats: artifactFormats, ready: false });
    }
    await query('INSERT INTO task_events(workspace_id,task_id,event_type,message) VALUES($1,$2,$3,$4)', [request.user.workspaceId, task.id, 'task.queued', 'Task queued for execution']);
    await enqueueTask(task.id);
    await audit(request.user.workspaceId, request.user.sub, 'task.created', 'task', task.id, { agentId: input.agentId });
    return reply.code(202).send(task);
  }));
  app.get('/:id/stream', { preHandler: app.authenticate }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const task = await query('SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2', [id, request.user.workspaceId]);
    if (!task.rowCount) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let lastTimestamp = '1970-01-01T00:00:00.000Z';
    let closed = false;
    const send = async () => {
      if (closed) return;
      try {
        const events = await query<{ created_at: Date; event_type: string; message: string; payload: Record<string, unknown> }>('SELECT created_at,event_type,message,payload FROM task_events WHERE task_id=$1 AND workspace_id=$2 AND created_at > $3 ORDER BY created_at', [id, request.user.workspaceId, lastTimestamp]);
        for (const event of events.rows) {
          lastTimestamp = event.created_at.toISOString();
          reply.raw.write(`event: task-event\ndata: ${JSON.stringify(event)}\n\n`);
        }
      } catch { reply.raw.write('event: error\ndata: {"error":"STREAM_QUERY_FAILED"}\n\n'); }
    };
    reply.raw.write('event: ready\ndata: {}\n\n');
    await send();
    const heartbeat = setInterval(() => { reply.raw.write(': keepalive\n\n'); void send(); }, 1_500);
    heartbeat.unref();
    request.raw.on('close', () => { closed = true; clearInterval(heartbeat); });
  });
  app.get('/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const task = await query('SELECT t.*,a.name agent_name,a.role agent_role,a.avatar_config agent_avatar FROM tasks t JOIN agents a ON a.id=t.agent_id WHERE t.id=$1 AND t.workspace_id=$2', [id, request.user.workspaceId]);
    if (!task.rowCount) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
    const [events, artifacts, actionAuthorizations] = await Promise.all([
      query('SELECT * FROM task_events WHERE task_id=$1 AND workspace_id=$2 ORDER BY created_at', [id, request.user.workspaceId]),
      query('SELECT * FROM artifacts WHERE task_id=$1 AND workspace_id=$2 ORDER BY created_at', [id, request.user.workspaceId]),
      query(`SELECT id,adapter,resource_id,operation,target_summary,risk_level,arguments_summary,arguments_hash,
             status,requested_at,expires_at,resolved_at,consumed_at,error_message
             FROM action_authorizations WHERE task_id=$1 AND workspace_id=$2 ORDER BY requested_at`, [id, request.user.workspaceId]),
    ]);
    return { ...task.rows[0], events: events.rows, artifacts: artifacts.rows, actionAuthorizations: actionAuthorizations.rows };
  }));
  app.post('/:id/cancel', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const result = await query("UPDATE tasks SET status='cancelled',completed_at=now(),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status IN ('queued','running','awaiting_approval') RETURNING *", [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(409).send({ error: 'TASK_CANNOT_BE_CANCELLED' });
    await query(
      `UPDATE action_authorizations SET status='rejected',resolved_by=$1,decision_comment='Source task was cancelled',resolved_at=now()
       WHERE task_id=$2 AND status='awaiting_confirmation'`,
      [request.user.sub, result.rows[0].id],
    );
    await query("UPDATE task_runtime_checkpoints SET status='failed',updated_at=now() WHERE task_id=$1 AND status='awaiting_confirmation'", [result.rows[0].id]);
    await query("UPDATE mcp_tool_confirmations SET status='expired',resolved_at=now() WHERE tool_call_id IN (SELECT id FROM mcp_tool_calls WHERE task_id=$1) AND status='pending'", [result.rows[0].id]);
    await query("UPDATE mcp_tool_calls SET status='cancelled',completed_at=now() WHERE task_id=$1 AND status IN ('pending','awaiting_confirmation')", [result.rows[0].id]);
    await query("UPDATE artifacts SET status='failed',error_message='Source task was cancelled',updated_at=now() WHERE task_id=$1 AND status='pending'", [result.rows[0].id]);
    await query('INSERT INTO task_events(workspace_id,task_id,event_type,message) VALUES($1,$2,$3,$4)', [request.user.workspaceId, result.rows[0].id, 'task.cancelled', 'Task cancelled by user']);
    return result.rows[0];
  }));
  app.put('/:id/feedback', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(feedbackInput, request.body, reply); if (!input) return;
    const task = await query('SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!task.rowCount) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
    const result = await query('INSERT INTO task_feedback(workspace_id,task_id,user_id,rating,comment) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,user_id) DO UPDATE SET rating=EXCLUDED.rating,comment=EXCLUDED.comment,updated_at=now() RETURNING *', [request.user.workspaceId, task.rows[0].id, request.user.sub, input.rating, input.comment ?? null]);
    return result.rows[0];
  }));
}
