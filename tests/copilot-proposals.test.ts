import { describe, expect, it } from 'vitest';
import { resolveCopilotContext } from '../src/copilot/context.js';
import type { CopilotContextSnapshot } from '../src/copilot/types.js';
import {
  createCopilotProposal,
  proposalViewFromRow,
  rejectCopilotProposal,
} from '../src/copilot/repository.js';
import {
  approveAndApplyCopilotProposal,
  validateProposalForApplication,
} from '../src/copilot/apply.js';
import { proposalPayloadHash } from '../src/copilot/contracts.js';

const workspaceId = '0c46a071-6933-4de1-a602-e5310982a947';
const actorId = '2a55d226-97a7-4de5-aa8c-258f79fdb824';
const threadId = 'f50ef45a-7488-44aa-b3e8-7b39b092ad42';
const proposalId = '6688bb45-a4f8-4261-8e71-ee8bd43dfe81';
const contextSnapshotId = 'd1f58c9a-1681-4a65-8949-9ae2956945bb';
const now = '2026-07-29T10:00:00.000Z';

function runner(responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      async query(text: string) {
        queries.push(text);
        const result = responses.shift() ?? {};
        return { command: '', fields: [], oid: 0, rowCount: result.rowCount ?? result.rows?.length ?? 0, rows: result.rows ?? [] };
      },
    },
  };
}

const refinementPayload = {
  documentId: '45f0429e-a911-492e-96cd-62fa17276211',
  baseVersionId: '6f4d43a5-28dd-4123-b99a-97f9a366aa00',
  baseVersionNumber: 1,
  baseContentHash: 'a'.repeat(64),
  proposedContent: '# Refined',
  proposedContentHash: 'b'.repeat(64),
  changeSummary: ['Clearer'],
};

const workflowId = '12c26e9a-da06-4710-a39c-0f426b56bd8b';
const workflowRunId = '79be9d2d-9563-4a0b-ae1e-8197b62aa048';
const workflowVersionId = '718972f6-e2bd-42fd-af2e-32ba068a56d1';
const publishedVersionId = '81a95235-686d-4ca4-8084-3bef1b3bb4ca';

function authoritativeContextRow() {
  return {
    thread_id: threadId,
    task_id: refinementPayload.documentId,
    task_status: 'completed',
    output_document_id: refinementPayload.documentId,
    output_version_id: refinementPayload.baseVersionId,
    output_version_number: 1,
    output_content_hash: refinementPayload.baseContentHash,
    workflow_id: workflowId,
    workflow_published_version_id: publishedVersionId,
    workflow_draft_revision: 7,
    workflow_run_id: workflowRunId,
    workflow_run_status: 'completed',
    workflow_version_id: workflowVersionId,
  };
}

function authoritativeSnapshot(
  overrides: {
    workflow?: CopilotContextSnapshot['workflow'];
    run?: CopilotContextSnapshot['run'];
    task?: CopilotContextSnapshot['task'];
    output?: CopilotContextSnapshot['output'];
    workspaceId?: string;
    actorId?: string;
    capturedAt?: string;
  } = {},
): CopilotContextSnapshot {
  return {
    schemaVersion: 1,
    workspaceId: overrides.workspaceId ?? workspaceId,
    actorId: overrides.actorId ?? actorId,
    workflow: overrides.workflow ?? {
      id: workflowId,
      publishedVersionId,
      draftRevision: 7,
    },
    run: overrides.run ?? {
      id: workflowRunId,
      status: 'completed',
      workflowVersionId,
    },
    task: overrides.task ?? {
      id: refinementPayload.documentId,
      status: 'completed',
    },
    output: overrides.output ?? {
      documentId: refinementPayload.documentId,
      versionId: refinementPayload.baseVersionId,
      versionNumber: 1,
      contentHash: refinementPayload.baseContentHash,
    },
    capturedAt: overrides.capturedAt ?? now,
  };
}

