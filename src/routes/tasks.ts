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
import { childTraceContext, createTraceContext } from '../runtime/trace.js';
import {
  redactRuntimeMessage,
  redactRuntimeValue,
  serializeRuntimeError,
} from '../runtime/errors.js';
import { requestCancellation } from '../runtime/cancellation.js';

const taskInput = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(2).max(300),
  input: z.record(z.unknown()).default({}),
  artifactFormats: z.array(artifactFormatSchema).max(9).default([]),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});
const feedbackInput = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(4000).optional() });

function publicTask(row: Record<string, unknown>) {
  return { ...row, error: row.error == null ? null : serializeRuntimeError(row.error) };
}

function publicEvent(row: Record<string, unknown>) {
  return {
    ...row,
    message: redactRuntimeMessage(String(row.message ?? '')),
    payload: redactRuntimeValue(row.payload ?? {}),
  };
}

function publicAuthorization(row: Record<string, unknown>) {
  const error = row.runtime_error ?? row.error_message;
  const serialized = error == null ? null : serializeRuntimeError(error);
  return {
    ...row,
    error_message: serialized?.message ?? null,
    runtime_error: serialized,
  };
}

function registerTaskListRoute(app: FastifyInstance) {
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
    return { data: result.rows.map((row) => publicTask(row)) };
  }));

}

function registerTaskCreateRoute(app: FastifyInstance) {
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
    const trace = createTraceContext();
    const client = await db.connect();
    let task: { id: string; title: string; trace_id: string; [key: string]: unknown };
    try {
      await client.query('BEGIN');
      const manifest = await buildTaskManifest({
        workspaceId: request.user.workspaceId,
        agentId: input.agentId,
      }, client);
      const versionId = manifest.agents[input.agentId]?.versionId;
      if (!versionId) throw Object.assign(new Error('AGENT_VERSION_REQUIRED'), { statusCode: 409 });
      task = (await client.query<{ id: string; title: string; trace_id: string; [key: string]: unknown }>(
        `INSERT INTO tasks(
           workspace_id,agent_id,agent_version_id,title,input,requested_by,manifest_version,execution_manifest,
           trace_id,span_id,parent_span_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          request.user.workspaceId,
          input.agentId,
          versionId,
          input.title,
          JSON.stringify(input.input),
          request.user.sub,
          manifest.manifestVersion,
          JSON.stringify(manifest),
          trace.traceId,
          trace.spanId,
          trace.parentSpanId,
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
      const attachmentTrace = childTraceContext(trace);
      await query(
        `INSERT INTO task_attachments(task_id,file_id,workspace_id,attached_by)
         SELECT $1,id,$2,$3 FROM files WHERE workspace_id=$2 AND id=ANY($4::uuid[])
         ON CONFLICT DO NOTHING`,
        [task.id, request.user.workspaceId, request.user.sub, attachmentIds],
      );
      await query(
        `INSERT INTO task_events(
           workspace_id,task_id,event_type,message,payload,trace_id,span_id,parent_span_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          request.user.workspaceId,
          task.id,
          'attachments.ready',
          `${attachmentIds.length} attachment${attachmentIds.length === 1 ? '' : 's'} added`,
          JSON.stringify({ fileIds: attachmentIds }),
          attachmentTrace.traceId,
          attachmentTrace.spanId,
          attachmentTrace.parentSpanId,
        ],
      );
    }
    const taskPayload = input.input ?? {};
    const requestText = typeof taskPayload.request === 'string' ? taskPayload.request : '';
    const artifactFormats = [...new Set([...(input.artifactFormats ?? []), ...inferredArtifactFormats(requestText)])];
    if (artifactFormats.length) {
      await requestTaskArtifacts({ workspaceId: request.user.workspaceId, createdBy: request.user.sub, taskId: task.id, title: task.title, formats: artifactFormats, ready: false });
    }
    const queuedTrace = childTraceContext(trace);
    await query(
      `INSERT INTO task_events(
         workspace_id,task_id,event_type,message,trace_id,span_id,parent_span_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        request.user.workspaceId,
        task.id,
        'task.queued',
        'Task queued for execution',
        queuedTrace.traceId,
        queuedTrace.spanId,
        queuedTrace.parentSpanId,
      ],
    );
    await enqueueTask(task.id, task.id, task.trace_id);
    await audit(request.user.workspaceId, request.user.sub, 'task.created', 'task', task.id, { agentId: input.agentId, attachmentIds });
    return reply.code(202).send({ ...task, attachmentIds });
  }));

}

function registerTaskStreamRoute(app: FastifyInstance) {
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
          reply.raw.write(`event: task-event\ndata: ${JSON.stringify(publicEvent(event))}\n\n`);
        }
      } catch { reply.raw.write('event: error\ndata: {"error":"STREAM_QUERY_FAILED"}\n\n'); }
    };
    reply.raw.write('event: ready\ndata: {}\n\n');
    await send();
    const heartbeat = setInterval(() => { reply.raw.write(': keepalive\n\n'); void send(); }, 1_500);
    heartbeat.unref();
    request.raw.on('close', () => { closed = true; clearInterval(heartbeat); });
  });

}

function registerTaskDetailsRoute(app: FastifyInstance) {
  app.get('/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const task = await query('SELECT t.*,a.name agent_name,a.role agent_role,a.avatar_config agent_avatar FROM tasks t JOIN agents a ON a.id=t.agent_id WHERE t.id=$1 AND t.workspace_id=$2', [id, request.user.workspaceId]);
    if (!task.rowCount) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
    const [events, artifacts, actionAuthorizations, attachments] = await Promise.all([
      query('SELECT * FROM task_events WHERE task_id=$1 AND workspace_id=$2 ORDER BY created_at', [id, request.user.workspaceId]),
      query('SELECT * FROM artifacts WHERE task_id=$1 AND workspace_id=$2 ORDER BY created_at', [id, request.user.workspaceId]),
      query(`SELECT id,adapter,resource_id,operation,target_summary,risk_level,arguments_summary,arguments_hash,
             status,requested_at,expires_at,resolved_at,consumed_at,error_message,runtime_error
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
    return {
      ...publicTask(task.rows[0]),
      events: events.rows.map((row) => publicEvent(row)),
      artifacts: artifacts.rows,
      actionAuthorizations: actionAuthorizations.rows.map((row) => publicAuthorization(row)),
      attachments: attachments.rows,
    };
  }));

}

