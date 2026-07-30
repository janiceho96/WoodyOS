import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotGeneratedTurn } from '../src/copilot/types.js';

const enabled = process.env.RUN_INTEGRATION === 'true';

describe.runIf(enabled)('Copilot refinement and Draft-agent vertical slice', () => {
  let app: Awaited<ReturnType<(typeof import('../src/server.js'))['buildApp']>>;
  let db: (typeof import('../src/db/client.js'))['db'];
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const password = 'integration-test-password';
  let token = '';
  let workspaceId = '';
  let actorId = '';
  let taskId = '';
  let documentId = '';
  let threadId = '';
  let contextSnapshotId = '';
  let firstApprovalKey = '';
  let firstReceiptId = '';

  const headers = () => ({ authorization: `Bearer ${token}` });

  async function register(label: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `copilot-slice-${label}-${suffix}@example.test`,
        password,
        displayName: `Copilot ${label}`,
        workspaceName: `Copilot ${label} ${suffix}`,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }

  async function attachContext(auth = headers(), activeThread = threadId) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/copilot/threads/${activeThread}/context`,
      headers: auth,
      payload: { taskId, outputDocumentId: documentId },
    });
    expect(response.statusCode, response.body).toBe(201);
    if (activeThread === threadId) contextSnapshotId = response.json().id;
    return response.json() as { id: string };
  }

  async function generatedTurn(
    generated: CopilotGeneratedTurn,
    input: { actor?: string; thread?: string; workspace?: string; contextId?: string } = {},
  ) {
    const { orchestrateCopilotTurn } = await import('../src/copilot/orchestrator.js');
    const activeThread = input.thread ?? threadId;
    const workspace = input.workspace ?? workspaceId;
    const actor = input.actor ?? actorId;
    const result = await orchestrateCopilotTurn({
      workspaceId: workspace,
      actorId: actor,
      threadId: activeThread,
      messages: [{ role: 'user', content: 'Prepare the next safe proposal.' }],
      generator: async () => generated,
    });
    await db.query(
      `INSERT INTO chat_messages(
         workspace_id,thread_id,role,content,metadata,context_snapshot_id,proposal_id
       ) VALUES($1,$2,'assistant',$3,$4,$5,$6)`,
      [
        workspace,
        activeThread,
        result.content,
        JSON.stringify({ event: result.event }),
        input.contextId ?? result.contextSnapshotId,
        result.proposalId ?? null,
      ],
    );
    return result;
  }

  async function refinement(content: string) {
    return generatedTurn({
      type: 'refinement_candidate',
      proposedContent: content,
      changeSummary: ['Clarified the conclusion'],
    });
  }

  const draftCandidate = {
    name: 'Safe Draft Writer',
    role: 'Writer',
    goal: 'Create a grounded first draft',
    instructions: 'Use the accepted output as context.',
    personality: 'Calm',
    model: 'test-model',
    modelConfig: { temperature: 0.2, maxTokens: 2048, topP: 1 },
    capabilities: { webBrowser: true, codeInterpreter: true, knowledgeBase: true },
    memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: true },
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const modules = await Promise.all([import('../src/server.js'), import('../src/db/client.js')]);
    app = await modules[0].buildApp();
    db = modules[1].db;
    const owner = await register('owner');
    token = owner.accessToken;
    workspaceId = owner.workspace.id;
    actorId = owner.user.id;

    const agent = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: headers(),
      payload: {
        name: 'Source Agent',
        role: 'Writer',
        goal: 'Create a source output',
        instructions: 'Return a concise result.',
        status: 'active',
        modelConfig: { temperature: 0.2, maxTokens: 2048, topP: 1 },
        capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: false },
        avatar: { type: 'initials', value: 'SA', backgroundColor: '#111827', accentColor: '#f9fafb' },
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    taskId = (await db.query<{ id: string }>(
      `INSERT INTO tasks(workspace_id,agent_id,title,input,status,output,requested_by,completed_at)
       VALUES($1,$2,'Original task','{}','completed',$3,$4,now()) RETURNING id`,
      [workspaceId, agent.json().id, JSON.stringify({ legacy: 'unchanged' }), actorId],
    )).rows[0].id;
    documentId = (await db.query<{ id: string }>(
      `INSERT INTO output_documents(workspace_id,task_id,current_version_number,created_by)
       VALUES($1,$2,1,$3) RETURNING id`,
      [workspaceId, taskId, actorId],
    )).rows[0].id;
    const { createOutputContentHash } = await import('../src/outputs/types.js');
    await db.query(
      `INSERT INTO output_document_versions(
         workspace_id,document_id,version_number,content,content_hash,created_by
       ) VALUES($1,$2,1,'# Original output',$3,$4)`,
      [workspaceId, documentId, createOutputContentHash('# Original output'), actorId],
    );
    const thread = await app.inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      headers: headers(),
      payload: { title: 'Vertical slice' },
    });
    expect(thread.statusCode, thread.body).toBe(201);
    threadId = thread.json().id;
  }, 30_000);

  afterAll(async () => {
    await db.query('DROP TRIGGER IF EXISTS copilot_test_fail_audit ON audit_events').catch(() => undefined);
    await db.query('DROP FUNCTION IF EXISTS copilot_test_fail_audit()').catch(() => undefined);
    const { closeQueues } = await import('../src/queue/task-queue.js');
    await closeQueues();
    await app.close();
  });

  it('runs clarification, refinement, and Draft creation in one durable thread', async () => {
    await attachContext();
    const clarification = await generatedTurn({
      type: 'clarification',
      proposalKind: 'output_refinement',
      questions: [{ id: 'audience', question: 'Who should read the conclusion?' }],
    });
    expect(clarification.event.type).toBe('clarification');
    expect(clarification.proposalId).toBeUndefined();
    const { loadCopilotTurnContext } = await import('../src/copilot/orchestrator.js');
    const loadedAfterClarification = await loadCopilotTurnContext({ workspaceId, actorId, threadId });
    expect(loadedAfterClarification.outstandingProposalKind).toBe('output_refinement');

    const preview = await refinement('# Refined and accepted output');
    expect(preview.event.type).toBe('refinement_preview');
    firstApprovalKey = crypto.randomUUID();
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${preview.proposalId}/approve`,
      headers: headers(),
      payload: { idempotencyKey: firstApprovalKey },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({
      status: 'succeeded',
      operation: 'output.version_created',
      resource: { previousVersion: 1, resultingVersion: 2 },
    });
    firstReceiptId = approved.json().id;

    const retried = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${preview.proposalId}/approve`,
      headers: headers(),
      payload: { idempotencyKey: firstApprovalKey },
    });
    expect(retried.json()).toEqual(approved.json());

    const task = (await db.query<{ output: unknown }>('SELECT output FROM tasks WHERE id=$1', [taskId])).rows[0];
    expect(task.output).toEqual({ legacy: 'unchanged' });
    const current = (await db.query<{ current_version_number: number }>(
      'SELECT current_version_number FROM output_documents WHERE id=$1',
      [documentId],
    )).rows[0];
    expect(current.current_version_number).toBe(2);
    expect(approved.json().auditEventId).toBeTruthy();

    await attachContext();
    const agentProposal = await generatedTurn({
      type: 'draft_agent_candidate',
      candidate: draftCandidate,
      dependsOnOutputVersion: true,
    });
    expect(agentProposal.event.type).toBe('agent_proposal');
    const agentApproval = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${agentProposal.proposalId}/approve`,
      headers: headers(),
      payload: { idempotencyKey: crypto.randomUUID() },
    });
    expect(agentApproval.statusCode, agentApproval.body).toBe(200);
    expect(agentApproval.json()).toMatchObject({ status: 'succeeded', operation: 'agent.draft_created' });
    expect(agentApproval.json().auditEventId).toBeTruthy();

    const createdAgent = (await db.query<{
      status: string;
      tool_ids: string[];
      capabilities: { webBrowser: boolean; codeInterpreter: boolean };
    }>('SELECT status,tool_ids,capabilities FROM agents WHERE id=$1', [agentApproval.json().resource.id])).rows[0];
    expect(createdAgent).toMatchObject({
      status: 'draft',
      tool_ids: [],
      capabilities: { webBrowser: false, codeInterpreter: false },
    });

    const reloaded = await app.inject({
      method: 'GET',
      url: `/v1/copilot/threads/${threadId}`,
      headers: headers(),
    });
    expect(reloaded.statusCode, reloaded.body).toBe(200);
    const events = reloaded.json().messages.map((message: { event?: { type: string } }) => message.event).filter(Boolean);
    expect(events.filter((event: { type: string }) => event.type === 'execution_receipt')).toHaveLength(2);
    const proposals = events.filter((event: { type: string }) => ['refinement_preview', 'agent_proposal'].includes(event.type));
    expect(proposals.every((event: { proposal: { status: string } }) => event.proposal.status === 'applied')).toBe(true);
  });

  it('forbids a viewer from applying their generated proposal', async () => {
    const viewer = await register('viewer');
    await db.query(
      `INSERT INTO workspace_memberships(workspace_id,user_id,role)
       VALUES($1,$2,'viewer') ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='viewer'`,
      [workspaceId, viewer.user.id],
    );
    const viewerToken = app.jwt.sign({ sub: viewer.user.id, workspaceId, role: 'viewer' });
    const viewerHeaders = { authorization: `Bearer ${viewerToken}` };
    const thread = await app.inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      headers: viewerHeaders,
      payload: { title: 'Viewer proposal' },
    });
    await attachContext(viewerHeaders, thread.json().id);
    const proposal = await generatedTurn({
      type: 'draft_agent_candidate',
      candidate: draftCandidate,
      dependsOnOutputVersion: true,
    }, {
      actor: viewer.user.id,
      thread: thread.json().id,
      workspace: workspaceId,
    });
    const approval = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${proposal.proposalId}/approve`,
      headers: viewerHeaders,
      payload: { idempotencyKey: crypto.randomUUID() },
    });
    expect(approval.statusCode, approval.body).toBe(403);
    expect(approval.json()).toEqual({ error: 'FORBIDDEN' });
  });

  it('rejects stale context, reused keys, and cross-workspace identifiers', async () => {
    await attachContext();
    const stale = await refinement('# This proposal will become stale');
    const before = (await db.query<{ current_version_number: number }>(
      'SELECT current_version_number FROM output_documents WHERE id=$1',
      [documentId],
    )).rows[0].current_version_number;
    const advanced = await app.inject({
      method: 'POST',
      url: `/v1/output-documents/${documentId}/versions`,
      headers: headers(),
      payload: { content: '# Independently saved output', baseVersionNumber: before },
    });
    expect(advanced.statusCode, advanced.body).toBe(201);
    const staleApproval = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${stale.proposalId}/approve`,
      headers: headers(),
      payload: { idempotencyKey: crypto.randomUUID() },
    });
    expect(staleApproval.statusCode, staleApproval.body).toBe(409);
    expect(staleApproval.json()).toEqual({ error: 'COPILOT_CONTEXT_STALE' });
    expect((await db.query<{ current_version_number: number }>(
      'SELECT current_version_number FROM output_documents WHERE id=$1',
      [documentId],
    )).rows[0].current_version_number).toBe(before + 1);

    await attachContext();
    const another = await refinement('# Another proposal');
    const keyConflict = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${another.proposalId}/approve`,
      headers: headers(),
      payload: { idempotencyKey: firstApprovalKey },
    });
    expect(keyConflict.statusCode, keyConflict.body).toBe(409);
    expect(keyConflict.json()).toEqual({ error: 'COPILOT_IDEMPOTENCY_CONFLICT' });
    expect(firstReceiptId).toBeTruthy();

    const outsider = await register('cross-workspace');
    const outsiderThread = await app.inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: { title: 'Outsider' },
    });
    const crossed = await app.inject({
      method: 'POST',
      url: `/v1/copilot/threads/${outsiderThread.json().id}/context`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: { taskId, outputDocumentId: documentId },
    });
    const missing = await app.inject({
      method: 'POST',
      url: `/v1/copilot/threads/${outsiderThread.json().id}/context`,
      headers: { authorization: `Bearer ${outsider.accessToken}` },
      payload: { taskId: crypto.randomUUID(), outputDocumentId: crypto.randomUUID() },
    });
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json()).toEqual(missing.json());
  });

  it('audits payload tampering and creates no output version', async () => {
    await attachContext();
    const tampered = await refinement('# Valid before tampering');
    await db.query(
      `UPDATE copilot_proposals
          SET payload=jsonb_set(payload,'{proposedContent}',to_jsonb('# Tampered'::text))
        WHERE id=$1`,
      [tampered.proposalId],
    );
    const before = (await db.query<{ count: string }>(
      'SELECT count(*)::text FROM output_document_versions WHERE document_id=$1',
      [documentId],
    )).rows[0].count;
    const response = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${tampered.proposalId}/approve`,
      headers: headers(),
      payload: { idempotencyKey: crypto.randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({ error: 'COPILOT_PROPOSAL_INVALID' });
    expect((await db.query<{ count: string }>(
      'SELECT count(*)::text FROM output_document_versions WHERE document_id=$1',
      [documentId],
    )).rows[0].count).toBe(before);
    const audit = await db.query(
      `SELECT id FROM audit_events
        WHERE workspace_id=$1 AND action='copilot.proposal.security_rejected'
          AND entity_id=$2`,
      [workspaceId, tampered.proposalId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('fails every deferred operation closed without creating proposals', async () => {
    await attachContext();
    const before = (await db.query<{ count: string }>(
      'SELECT count(*)::text FROM copilot_proposals WHERE thread_id=$1',
      [threadId],
    )).rows[0].count;
    for (const operation of [
      'workflow graph change',
      'department change',
      'MCP connection',
      'API permission grant',
      'publishing',
      'activation',
      'scheduling',
      'external action',
    ]) {
      const result = await generatedTurn({
        type: 'unsupported',
        content: `${operation} is outside this Copilot slice.`,
      });
      expect(result.content).toContain('COPILOT_OPERATION_UNSUPPORTED');
    }
    expect((await db.query<{ count: string }>(
      'SELECT count(*)::text FROM copilot_proposals WHERE thread_id=$1',
      [threadId],
    )).rows[0].count).toBe(before);
  });

  it('rolls back the domain mutation when receipt-path persistence fails', async () => {
    await attachContext();
    const proposal = await refinement('# Must roll back');
    const before = (await db.query<{ current_version_number: number }>(
      'SELECT current_version_number FROM output_documents WHERE id=$1',
      [documentId],
    )).rows[0].current_version_number;
    await db.query('DROP TRIGGER IF EXISTS copilot_test_fail_audit ON audit_events');
    await db.query('DROP FUNCTION IF EXISTS copilot_test_fail_audit()');
    await db.query(`
      CREATE FUNCTION copilot_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action='copilot.output_version.created'
           AND NEW.metadata->>'proposalId'='${proposal.proposalId}' THEN
          RAISE EXCEPTION 'forced copilot audit failure';
        END IF;
        RETURN NEW;
      END $$`);
    await db.query(`
      CREATE TRIGGER copilot_test_fail_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION copilot_test_fail_audit()`);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/copilot/proposals/${proposal.proposalId}/approve`,
        headers: headers(),
        payload: { idempotencyKey: crypto.randomUUID() },
      });
      expect(response.statusCode, response.body).toBe(500);
      expect((await db.query<{ current_version_number: number }>(
        'SELECT current_version_number FROM output_documents WHERE id=$1',
        [documentId],
      )).rows[0].current_version_number).toBe(before);
      const leaked = await db.query(
        `SELECT id FROM output_document_versions
          WHERE document_id=$1 AND version_number=$2`,
        [documentId, before + 1],
      );
      expect(leaked.rowCount).toBe(0);
    } finally {
      await db.query('DROP TRIGGER IF EXISTS copilot_test_fail_audit ON audit_events');
      await db.query('DROP FUNCTION IF EXISTS copilot_test_fail_audit()');
    }
  });
});
