import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import {
  getTaskOutputDocument,
  initializeTaskOutputDocument,
  revertOutputVersion,
  saveOutputVersion,
} from '../outputs/service.js';
import { outputContentSchema } from '../outputs/types.js';
import { artifactFormatSchema } from '../artifacts/types.js';
import { requestTaskVersionArtifacts } from '../artifacts/service.js';
import { query } from '../db/client.js';

const taskParams = z.object({ taskId: z.string().uuid() });
const documentParams = z.object({ documentId: z.string().uuid() });
const versionInput = z.object({
  content: outputContentSchema,
  baseVersionNumber: z.number().int().min(1),
});
const revertInput = z.object({
  versionId: z.string().uuid(),
  baseVersionNumber: z.number().int().min(1),
});
const artifactInput = z.object({
  versionId: z.string().uuid(),
  formats: z.array(artifactFormatSchema).min(1).max(9).transform((formats) => [...new Set(formats)]),
});

export async function outputDocumentRoutes(app: FastifyInstance) {
  app.get('/tasks/:taskId', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const params = parse(taskParams, request.params, reply); if (!params) return;
    const document = await getTaskOutputDocument(request.user.workspaceId, params.taskId);
    return { document };
  }));

  app.post('/tasks/:taskId', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(taskParams, request.params, reply); if (!params) return;
    const existing = await getTaskOutputDocument(request.user.workspaceId, params.taskId);
    const document = existing ?? await initializeTaskOutputDocument({
      workspaceId: request.user.workspaceId,
      taskId: params.taskId,
      actorId: request.user.sub,
    });
    if (!existing) {
      await audit(request.user.workspaceId, request.user.sub, 'output_document.initialized', 'output_document', document.id, {
        taskId: params.taskId,
        versionNumber: document.current_version_number,
      });
    }
    return reply.code(existing ? 200 : 201).send(document);
  }));

  app.post('/:documentId/versions', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(documentParams, request.params, reply); if (!params) return;
    const input = parse(versionInput, request.body, reply); if (!input) return;
    const document = await saveOutputVersion({
      workspaceId: request.user.workspaceId,
      documentId: params.documentId,
      actorId: request.user.sub,
      content: input.content,
      baseVersionNumber: input.baseVersionNumber,
    });
    await audit(request.user.workspaceId, request.user.sub, 'output_document.version_created', 'output_document', document.id, {
      versionNumber: document.current_version_number,
    });
    return reply.code(201).send(document);
  }));

  app.post('/:documentId/revert', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(documentParams, request.params, reply); if (!params) return;
    const input = parse(revertInput, request.body, reply); if (!input) return;
    const document = await revertOutputVersion({
      workspaceId: request.user.workspaceId,
      documentId: params.documentId,
      actorId: request.user.sub,
      versionId: input.versionId,
      baseVersionNumber: input.baseVersionNumber,
    });
    await audit(request.user.workspaceId, request.user.sub, 'output_document.reverted', 'output_document', document.id, {
      sourceVersionId: input.versionId,
      versionNumber: document.current_version_number,
    });
    return reply.code(201).send(document);
  }));

  app.post('/:documentId/artifacts', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(documentParams, request.params, reply); if (!params) return;
    const input = parse(artifactInput, request.body, reply); if (!input) return;
    const source = (await query<{ task_id: string; title: string; status: string; version_number: number }>(
      `SELECT d.task_id,t.title,t.status,v.version_number
         FROM output_documents d
         JOIN output_document_versions v ON v.document_id=d.id
         JOIN tasks t ON t.id=d.task_id
        WHERE d.id=$1 AND d.workspace_id=$2 AND v.id=$3`,
      [params.documentId, request.user.workspaceId, input.versionId],
    )).rows[0];
    if (!source) return reply.code(404).send({ error: 'OUTPUT_VERSION_NOT_FOUND' });
    if (source.status !== 'completed') return reply.code(409).send({ error: 'OUTPUT_TASK_NOT_COMPLETED' });
    const artifacts = await requestTaskVersionArtifacts({
      workspaceId: request.user.workspaceId,
      createdBy: request.user.sub,
      taskId: source.task_id,
      versionId: input.versionId,
      title: source.title,
      formats: input.formats,
    });
    await audit(request.user.workspaceId, request.user.sub, 'output_document.artifacts_requested', 'output_document', params.documentId, {
      versionId: input.versionId,
      versionNumber: source.version_number,
      formats: input.formats,
    });
    return reply.code(202).send({ data: artifacts });
  }));
}
