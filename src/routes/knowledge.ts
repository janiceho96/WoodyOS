import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { asyncRoute, parse } from '../lib/http.js';
import { enqueueKnowledgeDocument } from '../queue/task-queue.js';
import { embeddingFor } from '../lib/embeddings.js';
import { ensureKnowledgeDocument, ingestUploadedFile } from '../files/service.js';

const inputSchema = z.object({ name: z.string().min(1).max(260), sourceType: z.enum(['pdf', 'docx', 'pptx', 'csv', 'url', 'image', 'database', 'text', 'html']), sourceUri: z.string().max(2048).nullable().optional(), content: z.string().min(1).max(2_000_000).optional(), metadata: z.record(z.unknown()).default({}) }).refine((input) => Boolean(input.content || input.sourceUri), 'content or sourceUri is required');
const searchInput = z.object({ query: z.string().min(2).max(1000), limit: z.number().int().min(1).max(20).default(8) });
export async function knowledgeRoutes(app: FastifyInstance) {
  app.get('/documents', { preHandler: app.authenticate }, asyncRoute(async (request) => ({ data: (await query('SELECT id,name,source_type,source_uri,file_id,status,metadata,created_at,updated_at FROM knowledge_documents WHERE workspace_id=$1 ORDER BY created_at DESC', [request.user.workspaceId])).rows })));
  app.get('/documents/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const document = (await query('SELECT id,name,source_type,source_uri,file_id,status,metadata,content,created_at,updated_at FROM knowledge_documents WHERE id=$1 AND workspace_id=$2', [id, request.user.workspaceId])).rows[0];
    if (!document) return reply.code(404).send({ error: 'DOCUMENT_NOT_FOUND' });
    const chunks = await query('SELECT id,ordinal,content,metadata FROM knowledge_chunks WHERE document_id=$1 AND workspace_id=$2 ORDER BY ordinal LIMIT 100', [id, request.user.workspaceId]);
    return { ...document, chunks: chunks.rows, chunk_count: chunks.rows.length };
  }));
  app.post('/documents', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(inputSchema, request.body, reply); if (!input) return;
    const result = await query('INSERT INTO knowledge_documents(workspace_id,name,source_type,source_uri,content,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,source_type,status,created_at', [request.user.workspaceId, input.name, input.sourceType, input.sourceUri ?? null, input.content ?? null, JSON.stringify(input.metadata), request.user.sub]);
    await enqueueKnowledgeDocument(result.rows[0].id);
    return reply.code(202).send(result.rows[0]);
  }));
  app.post('/documents/upload', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: 'FILE_REQUIRED' });
    const stored = await ingestUploadedFile({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      upload,
      scope: 'knowledge',
    });
    const document = await ensureKnowledgeDocument({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      fileId: stored.file.id,
    });
    return reply.code(202).send(document);
  }));
  app.post('/search', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(searchInput, request.body, reply); if (!input) return;
    const embedding = await embeddingFor(input.query).catch(() => null);
    if (embedding) {
      const vector = `[${embedding.join(',')}]`;
      const results = await query("SELECT c.id,c.document_id,d.name document_name,c.ordinal,c.content,c.metadata,1-(c.embedding <=> $2::vector) score FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.workspace_id=$1 AND c.embedding IS NOT NULL ORDER BY c.embedding <=> $2::vector LIMIT $3", [request.user.workspaceId, vector, input.limit]);
      return { mode: 'semantic', data: results.rows };
    }
    const results = await query("SELECT c.id,c.document_id,d.name document_name,c.ordinal,c.content,c.metadata,ts_rank(c.search_vector,websearch_to_tsquery('simple',$2)) score FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.workspace_id=$1 AND c.search_vector @@ websearch_to_tsquery('simple',$2) ORDER BY score DESC,c.ordinal LIMIT $3", [request.user.workspaceId, input.query, input.limit]);
    return { mode: 'full_text', data: results.rows };
  }));
  app.delete('/documents/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const result = await query<{ id: string; file_id: string | null }>('DELETE FROM knowledge_documents WHERE id=$1 AND workspace_id=$2 RETURNING id,file_id', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'DOCUMENT_NOT_FOUND' });
    if (result.rows[0].file_id) {
      await query("UPDATE files SET scope='saved',updated_at=now() WHERE id=$1 AND workspace_id=$2", [result.rows[0].file_id, request.user.workspaceId]);
    }
    return reply.code(204).send();
  }));
}