function registerTaskCancelRoute(app: FastifyInstance) {
  app.post('/:id/cancel', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await requestCancellation({
      kind: 'task',
      id,
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
    });
    if (!result) return reply.code(409).send({ error: 'TASK_CANNOT_BE_CANCELLED' });
    const cancellationTrace = childTraceContext({
      traceId: result.trace_id,
      spanId: result.span_id,
      parentSpanId: result.parent_span_id,
    });
    await query(
      `INSERT INTO task_events(
         workspace_id,task_id,event_type,message,trace_id,span_id,parent_span_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        request.user.workspaceId,
        result.id,
        'task.cancel_requested',
        'Task cancellation requested by user',
        cancellationTrace.traceId,
        cancellationTrace.spanId,
        cancellationTrace.parentSpanId,
      ],
    );
    await enqueueTask(result.id, result.id, result.trace_id);
    await audit(request.user.workspaceId, request.user.sub, 'task.cancel_requested', 'task', result.id);
    return reply.code(202).send(result);
  }));

}

function registerTaskFeedbackRoute(app: FastifyInstance) {
  app.put('/:id/feedback', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(feedbackInput, request.body, reply); if (!input) return;
    const task = await query('SELECT id FROM tasks WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!task.rowCount) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
    const result = await query('INSERT INTO task_feedback(workspace_id,task_id,user_id,rating,comment) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,user_id) DO UPDATE SET rating=EXCLUDED.rating,comment=EXCLUDED.comment,updated_at=now() RETURNING *', [request.user.workspaceId, task.rows[0].id, request.user.sub, input.rating, input.comment ?? null]);
    return result.rows[0];
  }));
}

export async function taskRoutes(app: FastifyInstance) {
  registerTaskListRoute(app);
  registerTaskCreateRoute(app);
  registerTaskStreamRoute(app);
  registerTaskDetailsRoute(app);
  registerTaskCancelRoute(app);
  registerTaskFeedbackRoute(app);
}
