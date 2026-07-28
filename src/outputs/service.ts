import type { PoolClient } from 'pg';
import { outputText } from '../artifacts/types.js';
import { db, query } from '../db/client.js';
import {
  createOutputContentHash,
  outputContentSchema,
  type OutputDocumentDetail,
  type OutputDocumentRecord,
  type OutputVersionRecord,
} from './types.js';

function outputError(code: string, statusCode: number) {
  return Object.assign(new Error(code), { statusCode });
}

function validatedContent(content: string) {
  const parsed = outputContentSchema.safeParse(content);
  if (!parsed.success) throw outputError('OUTPUT_CONTENT_INVALID', 400);
  return parsed.data;
}

async function versionsFor(
  workspaceId: string,
  documentId: string,
  client?: Pick<PoolClient, 'query'>,
) {
  const runner = client ?? db;
  return (await runner.query<OutputVersionRecord>(
    `SELECT v.id,v.workspace_id,v.document_id,v.version_number,v.content,v.content_hash,
            v.created_by,u.display_name created_by_name,v.created_at
       FROM output_document_versions v
       LEFT JOIN users u ON u.id=v.created_by
      WHERE v.document_id=$1 AND v.workspace_id=$2
      ORDER BY v.version_number DESC`,
    [documentId, workspaceId],
  )).rows;
}

async function detailForDocument(
  document: OutputDocumentRecord,
  client?: Pick<PoolClient, 'query'>,
): Promise<OutputDocumentDetail> {
  const versions = await versionsFor(document.workspace_id, document.id, client);
  const currentVersion = versions.find((version) => version.version_number === document.current_version_number);
  if (!currentVersion) throw outputError('OUTPUT_CURRENT_VERSION_MISSING', 500);
  return { ...document, currentVersion, versions };
}

export async function getOutputDocument(workspaceId: string, documentId: string) {
  const document = (await query<OutputDocumentRecord>(
    `SELECT id,workspace_id,task_id,current_version_number,created_by,created_at,updated_at
       FROM output_documents WHERE id=$1 AND workspace_id=$2`,
    [documentId, workspaceId],
  )).rows[0];
  return document ? detailForDocument(document) : null;
}

export async function getTaskOutputDocument(workspaceId: string, taskId: string) {
  const document = (await query<OutputDocumentRecord>(
    `SELECT id,workspace_id,task_id,current_version_number,created_by,created_at,updated_at
       FROM output_documents WHERE task_id=$1 AND workspace_id=$2`,
    [taskId, workspaceId],
  )).rows[0];
  return document ? detailForDocument(document) : null;
}

export async function getOutputDocumentVersion(workspaceId: string, versionId: string) {
  return (await query<OutputVersionRecord>(
    `SELECT id,workspace_id,document_id,version_number,content,content_hash,
            created_by,created_at
       FROM output_document_versions
      WHERE id=$1 AND workspace_id=$2`,
    [versionId, workspaceId],
  )).rows[0] ?? null;
}

export async function initializeTaskOutputDocument(input: {
  workspaceId: string;
  taskId: string;
  actorId: string;
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const task = (await client.query<{ output: unknown; status: string }>(
      'SELECT output,status FROM tasks WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
      [input.taskId, input.workspaceId],
    )).rows[0];
    if (!task) throw outputError('OUTPUT_TASK_NOT_FOUND', 404);
    if (task.status !== 'completed') throw outputError('OUTPUT_TASK_NOT_COMPLETED', 409);
    const content = outputText(task.output);
    if (!content.trim()) throw outputError('OUTPUT_SOURCE_EMPTY', 409);
    const inserted = (await client.query<OutputDocumentRecord>(
      `INSERT INTO output_documents(workspace_id,task_id,current_version_number,created_by)
       VALUES($1,$2,1,$3)
       ON CONFLICT(task_id) DO NOTHING
       RETURNING id,workspace_id,task_id,current_version_number,created_by,created_at,updated_at`,
      [input.workspaceId, input.taskId, input.actorId],
    )).rows[0];
    const document = inserted ?? (await client.query<OutputDocumentRecord>(
      `SELECT id,workspace_id,task_id,current_version_number,created_by,created_at,updated_at
         FROM output_documents WHERE task_id=$1 AND workspace_id=$2 FOR UPDATE`,
      [input.taskId, input.workspaceId],
    )).rows[0];
    if (!document) throw outputError('OUTPUT_DOCUMENT_INITIALIZATION_FAILED', 500);
    if (inserted) {
      await client.query(
        `INSERT INTO output_document_versions(
           workspace_id,document_id,version_number,content,content_hash,created_by
         ) VALUES($1,$2,1,$3,$4,$5)`,
        [input.workspaceId, document.id, content, createOutputContentHash(content), input.actorId],
      );
    }
    await client.query('COMMIT');
    const detail = await getOutputDocument(input.workspaceId, document.id);
    if (!detail) throw outputError('OUTPUT_DOCUMENT_INITIALIZATION_FAILED', 500);
    return detail;
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

async function insertNextVersion(input: {
  client: PoolClient;
  workspaceId: string;
  documentId: string;
  actorId: string;
  content: string;
  baseVersionNumber: number;
}) {
  const document = (await input.client.query<OutputDocumentRecord>(
    `SELECT id,workspace_id,task_id,current_version_number,created_by,created_at,updated_at
       FROM output_documents WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
    [input.documentId, input.workspaceId],
  )).rows[0];
  if (!document) throw outputError('OUTPUT_DOCUMENT_NOT_FOUND', 404);
  if (document.current_version_number !== input.baseVersionNumber) {
    throw outputError('OUTPUT_VERSION_CONFLICT', 409);
  }
  const nextVersionNumber = document.current_version_number + 1;
  await input.client.query(
    `INSERT INTO output_document_versions(
       workspace_id,document_id,version_number,content,content_hash,created_by
     ) VALUES($1,$2,$3,$4,$5,$6)`,
    [
      input.workspaceId,
      input.documentId,
      nextVersionNumber,
      input.content,
      createOutputContentHash(input.content),
      input.actorId,
    ],
  );
  const updated = (await input.client.query<OutputDocumentRecord>(
    `UPDATE output_documents SET current_version_number=$1,updated_at=now()
      WHERE id=$2 AND workspace_id=$3
      RETURNING id,workspace_id,task_id,current_version_number,created_by,created_at,updated_at`,
    [nextVersionNumber, input.documentId, input.workspaceId],
  )).rows[0];
  return detailForDocument(updated, input.client);
}

export async function saveOutputVersion(input: {
  workspaceId: string;
  documentId: string;
  actorId: string;
  content: string;
  baseVersionNumber: number;
}) {
  const content = validatedContent(input.content);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const detail = await insertNextVersion({ ...input, content, client });
    await client.query('COMMIT');
    return detail;
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

export async function revertOutputVersion(input: {
  workspaceId: string;
  documentId: string;
  actorId: string;
  versionId: string;
  baseVersionNumber: number;
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const version = (await client.query<Pick<OutputVersionRecord, 'content'>>(
      `SELECT content FROM output_document_versions
        WHERE id=$1 AND document_id=$2 AND workspace_id=$3`,
      [input.versionId, input.documentId, input.workspaceId],
    )).rows[0];
    if (!version) throw outputError('OUTPUT_VERSION_NOT_FOUND', 404);
    const detail = await insertNextVersion({ ...input, content: version.content, client });
    await client.query('COMMIT');
    return detail;
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}
