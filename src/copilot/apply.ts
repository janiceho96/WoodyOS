import type { Pool } from 'pg';
import { db } from '../db/client.js';
import { createDraftAgentWithClient } from '../agents/service.js';
import { insertAuditEvent } from '../lib/audit.js';
import { saveOutputVersionWithClient } from '../outputs/service.js';
import {
  assertProposalTransition,
  proposalPayloadHash,
  safeReceiptError,
} from './contracts.js';
import { proposalViewFromRow, type ProposalRow } from './repository.js';
import type {
  CopilotProposalView,
  DraftAgentPayload,
  ExecutionReceipt,
  OutputRefinementPayload,
} from './types.js';

type CopilotDatabase = Pick<Pool, 'query' | 'connect'>;
type ActorRole = 'viewer' | 'member' | 'admin' | 'owner';

type CurrentOutput = { versionId: string; versionNumber: number; contentHash: string };

type ApplicationRow = ProposalRow & {
  workspace_id: string;
  thread_id: string;
  created_by: string;
  snapshot: {
    output: CurrentOutput & { documentId: string };
  };
  current_output_version_id: string;
  current_output_version_number: number;
  current_output_content_hash: string;
};

type ReceiptRow = {
  id: string;
  workspace_id: string;
  proposal_id: string;
  proposal_kind: ExecutionReceipt['proposalKind'];
  context_snapshot_id: string;
  idempotency_key: string;
  operation: ExecutionReceipt['operation'];
  status: ExecutionReceipt['status'];
  actor_id: string;
  resource_type: ExecutionReceipt['resource']['type'];
  resource_id: string | null;
  previous_version: number | null;
  resulting_version: number | null;
  audit_event_id: string | null;
  error_code: string | null;
  created_at: Date | string;
};

function applicationError(code: string, statusCode: number) {
  return Object.assign(new Error(code), { statusCode });
}

function errorStatusCode(error: unknown) {
  return typeof (error as { statusCode?: unknown })?.statusCode === 'number'
    ? (error as { statusCode: number }).statusCode
    : 500;
}

