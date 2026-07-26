import { createHash, randomUUID } from 'node:crypto';
import { db, query } from '../db/client.js';
import { enqueueFile, enqueueKnowledgeDocument } from '../queue/task-queue.js';
import { privateFileStorage } from './storage.js';
import { defaultRetention, inspectUpload, type FileRecord, type FileScope, type RetentionPolicy } from './types.js';
import {
  childTraceContext,
  createTraceContext,
  type TraceContext,
} from '../runtime/trace.js';
import { combinedAbortSignal } from '../runtime/cancellation.js';

type UploadLike = {
  filename: string;
  mimetype: string;
  toBuffer(): Promise<Buffer>;
};

type ExtractedSection = {
  locator?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

type ExtractedPayload = {
  name: string;
  content: string;
  characters: number;
  structured?: Record<string, unknown>;
  sections?: ExtractedSection[];
  metadata?: Record<string, unknown>;
};

function splitIntoChunks(content: string, chunkSize = 1_200, overlap = 200) {
  const clean = content.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += chunkSize - overlap) {
    const slice = clean.slice(start, start + chunkSize);
    const boundary = slice.lastIndexOf('\n');
    const end = boundary > chunkSize * 0.5 ? start + boundary : start + slice.length;
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
  }
  return chunks.filter(Boolean);
}

function sourceType(extension: string) {
  if (extension === 'pdf' || extension === 'docx' || extension === 'pptx') return extension;
  if (['xlsx', 'xlsm', 'csv'].includes(extension)) return 'csv';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return 'image';
  return 'text';
}

export async function ingestUploadedFile(input: {
  workspaceId: string;
  userId: string;
  upload: UploadLike;
  scope: FileScope;
  versionOf?: FileRecord;
}) {
  const buffer = await input.upload.toBuffer();
  return ingestFileBuffer({
    workspaceId: input.workspaceId,
    userId: input.userId,
    filename: input.upload.filename,
    mimetype: input.upload.mimetype,
    buffer,
    scope: input.scope,
    versionOf: input.versionOf,
  });
}

