import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import {
  deleteStoredFile, ensureKnowledgeDocument, ingestFileBuffer, ingestUploadedFile, updateFileRetention,
} from '../files/service.js';
import { privateFileStorage } from '../files/storage.js';
import { type FileRecord } from '../files/types.js';
import { compareFiles } from '../files/compare.js';
import { secureLinkAdapter } from '../files/imports/secure-link.js';

const fileScope = z.enum(['task', 'conversation', 'saved', 'knowledge']);
const retentionPolicy = z.enum(['keep', '30_days', 'delete_after_task', 'delete_after_conversation']);

function publicFile(file: FileRecord) {
  const { storage_key: _storageKey, sha256: _sha256, ...safe } = file;
  return safe;
}

export async function fileRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const files = await query<FileRecord>(
      `SELECT * FROM files WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [request.user.workspaceId],
    );
    return { data: files.rows.map(publicFile) };
  }));

  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: 'FILE_REQUIRED' });
    const rawScope = upload.fields.scope && 'value' in upload.fields.scope ? upload.fields.scope.value : 'saved';
    const scope = fileScope.safeParse(rawScope);
    if (!scope.success) return reply.code(400).send({ error: 'FILE_SCOPE_INVALID' });
    const stored = await ingestUploadedFile({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      upload,
      scope: scope.data,
    });
    await audit(request.user.workspaceId, request.user.sub, 'file.uploaded', 'file', stored.file.id, {
      extension: stored.file.extension,
      sizeBytes: Number(stored.file.size_bytes),
      scope: scope.data,
      deduplicated: stored.deduplicated,
    });
    return reply.code(stored.deduplicated ? 200 : 202).send({ ...publicFile(stored.file), deduplicated: stored.deduplicated });
  }));

  app.post('/import', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(z.object({
      provider: z.literal('secure_link'),
      url: z.string().url().max(2_048),
      filename: z.string().trim().min(1).max(260).optional(),
      scope: fileScope.default('saved'),
    }), request.body, reply);
    if (!input) return;
    const scope = input.scope ?? 'saved';
    const downloaded = await secureLinkAdapter.download({ ...input, scope });
    const stored = await ingestFileBuffer({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      filename: downloaded.filename,
      mimetype: downloaded.mimetype,
      buffer: downloaded.buffer,
      scope,
    });
    await audit(request.user.workspaceId, request.user.sub, 'file.cloud_imported', 'file', stored.file.id, {
      provider: downloaded.provider,
      extension: stored.file.extension,
      sizeBytes: Number(stored.file.size_bytes),
      deduplicated: stored.deduplicated,
    });
    return reply.code(stored.deduplicated ? 200 : 202).send({
      ...publicFile(stored.file), deduplicated: stored.deduplicated, importedFrom: downloaded.provider,
    });
  }));

  app.post('/compare', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(z.object({
      fileIds: z.array(z.string().uuid()).length(2).refine((ids) => ids[0] !== ids[1], 'Choose two different files'),
    }), request.body, reply);
    if (!input) return;
    return compareFiles(request.user.workspaceId, input.fileIds as [string, string]);
  }));

  app.get('/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const file = (await query<FileRecord>('SELECT * FROM files WHERE id=$1 AND workspace_id=$2', [id, request.user.workspaceId])).rows[0];
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    const extraction = (await query(
      `SELECT status,summary,characters,structured_content,error_message,created_at,updated_at,completed_at
       FROM file_extractions WHERE file_id=$1 AND workspace_id=$2`,
      [id, request.user.workspaceId],
    )).rows[0] ?? null;
    return { ...publicFile(file), extraction };
  }));

  app.get('/:id/versions', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const file = (await query<FileRecord>(
      'SELECT * FROM files WHERE id=$1 AND workspace_id=$2',
      [id, request.user.workspaceId],
    )).rows[0];
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    const versions = await query<FileRecord>(
      `SELECT * FROM files WHERE workspace_id=$1 AND version_group_id=$2
       ORDER BY version_number DESC`,
      [request.user.workspaceId, file.version_group_id],
    );
    return { data: versions.rows.map(publicFile) };
  }));

  app.post('/:id/versions', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parent = (await query<FileRecord>(
      'SELECT * FROM files WHERE id=$1 AND workspace_id=$2',
      [id, request.user.workspaceId],
    )).rows[0];
    if (!parent) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: 'FILE_REQUIRED' });
    const stored = await ingestUploadedFile({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      upload,
      scope: parent.scope,
      versionOf: parent,
    });
    await audit(request.user.workspaceId, request.user.sub, 'file.version_created', 'file', stored.file.id, {
      replacesFileId: parent.id,
      versionNumber: stored.file.version_number,
      deduplicated: stored.deduplicated,
    });
    return reply.code(stored.deduplicated ? 200 : 202).send({
      ...publicFile(stored.file), deduplicated: stored.deduplicated,
    });
  }));

  app.get('/:id/spreadsheet', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const options = parse(z.object({
      sheet: z.string().max(200).optional(),
      startRow: z.coerce.number().int().min(1).max(10_000).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }), request.query, reply);
    if (!options) return;
    const startRow = options.startRow ?? 1;
    const limit = options.limit ?? 100;
    const row = (await query<{ original_name: string; extension: string; status: string; structured_content: Record<string, unknown> }>(
      `SELECT f.original_name,f.extension,f.status,e.structured_content
       FROM files f LEFT JOIN file_extractions e ON e.file_id=f.id AND e.workspace_id=f.workspace_id
       WHERE f.id=$1 AND f.workspace_id=$2`,
      [id, request.user.workspaceId],
    )).rows[0];
    if (!row) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    if (row.status !== 'ready') return reply.code(409).send({ error: 'FILE_NOT_READY' });
    const structured = row.structured_content as {
      type?: string;
      sheets?: Array<{ name?: string; range?: string; rows?: unknown[][]; rowCount?: number; columnCount?: number; truncated?: boolean }>;
      rows?: unknown[][];
      rowCount?: number;
      columnCount?: number;
    };
    const sheets = structured.type === 'csv'
      ? [{ name: 'CSV', range: '', rows: structured.rows ?? [], rowCount: structured.rowCount ?? 0, columnCount: structured.columnCount ?? 0, truncated: false }]
      : structured.type === 'spreadsheet' ? structured.sheets ?? [] : [];
    if (!sheets.length) return reply.code(415).send({ error: 'FILE_IS_NOT_STRUCTURED_TABULAR_DATA' });
    const selected = options.sheet
      ? sheets.find((sheet) => sheet.name === options.sheet)
      : sheets[0];
    if (!selected) return reply.code(404).send({ error: 'SHEET_NOT_FOUND' });
    const start = startRow - 1;
    return {
      file: { id, original_name: row.original_name, extension: row.extension },
      sheets: sheets.map(({ rows: _rows, ...sheet }) => sheet),
      sheet: selected.name,
      startRow,
      rows: (selected.rows ?? []).slice(start, start + limit),
      rowCount: selected.rowCount ?? selected.rows?.length ?? 0,
      columnCount: selected.columnCount ?? 0,
      truncated: Boolean(selected.truncated),
      hasMore: start + limit < (selected.rowCount ?? selected.rows?.length ?? 0),
    };
  }));

  app.get('/:id/preview', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const file = (await query<FileRecord>('SELECT * FROM files WHERE id=$1 AND workspace_id=$2', [id, request.user.workspaceId])).rows[0];
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    if (file.status !== 'ready') return reply.code(409).send({ error: 'FILE_NOT_READY' });
    const extraction = (await query<{ content: string; structured_content: Record<string, unknown>; summary: string; characters: number }>(
      `SELECT content,structured_content,summary,characters FROM file_extractions
       WHERE file_id=$1 AND workspace_id=$2 AND status='ready'`,
      [id, request.user.workspaceId],
    )).rows[0];
    const chunks = await query<{ ordinal: number; locator: string; content: string; metadata: Record<string, unknown> }>(
      `SELECT ordinal,locator,content,metadata FROM file_chunks
       WHERE file_id=$1 AND workspace_id=$2 ORDER BY ordinal LIMIT 50`,
      [id, request.user.workspaceId],
    );
    return {
      file: publicFile(file),
      extraction: extraction ? {
        ...extraction,
        content: extraction.content.slice(0, 100_000),
        truncated: extraction.content.length > 100_000,
      } : null,
      chunks: chunks.rows,
    };
  }));

  app.get('/:id/download', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const file = (await query<FileRecord>('SELECT * FROM files WHERE id=$1 AND workspace_id=$2', [id, request.user.workspaceId])).rows[0];
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    const stored = await privateFileStorage().open(file.storage_key);
    reply.header('content-type', file.mime_type);
    reply.header('content-length', String(stored.size));
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(stored.stream);
  }));

  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(z.object({ retentionPolicy }), request.body, reply); if (!input) return;
    const updated = await updateFileRetention(request.user.workspaceId, (request.params as { id: string }).id, input.retentionPolicy);
    if (!updated) return reply.code(404).send({ error: 'FILE_NOT_FOUND_OR_IMMUTABLE' });
    return publicFile(updated);
  }));

  app.post('/:id/add-to-knowledge', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const confirmation = parse(z.object({ confirmed: z.literal(true) }), request.body, reply); if (!confirmation) return;
    const document = await ensureKnowledgeDocument({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      fileId: (request.params as { id: string }).id,
    });
    await audit(request.user.workspaceId, request.user.sub, 'file.promoted_to_knowledge', 'file', (request.params as { id: string }).id, { documentId: document.id });
    return reply.code(202).send(document);
  }));

  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const file = (await query<FileRecord>('SELECT * FROM files WHERE id=$1 AND workspace_id=$2', [id, request.user.workspaceId])).rows[0];
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    const membership = (await query<{ role: string }>(
      'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
      [request.user.workspaceId, request.user.sub],
    )).rows[0];
    if (file.uploaded_by !== request.user.sub && !['owner', 'admin'].includes(membership?.role ?? '')) return reply.code(403).send({ error: 'FORBIDDEN' });
    const knowledge = await query('SELECT id FROM knowledge_documents WHERE file_id=$1 AND workspace_id=$2', [id, request.user.workspaceId]);
    if (knowledge.rowCount) return reply.code(409).send({ error: 'FILE_IS_KNOWLEDGE_SOURCE' });
    await deleteStoredFile(file);
    await audit(request.user.workspaceId, request.user.sub, 'file.deleted', 'file', file.id);
    return reply.code(204).send();
  }));
}