describe('Copilot proposal services', () => {
  it('resolves and persists a related authoritative context snapshot', async () => {
    const db = runner([
      {
        rows: [{
          thread_id: threadId,
          task_id: refinementPayload.documentId,
          task_status: 'completed',
          output_document_id: refinementPayload.documentId,
          output_version_id: refinementPayload.baseVersionId,
          output_version_number: 1,
          output_content_hash: refinementPayload.baseContentHash,
          workflow_id: null,
          workflow_published_version_id: null,
          workflow_draft_revision: null,
          workflow_run_id: null,
          workflow_run_status: null,
          workflow_version_id: null,
        }],
      },
      { rows: [] },
      { rows: [{ id: contextSnapshotId, captured_at: now }] },
    ]);

    const snapshot = await resolveCopilotContext({
      workspaceId,
      actorId,
      threadId,
      request: {
        taskId: refinementPayload.documentId,
        outputDocumentId: refinementPayload.documentId,
      },
    }, db.client as never);
    expect(snapshot.id).toBe(contextSnapshotId);
    expect(snapshot.snapshot.output.versionNumber).toBe(1);
    expect(db.queries[0]).toContain('output_document_versions');
  });

  it.each([
    {
      name: 'workflow publication and draft state',
      previous: authoritativeSnapshot({
        workflow: {
          id: workflowId,
          publishedVersionId: '2c95a1d5-3765-4707-8088-39fcf55164f7',
          draftRevision: 6,
        },
      }),
    },
    {
      name: 'run status and workflow version',
      previous: authoritativeSnapshot({
        run: {
          id: workflowRunId,
          status: 'running',
          workflowVersionId: '230e7479-6e2e-4135-b2da-aa98f84e717d',
        },
      }),
    },
    {
      name: 'task status',
      previous: authoritativeSnapshot({
        task: {
          id: refinementPayload.documentId,
          status: 'running',
        },
      }),
    },
    {
      name: 'output version metadata',
      previous: authoritativeSnapshot({
        output: {
          documentId: refinementPayload.documentId,
          versionId: refinementPayload.baseVersionId,
          versionNumber: 2,
          contentHash: 'f'.repeat(64),
        },
      }),
    },
  ])('creates a fresh snapshot when same-ID $name changes', async ({ previous }) => {
    const freshSnapshotId = '6355cda3-b5c5-4e3a-a7f1-0cc8b6cc526b';
    const db = runner([
      { rows: [authoritativeContextRow()] },
      { rows: [{ id: contextSnapshotId, snapshot: previous, captured_at: now }] },
      { rows: [{ id: freshSnapshotId, captured_at: '2026-07-29T10:01:00.000Z' }] },
    ]);

    const snapshot = await resolveCopilotContext({
      workspaceId,
      actorId,
      threadId,
      request: {
        workflowId,
        workflowRunId,
        taskId: refinementPayload.documentId,
        outputDocumentId: refinementPayload.documentId,
      },
    }, db.client as never);

    expect(snapshot.id).toBe(freshSnapshotId);
    expect(snapshot.snapshot).toMatchObject({
      workflow: {
        id: workflowId,
        publishedVersionId,
        draftRevision: 7,
      },
      run: {
        id: workflowRunId,
        status: 'completed',
        workflowVersionId,
      },
      task: {
        id: refinementPayload.documentId,
        status: 'completed',
      },
      output: {
        documentId: refinementPayload.documentId,
        versionId: refinementPayload.baseVersionId,
        versionNumber: 1,
        contentHash: refinementPayload.baseContentHash,
      },
    });
    expect(db.queries.at(-1)).toContain('INSERT INTO copilot_context_snapshots');
  });

  it('reuses an unchanged fully authoritative snapshot regardless of capture timestamp', async () => {
    const db = runner([
      { rows: [authoritativeContextRow()] },
      {
        rows: [{
          id: contextSnapshotId,
          snapshot: authoritativeSnapshot({ capturedAt: '2026-07-28T09:00:00.000Z' }),
          captured_at: now,
        }],
      },
    ]);

    const snapshot = await resolveCopilotContext({
      workspaceId,
      actorId,
      threadId,
      request: {
        workflowId,
        workflowRunId,
        taskId: refinementPayload.documentId,
        outputDocumentId: refinementPayload.documentId,
      },
    }, db.client as never);

    expect(snapshot.id).toBe(contextSnapshotId);
    expect(snapshot.snapshot.capturedAt).toBe(now);
    expect(db.queries).toHaveLength(2);
  });

  it('uses one indistinguishable not-found error for absent or mismatched context', async () => {
    const db = runner([{ rows: [] }]);
    await expect(resolveCopilotContext({
      workspaceId,
      actorId,
      threadId,
      request: {
        taskId: refinementPayload.documentId,
        outputDocumentId: refinementPayload.documentId,
      },
    }, db.client as never)).rejects.toMatchObject({
      message: 'COPILOT_CONTEXT_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('rejects a corrupted persisted snapshot before it can authorize a proposal', async () => {
    const db = runner([
      { rows: [authoritativeContextRow()] },
      { rows: [{ id: contextSnapshotId, snapshot: { schemaVersion: 2 }, captured_at: now }] },
    ]);
    await expect(resolveCopilotContext({
      workspaceId,
      actorId,
      threadId,
      request: {
        workflowId,
        workflowRunId,
        taskId: refinementPayload.documentId,
        outputDocumentId: refinementPayload.documentId,
      },
    }, db.client as never)).rejects.toMatchObject({
      message: 'COPILOT_CONTEXT_INVALID',
      statusCode: 409,
    });
  });

  it('normalizes, hashes, and persists a ready refinement proposal', async () => {
    const connection = runner([
      {},
      {},
      {
        rows: [{
          id: proposalId,
          kind: 'output_refinement',
          status: 'ready_for_review',
          context_snapshot_id: contextSnapshotId,
          payload: refinementPayload,
          payload_hash: 'c'.repeat(64),
          depends_on_output_version: true,
          expires_at: '2026-07-30T10:00:00.000Z',
          created_at: now,
          applied_at: null,
          error_code: null,
        }],
      },
      { rows: [{ id: 'f39bf0e2-9e45-4e91-a5f8-4c2199a3b441' }] },
      {},
    ]);
    const database = { connect: async () => ({ ...connection.client, release() {} }) };
    const proposal = await createCopilotProposal({
      workspaceId,
      actorId,
      threadId,
      contextSnapshotId,
      kind: 'output_refinement',
      candidate: refinementPayload,
      dependsOnOutputVersion: true,
    }, database as never);
    expect(proposal).toMatchObject({ id: proposalId, kind: 'output_refinement', status: 'ready_for_review' });
    expect(connection.queries.some((sql) => sql.includes("status='superseded'"))).toBe(true);
  });

  it('rejects only proposals still ready for review', async () => {
    const db = runner([
      {
        rows: [{
          id: proposalId,
          kind: 'output_refinement',
          status: 'rejected',
          context_snapshot_id: contextSnapshotId,
          payload: refinementPayload,
          payload_hash: 'c'.repeat(64),
          depends_on_output_version: true,
          expires_at: '2026-07-30T10:00:00.000Z',
          created_at: now,
          applied_at: null,
          error_code: null,
        }],
      },
      { rows: [{ id: 'f39bf0e2-9e45-4e91-a5f8-4c2199a3b441' }] },
    ]);
    const proposal = await rejectCopilotProposal({ workspaceId, actorId, proposalId }, db.client as never);
    expect(proposal.status).toBe('rejected');
    expect(db.queries[0]).toContain("status='ready_for_review'");
  });

  it('detects stale context and payload tampering before mutation', () => {
    const proposal = {
      kind: 'output_refinement' as const,
      payload: refinementPayload,
      payloadHash: 'invalid',
      status: 'approved' as const,
      expiresAt: '2026-07-30T10:00:00.000Z',
      dependsOnOutputVersion: true,
    };
    expect(() => validateProposalForApplication(proposal, {
      now: new Date(now),
      currentOutput: { versionId: refinementPayload.baseVersionId, versionNumber: 1, contentHash: refinementPayload.baseContentHash },
    })).toThrow('COPILOT_PROPOSAL_INVALID');

    const validRow = proposalViewFromRow({
      id: proposalId,
      kind: 'output_refinement',
      status: 'approved',
      context_snapshot_id: contextSnapshotId,
      payload: refinementPayload,
      payload_hash: proposalPayloadHash(refinementPayload),
      depends_on_output_version: true,
      expires_at: '2026-07-30T10:00:00.000Z',
      created_at: now,
      applied_at: null,
      error_code: null,
    });
    expect(() => validateProposalForApplication({
      ...validRow,
    }, {
      now: new Date(now),
      currentOutput: { versionId: 'different', versionNumber: 2, contentHash: 'd'.repeat(64) },
    })).toThrow('COPILOT_CONTEXT_STALE');
  });

  it('binds output-dependent Draft proposals to the captured output revision', () => {
    const draftPayload = {
      name: 'Draft Writer',
      role: 'Writer',
      goal: 'Create a grounded draft',
      instructions: 'Use the accepted output.',
      personality: null,
      model: 'test-model',
      modelConfig: { temperature: 0.2, maxTokens: 2048, topP: 1 },
      capabilities: { webBrowser: false as const, codeInterpreter: false as const, knowledgeBase: false },
      memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: false },
      status: 'draft' as const,
      toolIds: [] as [],
    };
    expect(() => validateProposalForApplication({
      kind: 'draft_agent',
      payload: draftPayload,
      payloadHash: proposalPayloadHash(draftPayload),
      status: 'approved',
      expiresAt: '2026-07-30T10:00:00.000Z',
      dependsOnOutputVersion: true,
    }, {
      now: new Date(now),
      snapshotOutput: { versionId: refinementPayload.baseVersionId, versionNumber: 1, contentHash: refinementPayload.baseContentHash },
      currentOutput: { versionId: 'new-version', versionNumber: 2, contentHash: 'd'.repeat(64) },
    })).toThrow('COPILOT_CONTEXT_STALE');
  });

  it('forbids viewers before consulting persistence', async () => {
    let queried = false;
    await expect(approveAndApplyCopilotProposal({
      workspaceId,
      actorId,
      actorRole: 'viewer',
      proposalId,
      idempotencyKey: 'dfeb2a71-78c3-455a-a5b6-b09c95975ebe',
    }, {
      query: async () => { queried = true; return { rows: [], rowCount: 0 }; },
      connect: async () => { throw new Error('must not connect'); },
    } as never)).rejects.toMatchObject({ message: 'FORBIDDEN', statusCode: 403 });
    expect(queried).toBe(false);
  });

  it('returns an existing receipt for an idempotent approval retry', async () => {
    const receipt = {
      id: 'b75bad72-e0fd-41cf-bb83-86e0cb059147',
      workspace_id: workspaceId,
      proposal_id: proposalId,
      proposal_kind: 'output_refinement',
      context_snapshot_id: contextSnapshotId,
      idempotency_key: 'dfeb2a71-78c3-455a-a5b6-b09c95975ebe',
      operation: 'output.version_created',
      status: 'succeeded',
      actor_id: actorId,
      resource_type: 'output_version',
      resource_id: refinementPayload.baseVersionId,
      previous_version: 1,
      resulting_version: 2,
      audit_event_id: null,
      error_code: null,
      created_at: now,
    };
    let connected = false;
    const result = await approveAndApplyCopilotProposal({
      workspaceId,
      actorId,
      actorRole: 'member',
      proposalId,
      idempotencyKey: receipt.idempotency_key,
    }, {
      query: async () => ({ rows: [receipt], rowCount: 1 }),
      connect: async () => { connected = true; throw new Error('must not connect'); },
    } as never);
    expect(result.id).toBe(receipt.id);
    expect(connected).toBe(false);
  });
});
