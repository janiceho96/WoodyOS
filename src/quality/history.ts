import type { PoolClient } from 'pg';
import { db } from '../db/client.js';
import { executionLeaseLost } from '../runtime/leases.js';
import { canonicalJson, type ExecutionManifest } from '../runtime/manifest.js';

export type QualityHistoryEntry = {
  id: string;
  workspaceId: string;
  workflowRunId: string;
  sequence: number;
  automatedRevision: number;
  manualRevision: number;
  candidateTaskId: string;
  outputDocumentVersionId: string;
  candidateHash: string;
  graderTaskId: string;
  graderAgentVersionId: string;
  modelIdentity: string;
  result: unknown;
  exitReason: string | null;
  traceId: string;
  createdAt: Date | string;
};

export type AppendQualityHistoryEntryInput = Omit<QualityHistoryEntry, 'id' | 'createdAt'> & {
  leaseOwnerId?: string;
};

type QualityHistoryRow = {
  id: string;
  workspace_id: string;
  workflow_run_id: string;
  sequence: number;
  automated_revision: number;
  manual_revision: number;
  candidate_task_id: string;
  output_document_version_id: string;
  candidate_hash: string;
  grader_task_id: string;
  grader_agent_version_id: string;
  model_identity: string;
  result: unknown;
  exit_reason: string | null;
  trace_id: string;
  created_at: Date | string;
};

type RunIdentityRow = {
  id: string;
  workspace_id: string;
  trace_id: string;
  execution_manifest: ExecutionManifest | null;
};

type LinkedIdentityRow = {
  candidate_task_id: string;
  candidate_workspace_id: string;
  candidate_workflow_run_id: string | null;
  output_document_version_id: string;
  output_workspace_id: string;
  output_task_id: string;
  content_hash: string;
  grader_task_id: string;
  grader_workspace_id: string;
  grader_workflow_run_id: string | null;
  grader_agent_id: string;
  grader_task_agent_version_id: string | null;
  grader_agent_version_id: string;
  grader_version_workspace_id: string;
  grader_version_agent_id: string;
  grader_result: unknown;
};

function qualityError(code: 'QUALITY_HISTORY_IDENTITY_MISMATCH' | 'QUALITY_HISTORY_RESULT_MISMATCH' | 'QUALITY_HISTORY_SEQUENCE_CONFLICT') {
  return Object.assign(new Error(code), {
    code,
    category: 'validation',
    retryable: false,
    statusCode: 409,
  });
}

function rowToEntry(row: QualityHistoryRow): QualityHistoryEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowRunId: row.workflow_run_id,
    sequence: row.sequence,
    automatedRevision: row.automated_revision,
    manualRevision: row.manual_revision,
    candidateTaskId: row.candidate_task_id,
    outputDocumentVersionId: row.output_document_version_id,
    candidateHash: row.candidate_hash,
    graderTaskId: row.grader_task_id,
    graderAgentVersionId: row.grader_agent_version_id,
    modelIdentity: row.model_identity,
    result: row.result,
    exitReason: row.exit_reason,
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}

export function modelIdentityFromManifest(
  manifest: ExecutionManifest | null | undefined,
  agentId: string,
  agentVersionId: string,
) {
  const pinnedVersion = manifest?.agents[agentId]?.versionId;
  const model = manifest?.models[agentId];
  const runtimeVersion = manifest?.runtime.version;
  if (!model || !runtimeVersion || pinnedVersion !== agentVersionId) {
    throw qualityError('QUALITY_HISTORY_IDENTITY_MISMATCH');
  }
  return [
    model.provider,
    model.model,
    model.parametersHash,
    agentVersionId,
    runtimeVersion,
  ].join(':');
}

function identicalEntry(row: QualityHistoryRow, input: AppendQualityHistoryEntryInput) {
  return row.workspace_id === input.workspaceId
    && row.workflow_run_id === input.workflowRunId
    && row.sequence === input.sequence
    && row.automated_revision === input.automatedRevision
    && row.manual_revision === input.manualRevision
    && row.candidate_task_id === input.candidateTaskId
    && row.output_document_version_id === input.outputDocumentVersionId
    && row.candidate_hash === input.candidateHash
    && row.grader_task_id === input.graderTaskId
    && row.grader_agent_version_id === input.graderAgentVersionId
    && row.model_identity === input.modelIdentity
    && canonicalJson(row.result) === canonicalJson(input.result)
    && row.exit_reason === input.exitReason
    && row.trace_id === input.traceId;
}

async function verifyLease(
  client: PoolClient,
  workflowRunId: string,
  leaseOwnerId: string | undefined,
) {
  if (!leaseOwnerId) return;
  const lease = await client.query(
    `/* quality-history:lease */
     SELECT subject_id id
       FROM execution_leases
      WHERE subject_type='workflow_run'
        AND subject_id=$1
        AND owner_id=$2
        AND expires_at>clock_timestamp()
      FOR SHARE`,
    [workflowRunId, leaseOwnerId],
  );
  if (lease.rowCount !== 1) throw executionLeaseLost();
}

function assertInput(input: AppendQualityHistoryEntryInput) {
  if (
    !Number.isInteger(input.sequence) || input.sequence <= 0
    || !Number.isInteger(input.automatedRevision) || input.automatedRevision < 0
    || !Number.isInteger(input.manualRevision) || input.manualRevision < 0
    || !/^[a-f0-9]{64}$/.test(input.candidateHash)
    || input.result === undefined
  ) {
    throw qualityError('QUALITY_HISTORY_IDENTITY_MISMATCH');
  }
}

