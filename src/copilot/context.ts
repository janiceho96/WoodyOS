import { db } from '../db/client.js';
import type { QueryRunner } from '../lib/audit.js';
import type {
  CopilotContextRequest,
  CopilotContextSnapshot,
  CopilotContextSnapshotRecord,
  CopilotContextView,
} from './types.js';

type ContextRow = {
  thread_id: string;
  task_id: string;
  task_status: string;
  output_document_id: string;
  output_version_id: string;
  output_version_number: number;
  output_content_hash: string;
  workflow_id: string | null;
  workflow_published_version_id: string | null;
  workflow_draft_revision: number | null;
  workflow_run_id: string | null;
  workflow_run_status: string | null;
  workflow_version_id: string | null;
};

function contextError() {
  return Object.assign(new Error('COPILOT_CONTEXT_NOT_FOUND'), { statusCode: 404 });
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function equivalentAuthoritativeSnapshot(
  left: CopilotContextSnapshot,
  right: CopilotContextSnapshot,
) {
  const workflowEquivalent = left.workflow === null
    ? right.workflow === null
    : right.workflow !== null
      && left.workflow.id === right.workflow.id
      && left.workflow.publishedVersionId === right.workflow.publishedVersionId
      && left.workflow.draftRevision === right.workflow.draftRevision;
  const runEquivalent = left.run === null
    ? right.run === null
    : right.run !== null
      && left.run.id === right.run.id
      && left.run.status === right.run.status
      && left.run.workflowVersionId === right.run.workflowVersionId;
  return left.schemaVersion === right.schemaVersion
    && left.workspaceId === right.workspaceId
    && left.actorId === right.actorId
    && workflowEquivalent
    && runEquivalent
    && left.task.id === right.task.id
    && left.task.status === right.task.status
    && left.output.documentId === right.output.documentId
    && left.output.versionId === right.output.versionId
    && left.output.versionNumber === right.output.versionNumber
    && left.output.contentHash === right.output.contentHash;
}

export function contextView(record: CopilotContextSnapshotRecord): CopilotContextView {
  return {
    id: record.id,
    workflow: record.snapshot.workflow,
    run: record.snapshot.run,
    task: record.snapshot.task,
    output: record.snapshot.output,
    capturedAt: record.snapshot.capturedAt,
  };
}

export async function resolveCopilotContext(
  input: {
    workspaceId: string;
    actorId: string;
    threadId: string;
    request: CopilotContextRequest;
  },
  runner: QueryRunner = db,
): Promise<CopilotContextSnapshotRecord> {
  const row = (await runner.query<ContextRow>(
    `SELECT thread.id thread_id,
            task.id task_id,task.status::text task_status,
            document.id output_document_id,version.id output_version_id,
            version.version_number output_version_number,version.content_hash output_content_hash,
            workflow.id workflow_id,workflow.published_version_id workflow_published_version_id,
            workflow.draft_revision workflow_draft_revision,
            run.id workflow_run_id,run.status::text workflow_run_status,
            run.workflow_version_id
       FROM chat_threads thread
       JOIN tasks task ON task.id=$4 AND task.workspace_id=thread.workspace_id
       JOIN output_documents document
         ON document.id=$5 AND document.task_id=task.id AND document.workspace_id=thread.workspace_id
       JOIN output_document_versions version
         ON version.document_id=document.id AND version.version_number=document.current_version_number
       LEFT JOIN workflow_runs run ON run.id=task.workflow_run_id AND run.workspace_id=thread.workspace_id
       LEFT JOIN workflows workflow ON workflow.id=run.workflow_id AND workflow.workspace_id=thread.workspace_id
      WHERE thread.id=$1 AND thread.workspace_id=$2 AND thread.created_by=$3 AND thread.status='active'
        AND ($6::uuid IS NULL OR run.id=$6::uuid)
        AND ($7::uuid IS NULL OR workflow.id=$7::uuid)`,
    [
      input.threadId,
      input.workspaceId,
      input.actorId,
      input.request.taskId,
      input.request.outputDocumentId,
      input.request.workflowRunId ?? null,
      input.request.workflowId ?? null,
    ],
  )).rows[0];
  if (!row) throw contextError();

  const capturedAt = new Date().toISOString();
  const snapshot: CopilotContextSnapshot = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    workflow: row.workflow_id
      ? {
        id: row.workflow_id,
        publishedVersionId: row.workflow_published_version_id,
        draftRevision: Number(row.workflow_draft_revision),
      }
      : null,
    run: row.workflow_run_id
      ? {
        id: row.workflow_run_id,
        status: String(row.workflow_run_status),
        workflowVersionId: row.workflow_version_id,
      }
      : null,
    task: { id: row.task_id, status: row.task_status },
    output: {
      documentId: row.output_document_id,
      versionId: row.output_version_id,
      versionNumber: Number(row.output_version_number),
      contentHash: row.output_content_hash,
    },
    capturedAt,
  };
  const current = (await runner.query<{
    id: string;
    snapshot: CopilotContextSnapshot;
    captured_at: Date | string;
  }>(
    `SELECT id,snapshot,captured_at
       FROM copilot_context_snapshots
      WHERE id=(
        SELECT id
          FROM copilot_context_snapshots
         WHERE thread_id=$1 AND workspace_id=$2 AND actor_id=$3
         ORDER BY captured_at DESC,id DESC LIMIT 1
      )
        AND workflow_id IS NOT DISTINCT FROM $4
        AND workflow_run_id IS NOT DISTINCT FROM $5
        AND task_id=$6
        AND output_document_id=$7
        AND output_version_id=$8`,
    [
      input.threadId,
      input.workspaceId,
      input.actorId,
      row.workflow_id,
      row.workflow_run_id,
      row.task_id,
      row.output_document_id,
      row.output_version_id,
    ],
  )).rows[0];
  if (current && equivalentAuthoritativeSnapshot(current.snapshot, snapshot)) {
    const currentCapturedAt = iso(current.captured_at);
    return {
      id: current.id,
      threadId: input.threadId,
      snapshot: { ...current.snapshot, capturedAt: currentCapturedAt },
      createdAt: currentCapturedAt,
    };
  }

  const inserted = (await runner.query<{ id: string; captured_at: Date | string }>(
    `INSERT INTO copilot_context_snapshots(
       workspace_id,thread_id,actor_id,schema_version,workflow_id,workflow_run_id,task_id,
       output_document_id,output_version_id,snapshot,captured_at
     ) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10) RETURNING id,captured_at`,
    [
      input.workspaceId,
      input.threadId,
      input.actorId,
      row.workflow_id,
      row.workflow_run_id,
      row.task_id,
      row.output_document_id,
      row.output_version_id,
      JSON.stringify(snapshot),
      capturedAt,
    ],
  )).rows[0];
  if (!inserted) throw Object.assign(new Error('COPILOT_CONTEXT_PERSIST_FAILED'), { statusCode: 500 });
  snapshot.capturedAt = iso(inserted.captured_at);
  return { id: inserted.id, threadId: input.threadId, snapshot, createdAt: snapshot.capturedAt };
}