function receiptFromRow(row: ReceiptRow): ExecutionReceipt {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    proposalId: row.proposal_id,
    proposalKind: row.proposal_kind,
    contextSnapshotId: row.context_snapshot_id,
    idempotencyKey: row.idempotency_key,
    operation: row.operation,
    status: row.status,
    actorId: row.actor_id,
    resource: {
      type: row.resource_type,
      id: row.resource_id,
      ...(row.previous_version === null ? {} : { previousVersion: Number(row.previous_version) }),
      ...(row.resulting_version === null ? {} : { resultingVersion: Number(row.resulting_version) }),
    },
    auditEventId: row.audit_event_id,
    errorCode: row.error_code,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

export function validateProposalForApplication(
  proposal: Pick<CopilotProposalView, 'kind' | 'payload' | 'payloadHash' | 'status' | 'expiresAt' | 'dependsOnOutputVersion'>,
  input: { now: Date; currentOutput: CurrentOutput; snapshotOutput?: CurrentOutput },
) {
  if (proposal.status !== 'approved') throw applicationError('COPILOT_PROPOSAL_NOT_APPROVED', 409);
  if (new Date(proposal.expiresAt).getTime() <= input.now.getTime()) {
    throw applicationError('COPILOT_PROPOSAL_EXPIRED', 409);
  }
  if (proposalPayloadHash(proposal.payload) !== proposal.payloadHash) {
    throw applicationError('COPILOT_PROPOSAL_INVALID', 409);
  }
  if (proposal.kind === 'output_refinement') {
    const payload = proposal.payload as OutputRefinementPayload;
    if (
      payload.baseVersionId !== input.currentOutput.versionId
      || payload.baseVersionNumber !== input.currentOutput.versionNumber
      || payload.baseContentHash !== input.currentOutput.contentHash
    ) throw applicationError('COPILOT_CONTEXT_STALE', 409);
  } else if (proposal.dependsOnOutputVersion) {
    if (
      !input.snapshotOutput
      || input.snapshotOutput.versionId !== input.currentOutput.versionId
      || input.snapshotOutput.versionNumber !== input.currentOutput.versionNumber
      || input.snapshotOutput.contentHash !== input.currentOutput.contentHash
    ) throw applicationError('COPILOT_CONTEXT_STALE', 409);
  }
}

function safeReceiptView(receipt: ExecutionReceipt) {
  const { workspaceId: _workspaceId, actorId: _actorId, ...view } = receipt;
  return view;
}

async function insertReceiptMessage(
  runner: Pick<import('pg').PoolClient, 'query'>,
  input: { workspaceId: string; threadId: string; receipt: ExecutionReceipt },
) {
  const receipt = safeReceiptView(input.receipt);
  await runner.query(
    `INSERT INTO chat_messages(
       workspace_id,thread_id,role,content,metadata,context_snapshot_id,proposal_id,execution_receipt_id
     ) VALUES($1,$2,'assistant',$3,$4,$5,$6,$7)`,
    [
      input.workspaceId,
      input.threadId,
      receipt.status === 'succeeded'
        ? 'The approved change was completed.'
        : 'The approved change could not be completed.',
      JSON.stringify({ event: { type: 'execution_receipt', receipt } }),
      receipt.contextSnapshotId,
      receipt.proposalId,
      receipt.id,
    ],
  );
}

async function existingReceipt(database: CopilotDatabase, input: {
  workspaceId: string;
  actorId: string;
  proposalId: string;
  idempotencyKey: string;
}) {
  const row = (await database.query<ReceiptRow>(
    `SELECT * FROM copilot_execution_receipts
      WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
    [input.workspaceId, input.actorId, input.idempotencyKey],
  )).rows[0];
  if (!row) return null;
  if (row.proposal_id !== input.proposalId) throw applicationError('COPILOT_IDEMPOTENCY_CONFLICT', 409);
  return receiptFromRow(row);
}

async function persistFailedReceipt(database: CopilotDatabase, input: {
  workspaceId: string;
  actorId: string;
  proposalId: string;
  idempotencyKey: string;
  errorCode: string;
}) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const proposal = (await client.query<ApplicationRow>(
      `SELECT proposal.*,snapshot.snapshot
         FROM copilot_proposals proposal
         JOIN copilot_context_snapshots snapshot ON snapshot.id=proposal.context_snapshot_id
        WHERE proposal.id=$1 AND proposal.workspace_id=$2 FOR UPDATE`,
      [input.proposalId, input.workspaceId],
    )).rows[0];
    if (!proposal) throw applicationError('COPILOT_PROPOSAL_NOT_FOUND', 404);
    const terminalStatus = input.errorCode === 'COPILOT_PROPOSAL_EXPIRED' ? 'expired' : 'failed';
    if (proposal.status !== terminalStatus) {
      assertProposalTransition(proposal.status, terminalStatus);
    }
    const approval = (await client.query<{ id: string }>(
      `INSERT INTO copilot_proposal_approvals(
         workspace_id,proposal_id,context_snapshot_id,approved_by,payload_hash,idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(proposal_id) DO UPDATE SET proposal_id=EXCLUDED.proposal_id
       RETURNING id`,
      [
        input.workspaceId,
        input.proposalId,
        proposal.context_snapshot_id,
        input.actorId,
        proposal.payload_hash,
        input.idempotencyKey,
      ],
    )).rows[0];
    await client.query(
      `UPDATE copilot_proposals SET status=$1,error_code=$2,updated_at=now()
        WHERE id=$3 AND status IN ('ready_for_review','approved','applying')`,
      [terminalStatus, input.errorCode, input.proposalId],
    );
    const auditEventId = await insertAuditEvent(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: input.errorCode === 'COPILOT_PROPOSAL_INVALID'
        ? 'copilot.proposal.security_rejected'
        : 'copilot.proposal.application_failed',
      entityType: 'copilot_proposal',
      entityId: input.proposalId,
      metadata: { errorCode: input.errorCode, contextSnapshotId: proposal.context_snapshot_id },
    });
    const receipt = (await client.query<ReceiptRow>(
      `INSERT INTO copilot_execution_receipts(
         workspace_id,proposal_id,approval_id,context_snapshot_id,proposal_kind,idempotency_key,
         operation,status,actor_id,resource_type,error_code,audit_event_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,'failed',$8,$9,$10,$11)
       ON CONFLICT(proposal_id) DO UPDATE SET proposal_id=EXCLUDED.proposal_id
       RETURNING *`,
      [
        input.workspaceId,
        input.proposalId,
        approval.id,
        proposal.context_snapshot_id,
        proposal.kind,
        input.idempotencyKey,
        proposal.kind === 'output_refinement' ? 'output.version_created' : 'agent.draft_created',
        input.actorId,
        proposal.kind === 'output_refinement' ? 'output_version' : 'agent',
        input.errorCode,
        auditEventId,
      ],
    )).rows[0];
    const persistedReceipt = receiptFromRow(receipt);
    await insertReceiptMessage(client, {
      workspaceId: input.workspaceId,
      threadId: proposal.thread_id,
      receipt: persistedReceipt,
    });
    await client.query('COMMIT');
    return persistedReceipt;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function approveAndApplyCopilotProposal(
  input: {
    workspaceId: string;
    actorId: string;
    actorRole: ActorRole;
    proposalId: string;
    idempotencyKey: string;
  },
  database: CopilotDatabase = db,
): Promise<ExecutionReceipt> {
  if (input.actorRole === 'viewer') throw applicationError('FORBIDDEN', 403);
  const duplicate = await existingReceipt(database, input);
  if (duplicate) return duplicate;

  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query<ApplicationRow>(
      `SELECT proposal.*,snapshot.snapshot,
              current_version.id current_output_version_id,
              current_version.version_number current_output_version_number,
              current_version.content_hash current_output_content_hash
         FROM copilot_proposals proposal
         JOIN copilot_context_snapshots snapshot ON snapshot.id=proposal.context_snapshot_id
         JOIN output_documents document ON document.id=snapshot.output_document_id
         JOIN output_document_versions current_version
           ON current_version.document_id=document.id
          AND current_version.version_number=document.current_version_number
        WHERE proposal.id=$1 AND proposal.workspace_id=$2 AND proposal.created_by=$3
        FOR UPDATE OF proposal`,
      [input.proposalId, input.workspaceId, input.actorId],
    )).rows[0];
    if (!row) throw applicationError('COPILOT_PROPOSAL_NOT_FOUND', 404);
    if (row.status !== 'ready_for_review') throw applicationError('COPILOT_PROPOSAL_NOT_REVIEWABLE', 409);
    assertProposalTransition(row.status, 'approved');
    await client.query(
      `UPDATE copilot_proposals SET status='approved',approved_at=now(),updated_at=now()
        WHERE id=$1 AND status='ready_for_review'`,
      [input.proposalId],
    );
    const view = proposalViewFromRow({ ...row, status: 'approved' });
    validateProposalForApplication(view, {
      now: new Date(),
      currentOutput: {
        versionId: row.current_output_version_id,
        versionNumber: Number(row.current_output_version_number),
        contentHash: row.current_output_content_hash,
      },
      snapshotOutput: {
        versionId: row.snapshot.output.versionId,
        versionNumber: Number(row.snapshot.output.versionNumber),
        contentHash: row.snapshot.output.contentHash,
      },
    });
    const approval = (await client.query<{ id: string }>(
      `INSERT INTO copilot_proposal_approvals(
         workspace_id,proposal_id,context_snapshot_id,approved_by,payload_hash,idempotency_key
       ) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [input.workspaceId, row.id, row.context_snapshot_id, input.actorId, row.payload_hash, input.idempotencyKey],
    )).rows[0];
    await client.query(
      `UPDATE copilot_proposals SET status='applying',updated_at=now()
        WHERE id=$1 AND status='approved'`,
      [row.id],
    );
    assertProposalTransition('approved', 'applying');

    let resourceId: string;
    let previousVersion: number | null = null;
    let resultingVersion: number | null = null;
    if (row.kind === 'output_refinement') {
      const payload = view.payload as OutputRefinementPayload;
      const detail = await saveOutputVersionWithClient(client, {
        workspaceId: input.workspaceId,
        documentId: payload.documentId,
        actorId: input.actorId,
        content: payload.proposedContent,
        baseVersionNumber: payload.baseVersionNumber,
      });
      resourceId = detail.currentVersion.id;
      previousVersion = payload.baseVersionNumber;
      resultingVersion = detail.current_version_number;
    } else {
      const agent = await createDraftAgentWithClient(client, {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        payload: view.payload as DraftAgentPayload,
      });
      resourceId = agent.id;
    }
    const auditEventId = await insertAuditEvent(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: row.kind === 'output_refinement' ? 'copilot.output_version.created' : 'copilot.agent_draft.created',
      entityType: row.kind === 'output_refinement' ? 'output_version' : 'agent',
      entityId: resourceId,
      metadata: { proposalId: row.id, contextSnapshotId: row.context_snapshot_id },
    });
    const receipt = (await client.query<ReceiptRow>(
      `INSERT INTO copilot_execution_receipts(
         workspace_id,proposal_id,approval_id,context_snapshot_id,proposal_kind,idempotency_key,
         operation,status,actor_id,resource_type,resource_id,previous_version,resulting_version,audit_event_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        input.workspaceId,
        row.id,
        approval.id,
        row.context_snapshot_id,
        row.kind,
        input.idempotencyKey,
        row.kind === 'output_refinement' ? 'output.version_created' : 'agent.draft_created',
        input.actorId,
        row.kind === 'output_refinement' ? 'output_version' : 'agent',
        resourceId,
        previousVersion,
        resultingVersion,
        auditEventId,
      ],
    )).rows[0];
    const persistedReceipt = receiptFromRow(receipt);
    await insertReceiptMessage(client, {
      workspaceId: input.workspaceId,
      threadId: row.thread_id,
      receipt: persistedReceipt,
    });
    assertProposalTransition('applying', 'applied');
    await client.query(
      `UPDATE copilot_proposals SET status='applied',applied_at=now(),updated_at=now()
        WHERE id=$1 AND status='applying'`,
      [row.id],
    );
    await client.query('COMMIT');
    return persistedReceipt;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const safe = safeReceiptError(error);
    await persistFailedReceipt(database, { ...input, errorCode: safe.errorCode }).catch(() => undefined);
    throw applicationError(safe.errorCode, errorStatusCode(error));
  } finally {
    client.release();
  }
}

export async function getExecutionReceipt(workspaceId: string, receiptId: string, database: CopilotDatabase = db) {
  const row = (await database.query<ReceiptRow>(
    'SELECT * FROM copilot_execution_receipts WHERE id=$1 AND workspace_id=$2',
    [receiptId, workspaceId],
  )).rows[0];
  return row ? receiptFromRow(row) : null;
}