export async function appendQualityHistoryEntry(
  input: AppendQualityHistoryEntryInput,
): Promise<QualityHistoryEntry> {
  assertInput(input);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const run = (await client.query<RunIdentityRow>(
      `/* quality-history:run */
       SELECT id,workspace_id,trace_id,execution_manifest
         FROM workflow_runs
        WHERE id=$1 AND workspace_id=$2 AND trace_id=$3
        FOR UPDATE`,
      [input.workflowRunId, input.workspaceId, input.traceId],
    )).rows[0];
    if (!run) throw qualityError('QUALITY_HISTORY_IDENTITY_MISMATCH');
    await verifyLease(client, run.id, input.leaseOwnerId);

    const identity = (await client.query<LinkedIdentityRow>(
      `/* quality-history:identity */
       SELECT candidate.id candidate_task_id,
              candidate.workspace_id candidate_workspace_id,
              candidate.workflow_run_id candidate_workflow_run_id,
              output_version.id output_document_version_id,
              output_version.workspace_id output_workspace_id,
              output_document.task_id output_task_id,
              output_version.content_hash,
              grader.id grader_task_id,
              grader.workspace_id grader_workspace_id,
              grader.workflow_run_id grader_workflow_run_id,
              grader.agent_id grader_agent_id,
              grader.agent_version_id grader_task_agent_version_id,
              grader_version.id grader_agent_version_id,
              grader_version.workspace_id grader_version_workspace_id,
              grader_version.agent_id grader_version_agent_id,
              grader.output->'data' grader_result
         FROM tasks candidate
         JOIN output_documents output_document
           ON output_document.task_id=candidate.id
          AND output_document.workspace_id=candidate.workspace_id
         JOIN output_document_versions output_version
           ON output_version.document_id=output_document.id
          AND output_version.workspace_id=output_document.workspace_id
         JOIN tasks grader ON grader.id=$4
         JOIN agent_versions grader_version ON grader_version.id=$5
        WHERE candidate.id=$1
          AND output_version.id=$2
          AND output_version.content_hash=$3`,
      [
        input.candidateTaskId,
        input.outputDocumentVersionId,
        input.candidateHash,
        input.graderTaskId,
        input.graderAgentVersionId,
      ],
    )).rows[0];
    if (
      !identity
      || identity.candidate_task_id !== input.candidateTaskId
      || identity.candidate_workspace_id !== input.workspaceId
      || identity.candidate_workflow_run_id !== input.workflowRunId
      || identity.output_document_version_id !== input.outputDocumentVersionId
      || identity.output_workspace_id !== input.workspaceId
      || identity.output_task_id !== input.candidateTaskId
      || identity.content_hash !== input.candidateHash
      || identity.grader_task_id !== input.graderTaskId
      || identity.grader_workspace_id !== input.workspaceId
      || identity.grader_workflow_run_id !== input.workflowRunId
      || identity.grader_task_agent_version_id !== input.graderAgentVersionId
      || identity.grader_agent_version_id !== input.graderAgentVersionId
      || identity.grader_version_workspace_id !== input.workspaceId
      || identity.grader_version_agent_id !== identity.grader_agent_id
    ) {
      throw qualityError('QUALITY_HISTORY_IDENTITY_MISMATCH');
    }
    const derivedModelIdentity = modelIdentityFromManifest(
      run.execution_manifest,
      identity.grader_agent_id,
      identity.grader_agent_version_id,
    );
    if (input.modelIdentity !== derivedModelIdentity) {
      throw qualityError('QUALITY_HISTORY_IDENTITY_MISMATCH');
    }
    if (canonicalJson(input.result) !== canonicalJson(identity.grader_result)) {
      throw qualityError('QUALITY_HISTORY_RESULT_MISMATCH');
    }

    const existing = (await client.query<QualityHistoryRow>(
      `/* quality-history:existing */
       SELECT *
         FROM quality_history_entries
        WHERE workflow_run_id=$1 AND sequence=$2`,
      [input.workflowRunId, input.sequence],
    )).rows[0];
    if (existing) {
      if (!identicalEntry(existing, input)) {
        throw qualityError('QUALITY_HISTORY_SEQUENCE_CONFLICT');
      }
      await verifyLease(client, run.id, input.leaseOwnerId);
      await client.query('COMMIT');
      return rowToEntry(existing);
    }

    const inserted = (await client.query<QualityHistoryRow>(
      `/* quality-history:insert */
       INSERT INTO quality_history_entries(
         workspace_id,workflow_run_id,sequence,automated_revision,manual_revision,
         candidate_task_id,output_document_version_id,candidate_hash,
         grader_task_id,grader_agent_version_id,model_identity,result,exit_reason,trace_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        input.workspaceId,
        input.workflowRunId,
        input.sequence,
        input.automatedRevision,
        input.manualRevision,
        input.candidateTaskId,
        input.outputDocumentVersionId,
        input.candidateHash,
        input.graderTaskId,
        input.graderAgentVersionId,
        derivedModelIdentity,
        canonicalJson(identity.grader_result),
        input.exitReason,
        input.traceId,
      ],
    )).rows[0];
    if (!inserted) throw qualityError('QUALITY_HISTORY_SEQUENCE_CONFLICT');
    await verifyLease(client, run.id, input.leaseOwnerId);
    await client.query('COMMIT');
    return rowToEntry(inserted);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listQualityHistory(
  workspaceId: string,
  workflowRunId: string,
): Promise<QualityHistoryEntry[]> {
  const client = await db.connect();
  try {
    const result = await client.query<QualityHistoryRow>(
      `/* quality-history:list */
       SELECT *
         FROM quality_history_entries
        WHERE workspace_id=$1 AND workflow_run_id=$2
        ORDER BY sequence`,
      [workspaceId, workflowRunId],
    );
    return result.rows.map(rowToEntry);
  } finally {
    client.release();
  }
}
