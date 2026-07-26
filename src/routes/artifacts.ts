import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { requestTaskArtifacts, requestWorkflowArtifacts } from '../artifacts/service.js';
import { artifactStorage } from '../artifacts/storage.js';
import { artifactFormatSchema, type ArtifactRecord } from '../artifacts/types.js';

const requestInput = z.object({
  taskId: z.string().uuid().optional(),
  workflowRunId: z.string().uuid().optional(),
  formats: z.array(artifactFormatSchema).min(1).max(9),
}).refine((value) => Boolean(value.taskId) !== Boolean(value.workflowRunId), 'Choose exactly one task or workflow run');

export async function artifactRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const filters = parse(z.object({ taskId: z.string().uuid().optional(), workflowRunId: z.string().uuid().optional() }), request.query, reply); if (!filters) return;
    const result = await query<ArtifactRecord>(
      `SELECT * FROM artifacts WHERE workspace_id=$1
       AND ($2::uuid IS NULL OR task_id=$2) AND ($3::uuid IS NULL OR workflow_run_id=$3)
       ORDER BY created_at DESC LIMIT 100`,
      [request.user.workspaceId, filters.taskId ?? null, filters.workflowRunId ?? null],
    );
    return { data: result.rows };
  }));

  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(requestInput, request.body, reply); if (!input) return;
    if (input.taskId) {
      const task = (await query<{ id: string; title: string; status: string }>('SELECT id,title,status FROM tasks WHERE id=$1 AND workspace_id=$2', [input.taskId, request.user.workspaceId])).rows[0];
      if (!task) return reply.code(404).send({ error: 'TASK_NOT_FOUND' });
      if (!['queued', 'running', 'awaiting_approval', 'completed'].includes(task.status)) return reply.code(409).send({ error: 'TASK_CANNOT_CREATE_ARTIFACTS' });
      const artifacts = await requestTaskArtifacts({ workspaceId: request.user.workspaceId, createdBy: request.user.sub, taskId: task.id, title: task.title, formats: input.formats, ready: task.status === 'completed' });
      await audit(request.user.workspaceId, request.user.sub, 'artifact.requested', 'task', task.id, { formats: input.formats });
      return reply.code(202).send({ data: artifacts });
    }
    const run = (await query<{ id: string; name: string; status: string }>('SELECT r.id,w.name,r.status FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id WHERE r.id=$1 AND r.workspace_id=$2', [input.workflowRunId, request.user.workspaceId])).rows[0];
    if (!run) return reply.code(404).send({ error: 'WORKFLOW_RUN_NOT_FOUND' });
    if (!['queued', 'running', 'awaiting_approval', 'completed'].includes(run.status)) return reply.code(409).send({ error: 'WORKFLOW_RUN_CANNOT_CREATE_ARTIFACTS' });
    const artifacts = await requestWorkflowArtifacts({ workspaceId: request.user.workspaceId, createdBy: request.user.sub, workflowRunId: run.id, title: run.name, formats: input.formats, ready: run.status === 'completed' });
    await audit(request.user.workspaceId, request.user.sub, 'artifact.requested', 'workflow_run', run.id, { formats: input.formats });
    return reply.code(202).send({ data: artifacts });
  }));

  app.get('/:id/download', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const artifact = (await query<ArtifactRecord>('SELECT * FROM artifacts WHERE id=$1 AND workspace_id=$2', [id, request.user.workspaceId])).rows[0];
    if (!artifact) return reply.code(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    if (artifact.status !== 'ready' || !artifact.storage_key) return reply.code(409).send({ error: 'ARTIFACT_NOT_READY' });
    const file = await artifactStorage().open(artifact.storage_key);
    const inline = (request.query as { inline?: string }).inline === 'true';
    const disposition = inline && ['pdf', 'html', 'md', 'txt', 'csv', 'json'].includes(artifact.format) ? 'inline' : 'attachment';
    reply.header('content-type', artifact.mime_type);
    reply.header('content-length', String(file.size));
    reply.header('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`);
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    if (artifact.format === 'html') {
      reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
    }
    return reply.send(file.stream);
  }));

  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const artifact = (await query<ArtifactRecord>('DELETE FROM artifacts WHERE id=$1 AND workspace_id=$2 RETURNING *', [id, request.user.workspaceId])).rows[0];
    if (!artifact) return reply.code(404).send({ error: 'ARTIFACT_NOT_FOUND' });
    if (artifact.storage_key) await artifactStorage().delete(artifact.storage_key);
    await audit(request.user.workspaceId, request.user.sub, 'artifact.deleted', 'artifact', artifact.id, { format: artifact.format });
    return reply.code(204).send();
  }));
}
