import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_INTEGRATION === 'true';

describe.runIf(enabled)('Copilot proposal API', () => {
  let app: Awaited<ReturnType<(typeof import('../src/server.js'))['buildApp']>>;
  let db: (typeof import('../src/db/client.js'))['db'];
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const password = 'integration-test-password';
  let token = '';
  let otherToken = '';
  let workspaceId = '';
  let actorId = '';
  let agentId = '';
  let taskId = '';
  let documentId = '';
  let threadId = '';
  let contextSnapshotId = '';

  const headers = () => ({ authorization: `Bearer ${token}` });

  async function register(emailPrefix: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `${emailPrefix}-${suffix}@example.test`,
        password,
        displayName: 'Copilot Integration User',
        workspaceName: `Copilot Workspace ${emailPrefix} ${suffix}`,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const modules = await Promise.all([import('../src/server.js'), import('../src/db/client.js')]);
    app = await modules[0].buildApp();
    db = modules[1].db;

    const owner = await register('owner');
    token = owner.accessToken;
    workspaceId = owner.workspace.id;
    actorId = owner.user.id;
    const outsider = await register('outsider');
    otherToken = outsider.accessToken;

    const agent = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: headers(),
      payload: {
        name: 'Context Agent',
        role: 'Writer',
        goal: 'Produce a draft',
        instructions: 'Be concise.',
        status: 'active',
        modelConfig: { temperature: 0.2, maxTokens: 2048, topP: 1 },
        capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: false },
        avatar: { type: 'initials', value: 'CA', backgroundColor: '#111827', accentColor: '#f9fafb' },
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    agentId = agent.json().id;

    taskId = (await db.query<{ id: string }>(
      `INSERT INTO tasks(workspace_id,agent_id,title,input,status,output,requested_by,completed_at)
       VALUES($1,$2,'Completed output','{}','completed','{}',$3,now()) RETURNING id`,
      [workspaceId, agentId, actorId],
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
       ) VALUES($1,$2,1,$3,$4,$5)`,
      [workspaceId, documentId, '# Original output', createOutputContentHash('# Original output'), actorId],
    );

    const thread = await app.inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      headers: headers(),
      payload: { title: 'Refine output' },
    });
    expect(thread.statusCode, thread.body).toBe(201);
    threadId = thread.json().id;
  });

  afterAll(async () => {
    const { closeQueues } = await import('../src/queue/task-queue.js');
    await closeQueues();
    await app.close();
  });

  it('attaches only authoritative same-workspace context', async () => {
    const attached = await app.inject({
      method: 'POST',
      url: `/v1/copilot/threads/${threadId}/context`,
      headers: headers(),
      payload: { taskId, outputDocumentId: documentId },
    });
    expect(attached.statusCode, attached.body).toBe(201);
    expect(attached.json()).toMatchObject({
      task: { id: taskId },
      output: { documentId, versionNumber: 1 },
    });
    expect(attached.body).not.toContain(workspaceId);
    expect(attached.body).not.toContain(actorId);
    contextSnapshotId = attached.json().id;

    const outsiderThread = await app.inject({
      method: 'POST',
      url: '/v1/copilot/threads',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { title: 'Cross-workspace attempt' },
    });
    const crossed = await app.inject({
      method: 'POST',
      url: `/v1/copilot/threads/${outsiderThread.json().id}/context`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { taskId, outputDocumentId: documentId },
    });
    expect(crossed.statusCode, crossed.body).toBe(404);
    expect(crossed.json()).toEqual({ error: 'COPILOT_CONTEXT_NOT_FOUND' });
  });

  it('rejects explicitly and restores its typed event on thread reload', async () => {
    const { createCopilotProposal } = await import('../src/copilot/repository.js');
    const context = (await db.query<{
      output_version_id: string;
      snapshot: { output: { contentHash: string; versionNumber: number } };
    }>('SELECT output_version_id,snapshot FROM copilot_context_snapshots WHERE id=$1', [contextSnapshotId])).rows[0];
    const proposal = await createCopilotProposal({
      workspaceId,
      actorId,
      threadId,
      contextSnapshotId,
      kind: 'output_refinement',
      candidate: {
        documentId,
        baseVersionId: context.output_version_id,
        baseVersionNumber: context.snapshot.output.versionNumber,
        baseContentHash: context.snapshot.output.contentHash,
        proposedContent: '# Refined output',
        proposedContentHash: '0'.repeat(64),
        changeSummary: ['Clarified the conclusion'],
      },
      dependsOnOutputVersion: true,
    });
    const event = { type: 'refinement_preview', proposal };
    await db.query(
      `INSERT INTO chat_messages(
         workspace_id,thread_id,role,content,metadata,context_snapshot_id,proposal_id
       ) VALUES($1,$2,'assistant','Review this refinement',$3,$4,$5)`,
      [workspaceId, threadId, JSON.stringify({ event }), contextSnapshotId, proposal.id],
    );

    const reloaded = await app.inject({
      method: 'GET',
      url: `/v1/copilot/threads/${threadId}`,
      headers: headers(),
    });
    expect(reloaded.statusCode, reloaded.body).toBe(200);
    expect(reloaded.json().messages.at(-1).metadata.event).toEqual(event);

    const rejected = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${proposal.id}/reject`,
      headers: headers(),
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().status).toBe('rejected');
  });

  it('approves once, creates a new output version, and returns the receipt', async () => {
    const { createCopilotProposal } = await import('../src/copilot/repository.js');
    const current = (await db.query<{
      id: string;
      version_number: number;
      content_hash: string;
    }>(
      `SELECT version.id,version.version_number,version.content_hash
         FROM output_documents document
         JOIN output_document_versions version
           ON version.document_id=document.id AND version.version_number=document.current_version_number
        WHERE document.id=$1`,
      [documentId],
    )).rows[0];
    const proposal = await createCopilotProposal({
      workspaceId,
      actorId,
      threadId,
      contextSnapshotId,
      kind: 'output_refinement',
      candidate: {
        documentId,
        baseVersionId: current.id,
        baseVersionNumber: current.version_number,
        baseContentHash: current.content_hash,
        proposedContent: '# Accepted refinement',
        proposedContentHash: '0'.repeat(64),
        changeSummary: ['Made the conclusion explicit'],
      },
      dependsOnOutputVersion: true,
    });
    const idempotencyKey = crypto.randomUUID();
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${proposal.id}/approve`,
      headers: headers(),
      payload: { idempotencyKey },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({
      proposalId: proposal.id,
      status: 'succeeded',
      operation: 'output.version_created',
      resource: { previousVersion: 1, resultingVersion: 2 },
    });
    expect(approved.body).not.toContain(workspaceId);
    expect(approved.body).not.toContain(actorId);

    const retried = await app.inject({
      method: 'POST',
      url: `/v1/copilot/proposals/${proposal.id}/approve`,
      headers: headers(),
      payload: { idempotencyKey },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toEqual(approved.json());

    const receipt = await app.inject({
      method: 'GET',
      url: `/v1/copilot/receipts/${approved.json().id}`,
      headers: headers(),
    });
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.json()).toEqual(approved.json());
  });
});
