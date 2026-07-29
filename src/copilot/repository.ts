import type { Pool, PoolClient } from 'pg';
import { createOutputContentHash } from '../outputs/types.js';
import { db } from '../db/client.js';
import { insertAuditEvent, type QueryRunner } from '../lib/audit.js';
import {
  draftAgentPayloadSchema,
  normalizeDraftAgentPayload,
  outputRefinementPayloadSchema,
  proposalPayloadHash,
} from './contracts.js';
import type {
  CopilotProposalKind,
  CopilotProposalView,
  DraftAgentPayload,
  OutputRefinementPayload,
} from './types.js';

export type ProposalRow = {
  id: string;
  kind: CopilotProposalKind;
  status: CopilotProposalView['status'];
  context_snapshot_id: string;
  payload: unknown;
  payload_hash: string;
  depends_on_output_version: boolean;
  expires_at: Date | string;
  created_at: Date | string;
  applied_at: Date | string | null;
  error_code: string | null;
};

type Connectable = Pick<Pool, 'connect'>;

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function proposalError(code: string, statusCode: number) {
  return Object.assign(new Error(code), { statusCode });
}

export function proposalViewFromRow(row: ProposalRow): CopilotProposalView {
  const payload = row.kind === 'output_refinement'
    ? outputRefinementPayloadSchema.parse(row.payload)
    : draftAgentPayloadSchema.parse(row.payload);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    contextSnapshotId: row.context_snapshot_id,
    payload,
    payloadHash: row.payload_hash,
    dependsOnOutputVersion: row.depends_on_output_version,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    appliedAt: row.applied_at ? iso(row.applied_at) : null,
    errorCode: row.error_code,
  };
}

function normalizedPayload(kind: CopilotProposalKind, candidate: unknown) {
  if (kind === 'draft_agent') return normalizeDraftAgentPayload(candidate);
  const parsed = outputRefinementPayloadSchema.parse(candidate);
  return outputRefinementPayloadSchema.parse({
    ...parsed,
    proposedContentHash: createOutputContentHash(parsed.proposedContent),
  });
}

export async function createCopilotProposal(
  input: {
    workspaceId: string;
    actorId: string;
    threadId: string;
    contextSnapshotId: string;
    kind: CopilotProposalKind;
    candidate: unknown;
    dependsOnOutputVersion: boolean;
  },
  database: Connectable = db,
): Promise<CopilotProposalView> {
  const payload = normalizedPayload(input.kind, input.candidate) as OutputRefinementPayload | DraftAgentPayload;
  const hash = proposalPayloadHash(payload);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE copilot_proposals SET status='superseded',superseded_at=now(),updated_at=now()
        WHERE workspace_id=$1 AND thread_id=$2 AND context_snapshot_id=$3 AND kind=$4
          AND status='ready_for_review'`,
      [input.workspaceId, input.threadId, input.contextSnapshotId, input.kind],
    );
    const row = (await client.query<ProposalRow>(
      `INSERT INTO copilot_proposals(
         workspace_id,thread_id,context_snapshot_id,kind,status,schema_version,payload,payload_hash,
         depends_on_output_version,created_by,expires_at
       ) VALUES($1,$2,$3,$4,'ready_for_review',1,$5,$6,$7,$8,now()+interval '24 hours')
       RETURNING id,kind,status,context_snapshot_id,payload,payload_hash,depends_on_output_version,
                 expires_at,created_at,applied_at,error_code`,
      [
        input.workspaceId,
        input.threadId,
        input.contextSnapshotId,
        input.kind,
        JSON.stringify(payload),
        hash,
        input.dependsOnOutputVersion,
        input.actorId,
      ],
    )).rows[0];
    if (!row) throw proposalError('COPILOT_PROPOSAL_CREATE_FAILED', 500);
    await insertAuditEvent(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: 'copilot.proposal.created',
      entityType: 'copilot_proposal',
      entityId: row.id,
      metadata: { kind: input.kind, contextSnapshotId: input.contextSnapshotId },
    });
    await client.query('COMMIT');
    return proposalViewFromRow(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectCopilotProposal(
  input: { workspaceId: string; actorId: string; proposalId: string },
  runner: QueryRunner = db,
): Promise<CopilotProposalView> {
  const row = (await runner.query<ProposalRow>(
    `UPDATE copilot_proposals
        SET status='rejected',rejected_at=now(),updated_at=now()
      WHERE id=$1 AND workspace_id=$2 AND created_by=$3 AND status='ready_for_review'
      RETURNING id,kind,status,context_snapshot_id,payload,payload_hash,depends_on_output_version,
                expires_at,created_at,applied_at,error_code`,
    [input.proposalId, input.workspaceId, input.actorId],
  )).rows[0];
  if (!row) throw proposalError('COPILOT_PROPOSAL_NOT_REVIEWABLE', 409);
  await insertAuditEvent(runner, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'copilot.proposal.rejected',
    entityType: 'copilot_proposal',
    entityId: input.proposalId,
    metadata: { kind: row.kind },
  });
  return proposalViewFromRow(row);
}

export async function getProposalView(workspaceId: string, proposalId: string, runner: QueryRunner = db) {
  const row = (await runner.query<ProposalRow>(
    `SELECT id,kind,status,context_snapshot_id,payload,payload_hash,depends_on_output_version,
            expires_at,created_at,applied_at,error_code
       FROM copilot_proposals WHERE id=$1 AND workspace_id=$2`,
    [proposalId, workspaceId],
  )).rows[0];
  return row ? proposalViewFromRow(row) : null;
}

export type { PoolClient };
