import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';

const enabled = process.env.RUN_INTEGRATION === 'true';

describe.runIf(enabled)('database-backed API flow', () => {
  let app: Awaited<ReturnType<(typeof import('../src/server.js'))['buildApp']>>;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `integration-${suffix}@example.test`;
  const password = 'integration-test-password';
  let token = '';
  let agentId = '';
  let mcpConnectionId = '';
  let starterInstallationId = '';

  async function waitFor<T>(action: () => Promise<T>, predicate: (value: T) => boolean) {
    for (let attempt = 0; attempt < 75; attempt++) {
      const value = await action();
      if (predicate(value)) return value;
      await delay(200);
    }
    throw new Error('Timed out waiting for asynchronous work to complete');
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const { buildApp } = await import('../src/server.js');
    app = await buildApp();
  });

  afterAll(async () => {
    const { closeQueues } = await import('../src/queue/task-queue.js');
    await closeQueues();
    await app.close();
  });

  it('registers, authenticates, and creates an agent in a workspace', async () => {
    const registration = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email, password, displayName: 'Integration User', workspaceName: `Workspace ${suffix}` } });
    expect(registration.statusCode, registration.body).toBe(201);
    token = registration.json().accessToken;
    expect(registration.json().user.onboarding).toMatchObject({ version: 1, completed: false, lastStep: 1 });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
    expect(login.statusCode, login.body).toBe(200);
    const agent = await app.inject({ method: 'POST', url: '/v1/agents', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Research Agent', role: 'Researcher', goal: 'Find relevant information', instructions: 'Be concise.', status: 'active', modelConfig: { temperature: 0.4, maxTokens: 8192, topP: 0.9 }, capabilities: { webBrowser: true, codeInterpreter: false, knowledgeBase: true } } });
    expect(agent.statusCode, agent.body).toBe(201);
    expect(agent.json()).toMatchObject({ name: 'Research Agent', status: 'active' });
    expect(agent.json().model_config).toEqual({ temperature: 0.4, maxTokens: 8192, topP: 0.9 });
    expect(agent.json().capabilities).toEqual({ webBrowser: true, codeInterpreter: false, knowledgeBase: true });
    agentId = agent.json().id;
  });

  it('persists, skips, and restarts versioned onboarding', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const progress = await app.inject({ method: 'PUT', url: '/v1/auth/onboarding', headers, payload: { lastStep: 3, action: 'progress' } });
    expect(progress.statusCode, progress.body).toBe(200);
    expect(progress.json()).toMatchObject({ version: 1, completed: false, lastStep: 3 });
    const restored = await app.inject({ method: 'GET', url: '/v1/auth/onboarding', headers });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ version: 1, completed: false, lastStep: 3 });
    const skipped = await app.inject({ method: 'PUT', url: '/v1/auth/onboarding', headers, payload: { lastStep: 3, action: 'skip' } });
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(skipped.json()).toMatchObject({ completed: true, lastStep: 3 });
    expect(skipped.json().skippedAt).toBeTruthy();
    const restarted = await app.inject({ method: 'POST', url: '/v1/auth/onboarding/restart', headers });
    expect(restarted.statusCode, restarted.body).toBe(200);
    expect(restarted.json()).toMatchObject({ version: 1, completed: false, lastStep: 1, completedAt: null, skippedAt: null });
    const completed = await app.inject({ method: 'PUT', url: '/v1/auth/onboarding', headers, payload: { lastStep: 6, action: 'complete' } });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({ version: 1, completed: true, lastStep: 6 });
    expect(completed.json().completedAt).toBeTruthy();
    const { query } = await import('../src/db/client.js');
    await query('UPDATE users SET onboarding_version=0 WHERE email=$1', [email]);
    const updatedVersion = await app.inject({ method: 'GET', url: '/v1/auth/onboarding', headers });
    expect(updatedVersion.statusCode, updatedVersion.body).toBe(200);
    expect(updatedVersion.json()).toMatchObject({ version: 1, completed: false, lastStep: 1 });
  });

  it('configures and reports a workspace AI budget without exposing credentials', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const initial = await app.inject({ method: 'GET', url: '/v1/usage/quota', headers });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({ state: 'unconfigured', blocked: false });
    const updated = await app.inject({
      method: 'PUT',
      url: '/v1/usage/budget',
      headers,
      payload: {
        monthlyRequestLimit: 1000,
        monthlyTokenLimit: 1000000,
        monthlyCostLimitUsd: 100,
        inputCostPerMillionUsd: 0.2,
        outputCostPerMillionUsd: 0.4,
        warningPercent: 80,
        hardLimit: true,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      state: 'healthy',
      blocked: false,
      budget: { monthlyRequestLimit: 1000, hardLimit: true, inputCostPerMillionUsd: 0.2 },
    });
    expect(JSON.stringify(updated.json())).not.toMatch(/api.?key|authorization|credential/i);
  });

  it('installs starter and generated multi-agent solutions atomically and idempotently', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const catalog = await app.inject({ method: 'GET', url: '/v1/starter-solutions', headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().data).toHaveLength(10);
    const starter = catalog.json().data.find((item: { slug: string }) => item.slug === 'deep-research-report');
    expect(starter).toBeTruthy();

    const installed = await app.inject({
      method: 'POST',
      url: '/v1/starter-solutions/deep-research-report/install',
      headers,
      payload: { allowDuplicate: false },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json()).toMatchObject({ status: 'draft', solution: { source: 'starter', agents: expect.any(Array) } });
    starterInstallationId = installed.json().id;
    const resources = installed.json().resources;
    expect(Object.values(resources.agentIds)).toHaveLength(4);

    const agents = await app.inject({ method: 'GET', url: '/v1/agents', headers });
    for (const createdId of Object.values(resources.agentIds) as string[]) {
      expect(agents.json().data.find((item: { id: string }) => item.id === createdId)).toMatchObject({ status: 'draft', tool_ids: [] });
    }
    const workflows = await app.inject({ method: 'GET', url: '/v1/workflows', headers });
    const workflow = workflows.json().data.find((item: { id: string }) => item.id === resources.workflowId);
    expect(workflow).toMatchObject({ enabled: false });
    expect(workflow.definition.nodes.filter((node: { type: string }) => node.type === 'agent').every((node: { config: { agentId?: string } }) => Object.values(resources.agentIds).includes(node.config.agentId))).toBe(true);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/starter-solutions/deep-research-report/install',
      headers,
      payload: { allowDuplicate: false },
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);

    const prematureActivation = await app.inject({
      method: 'POST',
      url: `/v1/agent-solutions/installations/${starterInstallationId}/activate`,
      headers,
    });
    expect(prematureActivation.statusCode, prematureActivation.body).toBe(409);
    const missingTestInput = await app.inject({
      method: 'POST',
      url: `/v1/agent-solutions/installations/${starterInstallationId}/test`,
      headers,
      payload: { input: {} },
    });
    expect(missingTestInput.statusCode, missingTestInput.body).toBe(400);

    const generated = {
      ...starter,
      slug: `generated-${suffix.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
      name: `Generated Research ${suffix}`,
      source: 'generated',
    };
    const generatedInstall = await app.inject({
      method: 'POST',
      url: '/v1/agent-solutions/install',
      headers,
      payload: { solution: generated, persistPrompt: false },
    });
    expect(generatedInstall.statusCode, generatedInstall.body).toBe(201);
    expect(generatedInstall.json()).toMatchObject({ status: 'draft', solution: { source: 'generated' } });

    const installations = await app.inject({ method: 'GET', url: '/v1/agent-solutions/installations', headers });
    expect(installations.statusCode, installations.body).toBe(200);
    expect(installations.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: starterInstallationId, source_type: 'starter', status: 'draft' }),
      expect.objectContaining({ id: generatedInstall.json().id, source_type: 'generated', status: 'draft' }),
    ]));
    expect(JSON.stringify(installations.json())).not.toContain('encrypted_source_prompt');
  });

  it('rejects likely secrets before invoking the prompt compiler', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent-solutions/compile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mode: 'automatic',
        prompt: 'Create an agent using api_key=abcdefghijklmnopqrstuvwxyz123456 and then send a report.',
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ error: 'PROMPT_CONTAINS_POSSIBLE_SECRET' });
  });

  it('installs a custom MCP connection without exposing credentials', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const installed = await app.inject({
      method: 'POST',
      url: '/v1/mcp/connections',
      headers,
      payload: {
        name: 'Integration MCP',
        endpointUrl: 'https://1.1.1.1/mcp',
        transport: 'streamable-http',
        auth: { type: 'none' },
      },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json()).toMatchObject({
      name: 'Integration MCP',
      enabled: false,
      health_status: 'unknown',
    });
    expect(installed.json()).not.toHaveProperty('encrypted_credentials');
    mcpConnectionId = installed.json().id;
    const listed = await app.inject({ method: 'GET', url: '/v1/mcp/connections', headers });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data.find((item: { id: string }) => item.id === mcpConnectionId)).not.toHaveProperty('encrypted_credentials');
    const prematureEnable = await app.inject({
      method: 'PATCH',
      url: `/v1/mcp/connections/${mcpConnectionId}`,
      headers,
      payload: { enabled: true },
    });
    expect(prematureEnable.statusCode, prematureEnable.body).toBe(409);
    const removed = await app.inject({ method: 'DELETE', url: `/v1/mcp/connections/${mcpConnectionId}`, headers });
    expect(removed.statusCode, removed.body).toBe(204);
  });

  it('lists curated first-party apps and installs a pinned official endpoint', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const featured = await app.inject({ method: 'GET', url: '/v1/mcp/catalog/featured', headers });
    expect(featured.statusCode, featured.body).toBe(200);
    expect(featured.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'notion', title: 'Notion', installable: true, verifiedDomain: 'notion.com' }),
      expect.objectContaining({ id: 'google-drive', title: 'Google Drive', installable: true, availability: 'preview' }),
      expect.objectContaining({ id: 'obsidian', title: 'Obsidian', installable: false, availability: 'desktop_bridge' }),
    ]));

    const installed = await app.inject({
      method: 'POST',
      url: '/v1/mcp/connections',
      headers,
      payload: { curatedAppId: 'notion', auth: { type: 'oauth2' } },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json()).toMatchObject({
      name: 'Notion',
      endpoint_url: 'https://mcp.notion.com/mcp',
      auth_type: 'oauth2',
      enabled: false,
    });
    expect(installed.json()).not.toHaveProperty('encrypted_credentials');
    const oauthStart = await app.inject({
      method: 'POST',
      url: `/v1/mcp/connections/${installed.json().id}/auth/start`,
      headers,
    });
    expect(oauthStart.statusCode, oauthStart.body).toBe(200);
    expect(new URL(oauthStart.json().authorizationUrl).hostname).toMatch(/notion/);

    const unavailable = await app.inject({
      method: 'POST',
      url: '/v1/mcp/connections',
      headers,
      payload: { curatedAppId: 'obsidian', auth: { type: 'bearer', token: 'not-used' } },
    });
    expect(unavailable.statusCode, unavailable.body).toBe(422);
    expect(unavailable.json().error).toMatch(/desktop bridge/i);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/mcp/connections/${installed.json().id}`,
      headers,
    });
    expect(removed.statusCode, removed.body).toBe(204);
  });

  it('persists the dashboard domain modules and queues work', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const team = await app.inject({ method: 'POST', url: '/v1/teams', headers, payload: { name: 'Research Team' } });
    expect(team.statusCode, team.body).toBe(201);
    const membership = await app.inject({ method: 'PUT', url: `/v1/teams/${team.json().id}/members/${agentId}`, headers, payload: {} });
    expect(membership.statusCode, membership.body).toBe(200);
    const tool = await app.inject({ method: 'POST', url: '/v1/tools', headers, payload: { name: 'Knowledge API', kind: 'api', config: { endpoint: 'https://example.com/api', method: 'GET' }, permissions: ['knowledge.read'] } });
    expect(tool.statusCode, tool.body).toBe(201);
    const workflow = await app.inject({ method: 'POST', url: '/v1/workflows', headers, payload: { name: 'Research workflow', definition: { nodes: [{ id: 'start', type: 'trigger' }, { id: 'finish', type: 'output', config: { output: { done: true }, artifactFormats: ['pdf', 'docx', 'pptx', 'xlsx'] } }], edges: [{ source: 'start', target: 'finish' }] } } });
    expect(workflow.statusCode, workflow.body).toBe(201);
    const workflowRun = await app.inject({ method: 'POST', url: `/v1/workflows/${workflow.json().id}/runs`, headers, payload: { input: { topic: 'agents' } } });
    expect(workflowRun.statusCode, workflowRun.body).toBe(202);
    let completedWorkflow;
    try {
      completedWorkflow = await waitFor(
        () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${workflowRun.json().id}`, headers }),
        (response) => response.statusCode === 200 && response.json().status === 'completed' && response.json().artifacts?.length === 4 && response.json().artifacts.every((item: { status: string }) => item.status === 'ready'),
      );
    } catch (error) {
      const snapshot = await app.inject({ method: 'GET', url: `/v1/workflows/runs/${workflowRun.json().id}`, headers });
      const body = snapshot.json() as {
        status?: string;
        output?: unknown;
        artifacts?: Array<{ format: string; status: string; error_message?: string | null }>;
        events?: Array<{ event_type: string; message: string }>;
      };
      throw new Error(`Workflow artifact generation did not finish: ${JSON.stringify({ run: body.status, output: body.output, artifacts: body.artifacts?.map(({ format, status, error_message }) => ({ format, status, error: error_message ?? null })), recentEvents: body.events?.slice(-4) })}`, { cause: error });
    }
    expect(completedWorkflow.json().output).toMatchObject({ topic: 'agents', done: true });
    expect(completedWorkflow.json().artifacts.map((item: { format: string }) => item.format).sort()).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);
    const integrationApiUrl = (process.env.INTEGRATION_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    for (const artifact of completedWorkflow.json().artifacts as Array<{ id: string; format: string; mime_type: string }>) {
      const download = await fetch(`${integrationApiUrl}/v1/artifacts/${artifact.id}/download`, { headers });
      const rawPayload = Buffer.from(await download.arrayBuffer());
      expect(download.status, rawPayload.toString('utf8', 0, 500)).toBe(200);
      expect(download.headers.get('content-type')).toContain(artifact.mime_type);
      expect(artifact.format === 'pdf' ? rawPayload.subarray(0, 4).toString() : rawPayload.subarray(0, 2).toString()).toBe(artifact.format === 'pdf' ? '%PDF' : 'PK');
    }

    const branchWorkflow = await app.inject({ method: 'POST', url: '/v1/workflows', headers, payload: { name: 'Branch workflow', definition: { nodes: [
      { id: 'start', type: 'trigger' },
      { id: 'route', type: 'condition', config: { path: 'input.approved', operator: 'equals', value: true } },
      { id: 'yes', type: 'output', config: { output: { branch: 'yes' } } },
      { id: 'no', type: 'output', config: { output: { branch: 'no' } } },
    ], edges: [
      { source: 'start', target: 'route' },
      { source: 'route', target: 'yes', condition: 'true' },
      { source: 'route', target: 'no', condition: 'false' },
    ] } } });
    expect(branchWorkflow.statusCode, branchWorkflow.body).toBe(201);
    const branchRun = await app.inject({ method: 'POST', url: `/v1/workflows/${branchWorkflow.json().id}/runs`, headers, payload: { input: { approved: true } } });
    const completedBranch = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${branchRun.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'completed',
    );
    expect(completedBranch.json().output).toMatchObject({ branch: 'yes' });
    expect(completedBranch.json().events).toEqual(expect.arrayContaining([expect.objectContaining({ event_type: 'branch.selected' })]));

    const loopWorkflow = await app.inject({ method: 'POST', url: '/v1/workflows', headers, payload: { name: 'Controlled loop workflow', definition: { nodes: [
      { id: 'start', type: 'trigger' },
      { id: 'items', type: 'loop', config: { mode: 'forEach', collectionPath: 'input.items', itemVariable: 'item', indexVariable: 'index', maxIterations: 3, onLimit: 'fail' } },
      { id: 'review-item', type: 'approval', config: { prompt: 'Approve this iteration' } },
      { id: 'finish', type: 'output', config: { output: { loopCompleted: true } } },
    ], edges: [
      { source: 'start', target: 'items' },
      { source: 'items', target: 'review-item', condition: 'body' },
      { source: 'items', target: 'finish', condition: 'done' },
      { source: 'review-item', target: 'items', condition: 'continue' },
    ] } } });
    expect(loopWorkflow.statusCode, loopWorkflow.body).toBe(201);
    const loopRun = await app.inject({ method: 'POST', url: `/v1/workflows/${loopWorkflow.json().id}/runs`, headers, payload: { input: { items: ['one', 'two'] } } });
    for (let iteration = 0; iteration < 2; iteration++) {
      const waiting = await waitFor(
        () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${loopRun.json().id}`, headers }),
        (response) => response.statusCode === 200 && response.json().status === 'awaiting_approval' && response.json().approvals.some((item: { status: string }) => item.status === 'pending'),
      );
      const pending = waiting.json().approvals.find((item: { status: string }) => item.status === 'pending');
      const decision = await app.inject({ method: 'POST', url: `/v1/workflows/runs/${loopRun.json().id}/approvals/${pending.id}`, headers, payload: { decision: 'approved', comment: `Iteration ${iteration + 1}` } });
      expect(decision.statusCode, decision.body).toBe(200);
    }
    const completedLoop = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${loopRun.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'completed',
    );
    expect(completedLoop.json().output).toMatchObject({ loopCompleted: true });
    expect(completedLoop.json().nodeStates.filter((item: { node_id: string; status: string }) => item.node_id === 'review-item' && item.status === 'completed')).toHaveLength(2);

    const failingTool = await app.inject({ method: 'POST', url: '/v1/tools', headers, payload: { name: `Failing API ${suffix}`, kind: 'api', config: { endpoint: 'https://retry-test.invalid/action', method: 'GET', readOnly: true }, permissions: ['knowledge.read'] } });
    expect(failingTool.statusCode, failingTool.body).toBe(201);
    const retryWorkflow = await app.inject({ method: 'POST', url: '/v1/workflows', headers, payload: { name: 'Retry workflow', definition: { nodes: [
      { id: 'start', type: 'trigger' },
      { id: 'unstable', type: 'action', config: { toolId: failingTool.json().id, input: {}, retry: { maxAttempts: 3, initialDelayMs: 10, multiplier: 2, maxDelayMs: 100 } } },
      { id: 'finish', type: 'output' },
    ], edges: [{ source: 'start', target: 'unstable' }, { source: 'unstable', target: 'finish' }] } } });
    expect(retryWorkflow.statusCode, retryWorkflow.body).toBe(201);
    const retryRun = await app.inject({ method: 'POST', url: `/v1/workflows/${retryWorkflow.json().id}/runs`, headers, payload: { input: {} } });
    const failedRetry = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${retryRun.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'failed',
    );
    expect(failedRetry.json().nodeStates.filter((item: { node_id: string }) => item.node_id === 'unstable')).toHaveLength(3);
    expect(failedRetry.json().events.filter((item: { event_type: string }) => item.event_type === 'node.retry_scheduled')).toHaveLength(2);

    const writeTool = await app.inject({ method: 'POST', url: '/v1/tools', headers, payload: { name: `Write API ${suffix}`, kind: 'api', config: { endpoint: 'https://example.com/api', method: 'POST' }, permissions: ['records.write'] } });
    expect(writeTool.statusCode, writeTool.body).toBe(201);
    const unsafeWriteWorkflow = await app.inject({ method: 'POST', url: '/v1/workflows', headers, payload: { name: 'Unsafe write workflow', definition: { nodes: [
      { id: 'start', type: 'trigger' },
      { id: 'write', type: 'action', config: { toolId: writeTool.json().id, retry: { maxAttempts: 2 } } },
      { id: 'finish', type: 'output' },
    ], edges: [{ source: 'start', target: 'write' }, { source: 'write', target: 'finish' }] } } });
    expect(unsafeWriteWorkflow.statusCode, unsafeWriteWorkflow.body).toBe(400);
    expect(unsafeWriteWorkflow.json()).toMatchObject({ error: 'UNSAFE_ACTION_NODE' });

    const approvalWorkflow = await app.inject({ method: 'POST', url: '/v1/workflows', headers, payload: { name: 'Approval workflow', definition: { nodes: [{ id: 'start', type: 'trigger' }, { id: 'review', type: 'approval' }, { id: 'finish', type: 'output', config: { output: { approved: true } } }], edges: [{ source: 'start', target: 'review' }, { source: 'review', target: 'finish' }] } } });
    expect(approvalWorkflow.statusCode, approvalWorkflow.body).toBe(201);
    const approvalRun = await app.inject({ method: 'POST', url: `/v1/workflows/${approvalWorkflow.json().id}/runs`, headers, payload: { input: { subject: 'approval-resume' } } });
    expect(approvalRun.statusCode, approvalRun.body).toBe(202);
    const awaitingApproval = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${approvalRun.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'awaiting_approval',
    );
    const pendingApproval = awaitingApproval.json().approvals.find((item: { status: string }) => item.status === 'pending');
    expect(pendingApproval).toBeTruthy();
    const approvalDecision = await app.inject({ method: 'POST', url: `/v1/workflows/runs/${approvalRun.json().id}/approvals/${pendingApproval.id}`, headers, payload: { decision: 'approved', comment: 'Integration approval' } });
    expect(approvalDecision.statusCode, approvalDecision.body).toBe(200);
    const completedApprovalWorkflow = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${approvalRun.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'completed',
    );
    expect(completedApprovalWorkflow.json().output).toMatchObject({ subject: 'approval-resume', approved: true });
    const task = await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { agentId, title: 'Research current market', input: { topic: 'agent platforms' }, artifactFormats: ['pdf'] } });
    expect(task.statusCode, task.body).toBe(202);
    const taskWithArtifact = await app.inject({ method: 'GET', url: `/v1/tasks/${task.json().id}`, headers });
    expect(taskWithArtifact.statusCode, taskWithArtifact.body).toBe(200);
    expect(taskWithArtifact.json().artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ format: 'pdf', status: 'pending' })]));
    const memory = await app.inject({ method: 'POST', url: '/v1/memories', headers, payload: { agentId, kind: 'knowledge', content: 'Focus on credible sources.', importance: 0.8 } });
    expect(memory.statusCode, memory.body).toBe(201);
    const document = await app.inject({ method: 'POST', url: '/v1/knowledge/documents', headers, payload: { name: 'Notes', sourceType: 'text', content: 'AI agents can use tools and workflows.' } });
    expect(document.statusCode, document.body).toBe(202);
    const indexedDocuments = await waitFor(
      () => app.inject({ method: 'GET', url: '/v1/knowledge/documents', headers }),
      (response) => response.statusCode === 200 && response.json().data.some((item: { id: string; status: string }) => item.id === document.json().id && item.status === 'ready'),
    );
    expect(indexedDocuments.json().data.find((item: { id: string }) => item.id === document.json().id)).toMatchObject({ status: 'ready' });
    const knowledgeSearch = await app.inject({ method: 'POST', url: '/v1/knowledge/search', headers, payload: { query: 'tools workflows' } });
    expect(knowledgeSearch.statusCode, knowledgeSearch.body).toBe(200);
    expect(knowledgeSearch.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ document_id: document.json().id })]));
    const prompt = await app.inject({ method: 'POST', url: '/v1/prompts/templates', headers, payload: { name: 'Research prompt', content: 'Research {{topic}}.', variables: ['topic'] } });
    expect(prompt.statusCode, prompt.body).toBe(201);
    const analytics = await app.inject({ method: 'GET', url: '/v1/analytics/overview', headers });
    expect(analytics.statusCode, analytics.body).toBe(200);
    expect(analytics.json()).toHaveProperty('agents');
  }, 30_000);

  it('blocks new AI work after an enforced local budget is exhausted', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const budget = await app.inject({
      method: 'PUT',
      url: '/v1/usage/budget',
      headers,
      payload: {
        monthlyRequestLimit: 1,
        monthlyTokenLimit: null,
        monthlyCostLimitUsd: null,
        inputCostPerMillionUsd: null,
        outputCostPerMillionUsd: null,
        warningPercent: 80,
        hardLimit: true,
      },
    });
    expect(budget.statusCode, budget.body).toBe(200);
    const { query } = await import('../src/db/client.js');
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
    await query(
      `INSERT INTO ai_usage_events(workspace_id,source,provider,model,request_id,input_tokens,output_tokens)
       VALUES($1,'prompt_compiler','openai-compatible','integration-model',$2,1,1)`,
      [me.json().workspace_id, `budget-test-${suffix}`],
    );
    const status = await app.inject({ method: 'GET', url: '/v1/usage/quota', headers });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({ state: 'blocked', blocked: true });
    const task = await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { agentId, title: 'Blocked by local budget', input: {} } });
    expect(task.statusCode, task.body).toBe(429);
    expect(task.json()).toMatchObject({ error: 'AI_BUDGET_EXHAUSTED' });
  });
});
