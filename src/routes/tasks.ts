import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { enqueueTask } from '../queue/task-queue.js';
import { assertWorkspaceAiBudgetAvailable } from '../lib/ai-usage.js';
import { requestTaskArtifacts } from '../artifacts/service.js';
import { artifactFormatSchema, inferredArtifactFormats } from '../artifacts/types.js';
import { buildTaskManifest } from '../runtime/manifest.js';

const taskInput = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(2).max(300),
  input: z.record(z.unknown()).default({}),
  artifactFormats: z.array(artifactFormatSchema).max(9).default([]),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
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
        ),'[]'::jsonb) artifact_summary,
        (SELECT count(*)::integer FROM task_attachments attachment WHERE attachment.task_id=t.id) attachment_count
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
    const agent = await query('SELECT id,status,published_version_id FROM agents WHERE id=$1 AND workspace_id=$2', [input.agentId, request.user.workspaceId]);
    if (!agent.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    if (agent.rows[0].status !== 'active') return reply.code(409).send({ error: 'AGENT_NOT_ACTIVE' });
    const attachmentIds = [...new Set(input.attachmentIds)];
    if (attachmentIds.length) {
      const available = await query<{ id: string }>(
        `SELECT id FROM files WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='ready'`,
        [request.user.workspaceId, attachmentIds],
      );
      if (available.rowCount !== attachmentIds.length) return reply.code(409).send({ error: 'FILE_ATTACHMENTS_NOT_READY_OR_MISSING' });
    }
    await assertWorkspaceAiBudgetAvailable(request.user.workspaceId);
    const client = await db.connect();
    let task: { id: string; title: string; [key: string]: unknown };
    try {
      await client.query('BEGIN');
      const manifest = await buildTaskManifest({
        workspaceId: request.user.workspaceId,
        agentId: input.agentId,
      }, client);
      const versionId = manifest.agents[input.agentId]?.versionId;
      if (!versionId) throw Object.assign(new Error('AGENT_VERSION_REQUIRED'), { statusCode: 409 });
      task = (await client.query<{ id: string; title: string; [key: string]: unknown }>(
        `INSERT INTO tasks(
           workspace_id,agent_id,agent_version_id,title,input,requested_by,manifest_version,execution_manifest
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          request.user.workspaceId,
          input.agentId,
          versionId,
          input.title,
          JSON.stringify(input.input),
          request.user.sub,
          manifest.manifestVersion,
          JSON.stringify(manifest),
        ],
      )).rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (attachmentIds.length) {
      await query(
        `INSERT INTO task_attachments(task_id,file_id,workspace_id,attached_by)
         SELECT $1,id,$2,$3 FROM files WHERE workspace_id=$2 AND id=ANY($4::uuid[])
         ON CONFLICT DO NOTHING`,
        [task.id, request.user.workspaceId, request.user.sub, attachmentIds],
      );
      await query(
        'INSERT INTO task_events(workspace_id,task_id,event_type,message,payload) VALUES($1,$2,$3,$4,$5)',
        [request.user.workspaceId, task.id, 'attachments.ready', `${attachmentIds.length} attachment${attachmentIds.length === 1 ? '' : 's'} added`, JSON.stringify({ fileIds: attachmentIds })],
      );
    }
    const taskPayload = input.input ?? {};
    const requestText = typeof taskPayload.request === 'string' ? taskPayload.request : '';
    const artifactFormats = [...new Set([...(input.artifactFormats ?? []), ...inferredArtifactFormats(requestText)])];
    if (artifactFormats.length) {
      await requestTaskArtifacts({ workspaceId: request.user.workspaceId, createdBy: request.user.sub, taskId: task.id, title: task.title, formats: artifactFormats, ready: false });
    }
    await query('INSERT INTO task_events(workspace_id,task_id,event_type,message) VALUES($1,$2,$3,$4)', [request.user.workspaceId, task.id, 'task.queued', 'Task queued for execution']);
    await enqueueTask(task.id);
    await audit(request.user.workspaceId, request.user.sub, 'task.created', 'task', task.id, { agentId: input.agentId, attachmentIds });
    return reply.code(202).send({ ...task, attachmentIds });
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
    const [events, artifacts, actionAuthorizations, attachments] = await Promise.all([
      query('SELECT * FROM task_events WHERE task_id=$1 AND workspace_id=$2 ORDER BY created_at', [id, request.user.workspaceId]),
      query('SELECT * FROM artifacts WHERE task_id=$1 AND workspace_id=$2 ORDER BY created_at', [id, request.user.workspaceId]),
      query(`SELECT id,adapter,resource_id,operation,target_summary,risk_level,arguments_summary,arguments_hash,
             status,requested_at,expires_at,resolved_at,consumed_at,error_message
             FROM action_authorizations WHERE task_id=$1 AND workspace_id=$2 ORDER BY requested_at`, [id, request.user.workspaceId]),
      query(
        `SELECT file.id,file.original_name,file.extension,file.mime_type,file.size_bytes,file.status,file.scan_status,
          file.scope,file.retention_policy,file.expires_at,file.error_message,file.metadata,
          file.version_group_id,file.version_number,file.replaces_file_id,
          file.created_at,file.updated_at,file.completed_at
         FROM task_attachments attachment JOIN files file ON file.id=attachment.file_id
         WHERE attachment.task_id=$1 AND attachment.workspace_id=$2 ORDER BY attachment.created_at`,
        [id, request.user.workspaceId],
      ),
    ]);
    return { ...task.rows[0], events: events.rows, artifacts: artifacts.rows, actionAuthorizations: actionAuthorizations.rows, attachments: attachments.rows };
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