export async function ingestFileBuffer(input: {
  workspaceId: string;
  userId: string;
  filename: string;
  mimetype: string;
  buffer: Buffer;
  scope: FileScope;
  versionOf?: FileRecord;
}) {
  if (input.versionOf && input.versionOf.workspace_id !== input.workspaceId) {
    throw Object.assign(new Error('FILE_NOT_FOUND'), { statusCode: 404 });
  }
  const inspected = inspectUpload(input.filename, input.mimetype, input.buffer);
  if (input.versionOf && inspected.extension !== input.versionOf.extension) {
    throw Object.assign(new Error('FILE_VERSION_TYPE_MUST_MATCH'), { statusCode: 400 });
  }
  const buffer = input.buffer;
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const existing = (await query<FileRecord>(
    `SELECT * FROM files WHERE workspace_id=$1 AND sha256=$2`,
    [input.workspaceId, sha256],
  )).rows[0];
  if (existing) {
    if (input.versionOf) throw Object.assign(new Error('FILE_VERSION_ALREADY_EXISTS'), { statusCode: 409 });
    return { file: existing, deduplicated: true };
  }

  const id = randomUUID();
  const storage = privateFileStorage();
  const storageKey = `${input.workspaceId}/${id}.${inspected.extension}`;
  const retention = defaultRetention(input.scope);
  const versionGroupId = input.versionOf?.version_group_id ?? id;
  const versionNumber = input.versionOf
    ? Number((await query<{ next_version: string }>(
      `SELECT COALESCE(MAX(version_number),0)+1 AS next_version
       FROM files WHERE workspace_id=$1 AND version_group_id=$2`,
      [input.workspaceId, versionGroupId],
    )).rows[0]?.next_version ?? 1)
    : 1;
  await storage.put(storageKey, buffer);
  let file: FileRecord;
  try {
    file = (await query<FileRecord>(
      `INSERT INTO files(
        id,workspace_id,uploaded_by,original_name,extension,mime_type,size_bytes,sha256,
        storage_provider,storage_key,status,scan_status,scope,retention_policy,expires_at,
        version_group_id,version_number,replaces_file_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scanning','pending',$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        id, input.workspaceId, input.userId, inspected.name, inspected.extension, inspected.mimeType,
        buffer.length, sha256, storage.provider, storageKey, input.scope, retention.policy, retention.expiresAt,
        versionGroupId, versionNumber, input.versionOf?.id ?? null,
      ],
    )).rows[0];
  } catch (error) {
    await storage.delete(storageKey);
    if ((error as { code?: string }).code === '23505') {
      const raced = (await query<FileRecord>('SELECT * FROM files WHERE workspace_id=$1 AND sha256=$2', [input.workspaceId, sha256])).rows[0];
      if (raced) {
        if (input.versionOf) throw Object.assign(new Error('FILE_VERSION_ALREADY_EXISTS'), { statusCode: 409 });
        return { file: raced, deduplicated: true };
      }
    }
    throw error;
  }
  await query(
    `INSERT INTO file_extractions(workspace_id,file_id,status) VALUES($1,$2,'pending')`,
    [input.workspaceId, file.id],
  );
  if (process.env.NODE_ENV === 'test' && process.env.RUN_INTEGRATION === 'true') {
    await processFile(file.id, childTraceContext(createTraceContext()));
  } else try {
    await enqueueFile(file.id, file.id, childTraceContext(createTraceContext()));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'File processing queue unavailable';
    await query("UPDATE files SET status='failed',error_message=$1,updated_at=now() WHERE id=$2", [message.slice(0, 2_000), file.id]);
    throw Object.assign(new Error('FILE_QUEUE_UNAVAILABLE'), { statusCode: 503 });
  }
  return { file, deduplicated: false };
}

async function scanFile(file: FileRecord, content: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const endpoint = process.env.MALWARE_SCANNER_URL;
  if (!endpoint) {
    await query("UPDATE files SET scan_status='not_configured',updated_at=now() WHERE id=$1", [file.id]);
    return;
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(content)], { type: file.mime_type }), file.original_name);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: process.env.MALWARE_SCANNER_TOKEN ? { authorization: `Bearer ${process.env.MALWARE_SCANNER_TOKEN}` } : {},
    body: form,
    signal: combinedAbortSignal(signal, 30_000),
  });
  if (!response.ok) throw new Error(`Malware scanner returned ${response.status}`);
  const result = await response.json() as { clean?: boolean; infected?: boolean; detail?: string };
  if (result.infected || result.clean === false) {
    await query("UPDATE files SET status='failed',scan_status='infected',error_message='Malware scan rejected this file',updated_at=now() WHERE id=$1", [file.id]);
    throw new Error('FILE_MALWARE_DETECTED');
  }
  await query("UPDATE files SET scan_status='clean',updated_at=now() WHERE id=$1", [file.id]);
}

function extractionUrl() {
  return `${(process.env.EXTRACTOR_URL ?? 'http://localhost:8000').replace(/\/$/, '')}/extract`;
}

async function extractFile(file: FileRecord, content: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(content)], { type: file.mime_type }), file.original_name);
  const response = await fetch(extractionUrl(), {
    method: 'POST',
    headers: process.env.EXTRACTOR_TOKEN ? { authorization: `Bearer ${process.env.EXTRACTOR_TOKEN}` } : {},
    body: form,
    signal: combinedAbortSignal(signal, 120_000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(detail?.detail ?? `Document extractor returned ${response.status}`);
  }
  const extracted = await response.json() as ExtractedPayload;
  if (!extracted.content?.trim()) throw new Error('FILE_HAS_NO_EXTRACTABLE_CONTENT');
  if (extracted.content.length > 2_000_000) throw new Error('FILE_EXTRACTED_CONTENT_TOO_LARGE');
  return extracted;
}

function extractedChunks(extracted: ExtractedPayload) {
  const sections = Array.isArray(extracted.sections) && extracted.sections.length
    ? extracted.sections
    : [{ locator: 'Document', content: extracted.content, metadata: {} }];
  const seen = new Set<string>();
  const chunks: Array<{ locator: string; content: string; metadata: Record<string, unknown> }> = [];
  for (const section of sections) {
    const locator = typeof section.locator === 'string' && section.locator.trim() ? section.locator.slice(0, 500) : 'Document';
    const metadata = section.metadata && typeof section.metadata === 'object' ? section.metadata : {};
    for (const content of splitIntoChunks(typeof section.content === 'string' ? section.content : '')) {
      const key = createHash('sha256').update(`${locator}\0${content}`).digest('hex');
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push({ locator, content, metadata });
      if (chunks.length >= 800) return chunks;
    }
  }
  return chunks;
}

export async function processFile(
  fileId: string,
  trace: TraceContext = childTraceContext(createTraceContext()),
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const file = (await query<FileRecord>(
    `UPDATE files SET status='scanning',error_message=NULL,updated_at=now()
      WHERE id=$1 AND status IN ('scanning','extracting','failed') RETURNING *`,
    [fileId],
  )).rows[0];
  if (!file) return null;
  try {
    const content = await privateFileStorage().read(file.storage_key);
    await scanFile(file, content, signal);
    await query("UPDATE files SET status='extracting',updated_at=now() WHERE id=$1", [file.id]);
    await query("UPDATE file_extractions SET status='processing',error_message=NULL,updated_at=now() WHERE file_id=$1", [file.id]);
    const extracted = await extractFile(file, content, signal);
    signal?.throwIfAborted();
    const chunks = extractedChunks(extracted);
    if (!chunks.length) throw new Error('FILE_HAS_NO_INDEXABLE_CONTENT');

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM file_chunks WHERE file_id=$1', [file.id]);
      for (const [ordinal, chunk] of chunks.entries()) {
        await client.query(
          `INSERT INTO file_chunks(workspace_id,file_id,ordinal,locator,content,metadata)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [file.workspace_id, file.id, ordinal, chunk.locator, chunk.content, JSON.stringify(chunk.metadata)],
        );
      }
      const summary = extracted.content.replace(/\s+/g, ' ').trim().slice(0, 800);
      await client.query(
        `UPDATE file_extractions SET status='ready',content=$1,summary=$2,structured_content=$3,
          characters=$4,error_message=NULL,completed_at=now(),updated_at=now() WHERE file_id=$5`,
        [
          extracted.content, summary, JSON.stringify(extracted.structured ?? {}),
          Number(extracted.characters ?? extracted.content.length), file.id,
        ],
      );
      await client.query(
        `UPDATE files SET status='ready',error_message=NULL,
          metadata=metadata || $1::jsonb,completed_at=now(),updated_at=now() WHERE id=$2`,
        [JSON.stringify({ ...(extracted.metadata ?? {}), chunkCount: chunks.length, characters: extracted.characters }), file.id],
      );
      await client.query(
        `UPDATE knowledge_documents SET content=$1,status='queued',
          metadata=metadata || $2::jsonb,updated_at=now()
          WHERE file_id=$3 AND status='waiting_file'`,
        [extracted.content, JSON.stringify({ characters: extracted.characters, sourceFileId: file.id }), file.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const waitingKnowledge = await query<{ id: string }>(
      `SELECT id FROM knowledge_documents WHERE file_id=$1 AND status='queued'`,
      [file.id],
    );
    await Promise.all(waitingKnowledge.rows.map((row) => (
      enqueueKnowledgeDocument(row.id, childTraceContext(trace))
    )));
    return (await query<FileRecord>('SELECT * FROM files WHERE id=$1', [file.id])).rows[0];
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'File processing failed').slice(0, 2_000);
    await query(
      `UPDATE files SET status='failed',scan_status=CASE WHEN status='scanning' THEN 'failed' ELSE scan_status END,
        error_message=$1,updated_at=now() WHERE id=$2`,
      [message, file.id],
    );
    await query("UPDATE file_extractions SET status='failed',error_message=$1,updated_at=now() WHERE file_id=$2", [message, file.id]);
    await query("UPDATE knowledge_documents SET status='failed',metadata=metadata || jsonb_build_object('error',$1),updated_at=now() WHERE file_id=$2 AND status='waiting_file'", [message, file.id]);
    throw error;
  }
}

export async function ensureKnowledgeDocument(input: {
  workspaceId: string;
  userId: string;
  fileId: string;
  trace?: TraceContext;
}) {
  const file = (await query<FileRecord>('SELECT * FROM files WHERE id=$1 AND workspace_id=$2', [input.fileId, input.workspaceId])).rows[0];
  if (!file) throw Object.assign(new Error('FILE_NOT_FOUND'), { statusCode: 404 });
  if (file.status === 'failed') throw Object.assign(new Error('FILE_NOT_READY'), { statusCode: 409 });
  const extraction = file.status === 'ready'
    ? (await query<{ content: string }>('SELECT content FROM file_extractions WHERE file_id=$1 AND status=$2', [file.id, 'ready'])).rows[0]
    : null;
  const status = extraction?.content ? 'queued' : 'waiting_file';
  const document = (await query<{ id: string; name: string; source_type: string; status: string; created_at: Date }>(
    `INSERT INTO knowledge_documents(workspace_id,name,source_type,content,metadata,created_by,file_id,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (file_id) WHERE file_id IS NOT NULL
     DO UPDATE SET updated_at=now()
     RETURNING id,name,source_type,status,created_at`,
    [
      input.workspaceId, file.original_name, sourceType(file.extension), extraction?.content ?? null,
      JSON.stringify({ sourceFileId: file.id, uploadedContentType: file.mime_type }),
      input.userId, file.id, status,
    ],
  )).rows[0];
  await query("UPDATE files SET scope='knowledge',retention_policy='keep',expires_at=NULL,updated_at=now() WHERE id=$1", [file.id]);
  if (status === 'queued') {
    await enqueueKnowledgeDocument(
      document.id,
      childTraceContext(input.trace ?? createTraceContext()),
    );
  }
  return document;
}

export async function updateFileRetention(
  workspaceId: string,
  fileId: string,
  policy: RetentionPolicy,
) {
  const expiresAt = policy === '30_days' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000) : null;
  return (await query<FileRecord>(
    `UPDATE files SET retention_policy=$1,expires_at=$2,updated_at=now()
      WHERE id=$3 AND workspace_id=$4 AND scope <> 'knowledge' RETURNING *`,
    [policy, expiresAt, fileId, workspaceId],
  )).rows[0];
}

export async function deleteStoredFile(file: FileRecord) {
  await privateFileStorage().delete(file.storage_key);
  await query('DELETE FROM files WHERE id=$1 AND workspace_id=$2', [file.id, file.workspace_id]);
}

export async function purgeExpiredFiles() {
  const expired = await query<FileRecord>(
    `SELECT * FROM files WHERE expires_at IS NOT NULL AND expires_at <= now() AND scope <> 'knowledge' LIMIT 100`,
  );
  for (const file of expired.rows) await deleteStoredFile(file);
  return expired.rowCount;
}
