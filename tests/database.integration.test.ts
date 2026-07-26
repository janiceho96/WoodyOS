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
  let jobToolId = '';

  function multipartFile(filename: string, contentType: string, content: string | Buffer, fields: Record<string, string> = {}) {
    const boundary = `----woody-integration-${suffix}`;
    const parts = Object.entries(fields).map(([name, value]) => Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    parts.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return {
      payload: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

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
    const agent = await app.inject({ method: 'POST', url: '/v1/agents', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Research Agent', role: 'Researcher', goal: 'Find relevant information', instructions: 'Be concise.', status: 'active', modelConfig: { temperature: 0.4, maxTokens: 8192, topP: 0.9 }, capabilities: { webBrowser: true, codeInterpreter: false, knowledgeBase: true }, avatar: { type: 'icon', value: 'search', backgroundColor: '#312e81', accentColor: '#a5b4fc' } } });
    expect(agent.statusCode, agent.body).toBe(201);
    expect(agent.json()).toMatchObject({ name: 'Research Agent', status: 'active' });
    expect(agent.json().model_config).toEqual({ temperature: 0.4, maxTokens: 8192, topP: 0.9 });
    expect(agent.json().capabilities).toEqual({ webBrowser: true, codeInterpreter: false, knowledgeBase: true });
    expect(agent.json().avatar_config).toEqual({ type: 'icon', value: 'search', backgroundColor: '#312e81', accentColor: '#a5b4fc' });
    agentId = agent.json().id;
    const customized = await app.inject({ method: 'PATCH', url: `/v1/agents/${agentId}`, headers: { authorization: `Bearer ${token}` }, payload: { avatar: { type: 'initials', value: 'RA', backgroundColor: '#164e63', accentColor: '#67e8f9' } } });
    expect(customized.statusCode, customized.body).toBe(200);
    expect(customized.json().avatar_config).toMatchObject({ type: 'initials', value: 'RA' });
    const reset = await app.inject({ method: 'DELETE', url: `/v1/agents/${agentId}/avatar`, headers: { authorization: `Bearer ${token}` } });
    expect(reset.statusCode, reset.body).toBe(204);
    const restored = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}`, headers: { authorization: `Bearer ${token}` } });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().avatar_config).toEqual({});
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

  it('stores a workspace AI provider without exposing its key', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/runtime/config',
      headers,
      payload: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1/chat/completions',
        defaultModel: 'integration-model',
        apiKey: 'integration-provider-secret-key',
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'integration-model',
      source: 'workspace',
      configured: true,
      apiKeyHint: '•••• -key',
      status: 'untested',
    });
    expect(JSON.stringify(saved.json())).not.toContain('integration-provider-secret-key');
    expect(JSON.stringify(saved.json())).not.toMatch(/encrypted_api_key|encryptedApiKey/);

    const updated = await app.inject({
      method: 'PUT',
      url: '/v1/runtime/config',
      headers,
      payload: { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', defaultModel: 'integration-model-2' },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ defaultModel: 'integration-model-2', apiKeyHint: '•••• -key' });

    const missingReplacementKey = await app.inject({
      method: 'PUT',
      url: '/v1/runtime/config',
      headers,
      payload: { provider: 'anthropic', defaultModel: 'claude-test' },
    });
    expect(missingReplacementKey.statusCode, missingReplacementKey.body).toBe(400);
    expect(missingReplacementKey.json()).toMatchObject({ error: 'AI_PROVIDER_API_KEY_REQUIRED' });
  });

  it('installs a curated read-only demo API idempotently without exposing its endpoint configuration', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const catalog = await app.inject({ method: 'GET', url: '/v1/tools/demos', headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'book-search', installed: false }),
    ]));
    expect(catalog.body).not.toContain('openlibrary.org/search.json');
    const installed = await app.inject({ method: 'POST', url: '/v1/tools/demos/book-search/install', headers });
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json()).toMatchObject({ name: 'Demo · Book Search', kind: 'api', enabled: true, alreadyInstalled: false });
    expect(installed.json()).not.toHaveProperty('config');
    const repeated = await app.inject({ method: 'POST', url: '/v1/tools/demos/book-search/install', headers });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toMatchObject({ id: installed.json().id, alreadyInstalled: true });
    const { query } = await import('../src/db/client.js');
    const stored = await query<{ config: unknown }>('SELECT config FROM tools WHERE id=$1', [installed.json().id]);
    expect(JSON.stringify(stored.rows[0].config)).not.toContain('openlibrary.org');
  });

  it('installs isolated web research tools and assigns them through explicit agent access', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const catalog = await app.inject({ method: 'GET', url: '/v1/tools/web/catalog', headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tavily', installed: false }),
      expect.objectContaining({ id: 'firecrawl-search', installed: false }),
      expect.objectContaining({ id: 'firecrawl-extract', installed: false }),
      expect.objectContaining({ id: 'page-reader', installed: false }),
      expect.objectContaining({ id: 'reddit', installed: false }),
    ]));
    expect(JSON.stringify(catalog.json())).not.toMatch(/clientSecret|encrypted|tvly-/i);

    const search = await app.inject({
      method: 'POST', url: '/v1/tools/web/install', headers,
      payload: { provider: 'searxng', endpoint: 'https://search.example.com/search', safeSearch: 'strict', maxResults: 6, allowedDomains: ['zhihu.com', 'reddit.com'] },
    });
    expect(search.statusCode, search.body).toBe(201);
    expect(search.json()).toMatchObject({ name: 'Web Search · SearXNG', kind: 'internal', permissions: ['web.read', 'web.search'], enabled: true });
    expect(search.json()).not.toHaveProperty('config');

    const reader = await app.inject({
      method: 'POST', url: '/v1/tools/web/install', headers,
      payload: { provider: 'page-reader', maxCharacters: 12_000, blockedDomains: ['example.com'] },
    });
    expect(reader.statusCode, reader.body).toBe(201);
    expect(reader.json()).toMatchObject({ name: 'Web · Safe Page Reader', kind: 'internal', permissions: ['web.read', 'web.page.read'], enabled: true });
    expect(reader.json()).not.toHaveProperty('config');
    const readerHealth = await app.inject({ method: 'POST', url: `/v1/tools/${reader.json().id}/test`, headers });
    expect(readerHealth.statusCode, readerHealth.body).toBe(200);
    expect(readerHealth.json()).toMatchObject({ status: 'healthy' });

    const reddit = await app.inject({
      method: 'POST', url: '/v1/tools/web/install', headers,
      payload: { provider: 'reddit', clientId: 'integration-client', clientSecret: 'integration-reddit-secret', userAgent: 'macos:woody-integration:v0.1 (by /u/integration)', maxResults: 5 },
    });
    expect(reddit.statusCode, reddit.body).toBe(201);
    expect(reddit.json()).toMatchObject({ name: 'Web · Reddit Search', permissions: ['web.read', 'reddit.read'] });
    expect(JSON.stringify(reddit.json())).not.toContain('integration-reddit-secret');

    const assigned = await app.inject({
      method: 'PATCH', url: `/v1/agents/${agentId}`, headers,
      payload: { capabilities: { webBrowser: true, codeInterpreter: false, knowledgeBase: true }, toolIds: [search.json().id, reader.json().id, reddit.json().id] },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json()).toMatchObject({ capabilities: { webBrowser: true }, tool_ids: [search.json().id, reader.json().id, reddit.json().id] });

    const reconfiguredSearch = await app.inject({
      method: 'POST', url: '/v1/tools/web/install', headers,
      payload: { provider: 'searxng', endpoint: 'https://search2.example.com/search', safeSearch: 'moderate', maxResults: 4, blockedDomains: ['example.net'] },
    });
    expect(reconfiguredSearch.statusCode, reconfiguredSearch.body).toBe(200);
    expect(reconfiguredSearch.json()).toMatchObject({ id: search.json().id, name: 'Web Search · SearXNG', enabled: true });
    const assignedAfterRotation = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}`, headers });
    expect(assignedAfterRotation.statusCode, assignedAfterRotation.body).toBe(200);
    expect(assignedAfterRotation.json().tool_ids).toContain(search.json().id);

    const updatedCatalog = await app.inject({ method: 'GET', url: '/v1/tools/web/catalog', headers });
    expect(updatedCatalog.statusCode, updatedCatalog.body).toBe(200);
    expect(updatedCatalog.json().data).toContainEqual(expect.objectContaining({ id: 'searxng', installed: true }));

    const { query } = await import('../src/db/client.js');
    const stored = await query<{ config: unknown }>('SELECT config FROM tools WHERE id = ANY($1::uuid[]) ORDER BY id', [[search.json().id, reddit.json().id]]);
    const encryptedConfigs = JSON.stringify(stored.rows.map((row) => row.config));
    expect(encryptedConfigs).not.toContain('integration-reddit-secret');
    expect(encryptedConfigs).not.toContain('search2.example.com');
  });

  it('installs a read-only job provider without exposing its credentials', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const catalog = await app.inject({ method: 'GET', url: '/v1/tools/jobs/catalog', headers });
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'adzuna', installed: false })]));
    expect(catalog.body).not.toMatch(/appKey|appId|secret/i);
    const installed = await app.inject({
      method: 'POST', url: '/v1/tools/jobs/install', headers,
      payload: { provider: 'adzuna', appId: 'woody-integration', appKey: 'adzuna-integration-secret', country: 'sg', maxResults: 5 },
    });
    expect(installed.statusCode, installed.body).toBe(201);
    expect(installed.json()).toMatchObject({ name: 'Jobs · Adzuna Search', kind: 'internal', permissions: ['web.read', 'jobs.read'], enabled: true });
    expect(JSON.stringify(installed.json())).not.toMatch(/woody-integration|adzuna-integration-secret/);
    jobToolId = installed.json().id;
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
    expect(catalog.json().data).toHaveLength(14);
    const starter = catalog.json().data.find((item: { slug: string }) => item.slug === 'deep-research-report');
    expect(starter).toBeTruthy();
    const jobStarter = catalog.json().data.find((item: { slug: string }) => item.slug === 'job-opportunity-researcher');
    expect(jobStarter).toMatchObject({ category: 'Tool-ready Agents', agents: [{ toolRequirements: [expect.objectContaining({ key: 'job_search' })] }] });

    const missingJobTool = await app.inject({
      method: 'POST',
      url: '/v1/starter-solutions/job-opportunity-researcher/install',
      headers,
      payload: { allowDuplicate: false, toolIdsByAgentKey: {} },
    });
    expect(missingJobTool.statusCode, missingJobTool.body).toBe(400);
    const installedJobStarter = await app.inject({
      method: 'POST',
      url: '/v1/starter-solutions/job-opportunity-researcher/install',
      headers,
      payload: { allowDuplicate: false, toolIdsByAgentKey: { agent_1: [jobToolId] } },
    });
    expect(installedJobStarter.statusCode, installedJobStarter.body).toBe(201);
    const jobAgentId = installedJobStarter.json().resources.agentIds.agent_1;
    const jobAgent = await app.inject({ method: 'GET', url: `/v1/agents/${jobAgentId}`, headers });
    expect(jobAgent.statusCode, jobAgent.body).toBe(200);
    expect(jobAgent.json()).toMatchObject({ status: 'draft', capabilities: { webBrowser: true }, tool_ids: [jobToolId] });

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

  it('rejects unavailable proposal attachments before invoking the prompt compiler', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent-solutions/compile',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        mode: 'automatic',
        prompt: 'Create a research agent grounded in the attached reference document.',
        attachmentIds: ['00000000-0000-4000-8000-000000000001'],
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ error: 'FILE_ATTACHMENTS_NOT_READY_OR_MISSING' });
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
    const nodeCatalog = await app.inject({ method: 'GET', url: '/v1/workflow-nodes', headers });
    expect(nodeCatalog.statusCode, nodeCatalog.body).toBe(200);
    expect(nodeCatalog.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'agent', available: true, adapter: 'agent' }),
      expect.objectContaining({ type: 'mcp_action', available: true, adapter: 'mcp' }),
      expect.objectContaining({ type: 'knowledge_search', available: true, adapter: 'knowledge' }),
    ]));
    expect(JSON.stringify(nodeCatalog.json())).not.toContain('configSchema');
    const resources = await app.inject({ method: 'GET', url: '/v1/workflow-resources', headers });
    expect(resources.statusCode, resources.body).toBe(200);
    expect(resources.json()).toMatchObject({ version: 1, knowledge: { scope: 'workspace' } });
    expect(resources.json().agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: agentId })]));
    expect(resources.json().apiTools).toEqual(expect.arrayContaining([expect.objectContaining({ id: tool.json().id, name: 'Knowledge API' })]));
    expect(JSON.stringify(resources.json())).not.toMatch(/encrypted_credentials|api.?key|authorization/i);
    const savedLayout = await app.inject({
      method: 'PUT',
      url: `/v1/workflows/${workflow.json().id}/layout`,
      headers,
      payload: { positions: [{ nodeId: 'start', x: 40, y: 120 }, { nodeId: 'finish', x: 420, y: 120 }], viewport: { x: 10, y: 20, zoom: 1.1 } },
    });
    expect(savedLayout.statusCode, savedLayout.body).toBe(200);
    expect(savedLayout.json()).toMatchObject({ workflowId: workflow.json().id, schemaVersion: 1, viewport: { x: 10, y: 20, zoom: 1.1 } });
    const restoredLayout = await app.inject({ method: 'GET', url: `/v1/workflows/${workflow.json().id}/layout`, headers });
    expect(restoredLayout.statusCode, restoredLayout.body).toBe(200);
    expect(restoredLayout.json().positions).toEqual([{ nodeId: 'start', x: 40, y: 120 }, { nodeId: 'finish', x: 420, y: 120 }]);
    const invalidLayout = await app.inject({ method: 'PUT', url: `/v1/workflows/${workflow.json().id}/layout`, headers, payload: { positions: [{ nodeId: 'missing', x: 0, y: 0 }] } });
    expect(invalidLayout.statusCode, invalidLayout.body).toBe(400);
    expect(invalidLayout.json()).toMatchObject({ error: 'INVALID_WORKFLOW_LAYOUT' });
    const prematureRun = await app.inject({ method: 'POST', url: `/v1/workflows/${workflow.json().id}/runs`, headers, payload: { input: { topic: 'agents' } } });
    expect(prematureRun.statusCode, prematureRun.body).toBe(409);
    expect(prematureRun.json()).toMatchObject({ error: 'WORKFLOW_NOT_PUBLISHED' });
    const nodeTest = await app.inject({ method: 'POST', url: `/v1/workflows/${workflow.json().id}/nodes/finish/test-runs`, headers, payload: { input: { topic: 'agents' } } });
    expect(nodeTest.statusCode, nodeTest.body).toBe(202);
    const completedNodeTest = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${nodeTest.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'completed',
    );
    expect(completedNodeTest.json()).toMatchObject({ run_mode: 'test', test_target_node_id: 'finish' });
    const nodeTestIsNotPublishGate = await app.inject({ method: 'POST', url: `/v1/workflows/${workflow.json().id}/publish`, headers });
    expect(nodeTestIsNotPublishGate.statusCode, nodeTestIsNotPublishGate.body).toBe(409);
    const draftTest = await app.inject({ method: 'POST', url: `/v1/workflows/${workflow.json().id}/test-runs`, headers, payload: { input: { topic: 'agents' } } });
    expect(draftTest.statusCode, draftTest.body).toBe(202);
    const completedTest = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${draftTest.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'completed' && response.json().artifacts?.every((item: { status: string }) => item.status === 'ready'),
    );
    expect(completedTest.json()).toMatchObject({ run_mode: 'test', draft_revision: workflow.json().draft_revision });
    const published = await app.inject({ method: 'POST', url: `/v1/workflows/${workflow.json().id}/publish`, headers });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json()).toMatchObject({ status: 'published', enabled: true, published_version: 1 });
    const editedDraft = await app.inject({ method: 'PATCH', url: `/v1/workflows/${workflow.json().id}`, headers, payload: { description: 'A newer untested draft' } });
    expect(editedDraft.statusCode, editedDraft.body).toBe(200);
    expect(editedDraft.json().draft_revision).toBe(workflow.json().draft_revision + 1);
    const untestedPublish = await app.inject({ method: 'POST', url: `/v1/workflows/${workflow.json().id}/publish`, headers });
    expect(untestedPublish.statusCode, untestedPublish.body).toBe(409);
    expect(untestedPublish.json()).toMatchObject({ error: 'WORKFLOW_SUCCESSFUL_TEST_REQUIRED' });
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
    expect(completedWorkflow.json()).toMatchObject({
      run_mode: 'production',
      workflow_version_id: published.json().published_version_id,
      usage: { agentTasks: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    });
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
    const branchRun = await app.inject({ method: 'POST', url: `/v1/workflows/${branchWorkflow.json().id}/test-runs`, headers, payload: { input: { approved: true } } });
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
    const loopRun = await app.inject({ method: 'POST', url: `/v1/workflows/${loopWorkflow.json().id}/test-runs`, headers, payload: { input: { items: ['one', 'two'] } } });
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
    const retryRun = await app.inject({ method: 'POST', url: `/v1/workflows/${retryWorkflow.json().id}/test-runs`, headers, payload: { input: {} } });
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
    const approvalRun = await app.inject({ method: 'POST', url: `/v1/workflows/${approvalWorkflow.json().id}/test-runs`, headers, payload: { input: { subject: 'approval-resume' } } });
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
    const uploadBody = multipartFile('research-notes.md', 'text/markdown', '# Evidence\n\nAgents use bounded document context.', { scope: 'task' });
    const uploadedFile = await app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { ...headers, 'content-type': uploadBody.contentType },
      payload: uploadBody.payload,
    });
    expect(uploadedFile.statusCode, uploadedFile.body).toBe(202);
    const readyFile = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/files/${uploadedFile.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'ready',
    );
    expect(readyFile.json()).not.toHaveProperty('storage_key');
    expect(readyFile.json()).not.toHaveProperty('sha256');
    const previewFile = await app.inject({ method: 'GET', url: `/v1/files/${uploadedFile.json().id}/preview`, headers });
    expect(previewFile.statusCode, previewFile.body).toBe(200);
    expect(previewFile.json().chunks).toEqual(expect.arrayContaining([expect.objectContaining({ locator: 'Document' })]));

    const versionBody = multipartFile('research-notes-v2.md', 'text/markdown', '# Evidence\n\nAgents use bounded context with exact citations.');
    const uploadedVersion = await app.inject({
      method: 'POST',
      url: `/v1/files/${uploadedFile.json().id}/versions`,
      headers: { ...headers, 'content-type': versionBody.contentType },
      payload: versionBody.payload,
    });
    expect(uploadedVersion.statusCode, uploadedVersion.body).toBe(202);
    await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/files/${uploadedVersion.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'ready',
    );
    const versions = await app.inject({ method: 'GET', url: `/v1/files/${uploadedFile.json().id}/versions`, headers });
    expect(versions.statusCode, versions.body).toBe(200);
    expect(versions.json().data.map((item: { version_number: number }) => item.version_number)).toEqual([2, 1]);

    const comparison = await app.inject({
      method: 'POST',
      url: '/v1/files/compare',
      headers,
      payload: { fileIds: [uploadedFile.json().id, uploadedVersion.json().id] },
    });
    expect(comparison.statusCode, comparison.body).toBe(200);
    expect(comparison.json()).toMatchObject({
      files: [{ id: uploadedFile.json().id }, { id: uploadedVersion.json().id }],
      similarityPercent: expect.any(Number),
      method: expect.stringContaining('no document content was sent'),
    });

    const csvBody = multipartFile('metrics.csv', 'text/csv', 'Metric,Value\nRequests,44\nTokens,211700\n', { scope: 'saved' });
    const uploadedCsv = await app.inject({
      method: 'POST',
      url: '/v1/files',
      headers: { ...headers, 'content-type': csvBody.contentType },
      payload: csvBody.payload,
    });
    expect(uploadedCsv.statusCode, uploadedCsv.body).toBe(202);
    await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/files/${uploadedCsv.json().id}`, headers }),
      (response) => response.statusCode === 200 && response.json().status === 'ready',
    );
    const spreadsheet = await app.inject({ method: 'GET', url: `/v1/files/${uploadedCsv.json().id}/spreadsheet?limit=2`, headers });
    expect(spreadsheet.statusCode, spreadsheet.body).toBe(200);
    expect(spreadsheet.json()).toMatchObject({
      sheet: 'CSV',
      rows: [['Metric', 'Value'], ['Requests', '44']],
      rowCount: 3,
      hasMore: true,
    });

    const htmlTemplate = await app.inject({
      method: 'POST',
      url: '/v1/artifact-templates',
      headers,
      payload: {
        name: `Integration HTML ${suffix}`,
        format: 'html',
        isDefault: true,
        designMarkdown: '# HTML\n- Background: #101827\n- Accent: #22D3EE\n- Headings: serif\n- Body font: system',
      },
    });
    expect(htmlTemplate.statusCode, htmlTemplate.body).toBe(201);
    expect(htmlTemplate.json()).toMatchObject({
      format: 'html',
      is_default: true,
      theme: { background: '#101827', accent: '#22D3EE', headingFont: 'serif' },
    });
    expect(JSON.stringify(htmlTemplate.json())).not.toContain('design_markdown');

    const safeOutputWorkflow = await app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers,
      payload: {
        name: `Safe output ${suffix}`,
        definition: {
          nodes: [
            { id: 'start', type: 'trigger' },
            {
              id: 'finish',
              type: 'output',
              config: {
                output: { report: '# Verified result\n\n<script>not executable</script>' },
                artifactFormats: ['html', 'md', 'txt', 'csv', 'json'],
              },
            },
          ],
          edges: [{ source: 'start', target: 'finish' }],
        },
      },
    });
    expect(safeOutputWorkflow.statusCode, safeOutputWorkflow.body).toBe(201);
    const safeOutputRun = await app.inject({
      method: 'POST',
      url: `/v1/workflows/${safeOutputWorkflow.json().id}/test-runs`,
      headers,
      payload: { input: { subject: 'safe artifact integration' } },
    });
    expect(safeOutputRun.statusCode, safeOutputRun.body).toBe(202);
    const completedSafeOutput = await waitFor(
      () => app.inject({ method: 'GET', url: `/v1/workflows/runs/${safeOutputRun.json().id}`, headers }),
      (response) => response.statusCode === 200
        && response.json().status === 'completed'
        && response.json().artifacts?.length === 5
        && response.json().artifacts.every((item: { status: string }) => item.status === 'ready'),
    );
    const htmlArtifact = completedSafeOutput.json().artifacts.find((item: { format: string }) => item.format === 'html');
    const htmlDownload = await fetch(
      `${(process.env.INTEGRATION_API_URL ?? 'http://localhost:3001').replace(/\/$/, '')}/v1/artifacts/${htmlArtifact.id}/download?inline=true`,
      { headers },
    );
    const htmlBody = await htmlDownload.text();
    expect(htmlDownload.status, htmlBody.slice(0, 500)).toBe(200);
    expect(htmlDownload.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(htmlDownload.headers.get('content-type')).toContain('text/html');
    expect(htmlBody).toContain('--bg:#101827');
    expect(htmlBody).not.toContain('<script>');

    const thread = await app.inject({ method: 'POST', url: '/v1/copilot/threads', headers, payload: { title: 'Persistent file chat' } });
    expect(thread.statusCode, thread.body).toBe(201);
    const restoredThread = await app.inject({ method: 'GET', url: `/v1/copilot/threads/${thread.json().id}`, headers });
    expect(restoredThread.statusCode, restoredThread.body).toBe(200);
    expect(restoredThread.json()).toMatchObject({ id: thread.json().id, title: 'Persistent file chat', messages: [] });

    const isolatedRegistration = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `isolated-${suffix}@example.test`,
        password,
        displayName: 'Isolated User',
        workspaceName: `Isolated ${suffix}`,
      },
    });
    const isolatedHeaders = { authorization: `Bearer ${isolatedRegistration.json().accessToken}` };
    const isolatedRead = await app.inject({ method: 'GET', url: `/v1/files/${uploadedFile.json().id}`, headers: isolatedHeaders });
    expect(isolatedRead.statusCode, isolatedRead.body).toBe(404);
    const isolatedCompare = await app.inject({
      method: 'POST',
      url: '/v1/files/compare',
      headers: isolatedHeaders,
      payload: { fileIds: [uploadedFile.json().id, uploadedVersion.json().id] },
    });
    expect(isolatedCompare.statusCode, isolatedCompare.body).toBe(404);

    const task = await app.inject({ method: 'POST', url: '/v1/tasks', headers, payload: { agentId, title: 'Research current market', input: { topic: 'agent platforms' }, artifactFormats: ['pdf', 'html'], attachmentIds: [uploadedFile.json().id] } });
    expect(task.statusCode, task.body).toBe(202);
    const taskWithArtifact = await app.inject({ method: 'GET', url: `/v1/tasks/${task.json().id}`, headers });
    expect(taskWithArtifact.statusCode, taskWithArtifact.body).toBe(200);
    expect(taskWithArtifact.json().artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ format: 'pdf', status: 'pending' }), expect.objectContaining({ format: 'html', status: 'pending' })]));
    expect(taskWithArtifact.json().attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: uploadedFile.json().id, original_name: 'research-notes.md', status: 'ready' })]));
    const taskIndex = await app.inject({ method: 'GET', url: '/v1/tasks', headers });
    expect(taskIndex.statusCode, taskIndex.body).toBe(200);
    expect(taskIndex.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: task.json().id,
        workflow_name: null,
        artifact_summary: expect.arrayContaining([expect.objectContaining({ format: 'pdf', status: 'pending' })]),
      }),
    ]));
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
    const rangedAnalytics = await app.inject({ method: 'GET', url: '/v1/analytics/overview?days=7', headers });
    expect(rangedAnalytics.statusCode, rangedAnalytics.body).toBe(200);
    expect(rangedAnalytics.json()).toMatchObject({ range: { days: 7, timezone: 'UTC' } });
    expect(rangedAnalytics.json().daily).toEqual(expect.any(Array));
    expect(rangedAnalytics.json().agent_effectiveness).toEqual(expect.arrayContaining([expect.objectContaining({ agent_id: agentId })]));
  }, 30_000);

  it('versions a completed task output without mutating the original run evidence', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
    expect(me.statusCode, me.body).toBe(200);
    const { query } = await import('../src/db/client.js');
    const task = (await query<{ id: string }>(
      `INSERT INTO tasks(workspace_id,agent_id,title,input,output,status,requested_by,completed_at)
       VALUES($1,$2,$3,'{}'::jsonb,$4,'completed',$5,now()) RETURNING id`,
      [me.json().workspace_id, agentId, 'Editable output integration', JSON.stringify({ text: '# Original result', toolCallCount: 0 }), me.json().id],
    )).rows[0];
    const original = (await query<{ output: unknown }>('SELECT output FROM tasks WHERE id=$1', [task.id])).rows[0].output;
    const {
      getTaskOutputDocument,
      initializeTaskOutputDocument,
      revertOutputVersion,
      saveOutputVersion,
    } = await import('../src/outputs/service.js');

    const initialized = await initializeTaskOutputDocument({
      workspaceId: me.json().workspace_id,
      taskId: task.id,
      actorId: me.json().id,
    });
    expect(initialized.currentVersion).toMatchObject({ version_number: 1, content: '# Original result' });
    expect((await getTaskOutputDocument(me.json().workspace_id, task.id))?.id).toBe(initialized.id);
    expect((await initializeTaskOutputDocument({
      workspaceId: me.json().workspace_id,
      taskId: task.id,
      actorId: me.json().id,
    })).id).toBe(initialized.id);

    const saved = await saveOutputVersion({
      workspaceId: me.json().workspace_id,
      documentId: initialized.id,
      actorId: me.json().id,
      content: '# Human revision',
      baseVersionNumber: 1,
    });
    expect(saved.currentVersion).toMatchObject({ version_number: 2, content: '# Human revision' });
    await expect(saveOutputVersion({
      workspaceId: me.json().workspace_id,
      documentId: initialized.id,
      actorId: me.json().id,
      content: '# Stale edit',
      baseVersionNumber: 1,
    })).rejects.toThrow('OUTPUT_VERSION_CONFLICT');

    const reverted = await revertOutputVersion({
      workspaceId: me.json().workspace_id,
      documentId: initialized.id,
      actorId: me.json().id,
      versionId: initialized.currentVersion.id,
      baseVersionNumber: 2,
    });
    expect(reverted.currentVersion).toMatchObject({ version_number: 3, content: '# Original result' });
    const fetched = await app.inject({
      method: 'GET',
      url: `/v1/output-documents/tasks/${task.id}`,
      headers,
    });
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.json().document).toMatchObject({ id: initialized.id, current_version_number: 3 });
    const routeSaved = await app.inject({
      method: 'POST',
      url: `/v1/output-documents/${initialized.id}/versions`,
      headers,
      payload: { content: '# Saved through the API', baseVersionNumber: 3 },
    });
    expect(routeSaved.statusCode, routeSaved.body).toBe(201);
    expect(routeSaved.json().currentVersion).toMatchObject({ version_number: 4, content: '# Saved through the API' });
    const olderArtifacts = await app.inject({
      method: 'POST',
      url: `/v1/output-documents/${initialized.id}/artifacts`,
      headers,
      payload: { versionId: reverted.currentVersion.id, formats: ['md'] },
    });
    expect(olderArtifacts.statusCode, olderArtifacts.body).toBe(202);
    const currentArtifacts = await app.inject({
      method: 'POST',
      url: `/v1/output-documents/${initialized.id}/artifacts`,
      headers,
      payload: { versionId: routeSaved.json().currentVersion.id, formats: ['md', 'html'] },
    });
    expect(currentArtifacts.statusCode, currentArtifacts.body).toBe(202);
    expect(currentArtifacts.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ format: 'md', output_document_version_id: routeSaved.json().currentVersion.id }),
      expect.objectContaining({ format: 'html', output_document_version_id: routeSaved.json().currentVersion.id }),
    ]));
    const versionedArtifacts = await query<{ id: string; format: string; output_document_version_id: string }>(
      `SELECT id,format,output_document_version_id FROM artifacts
        WHERE task_id=$1 AND output_document_version_id IS NOT NULL`,
      [task.id],
    );
    expect(versionedArtifacts.rows.filter((artifact) => artifact.format === 'md')).toHaveLength(2);

    const isolated = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `editable-isolated-${suffix}@example.test`,
        password,
        displayName: 'Isolated Editor',
        workspaceName: `Editable Isolated ${suffix}`,
      },
    });
    expect(isolated.statusCode, isolated.body).toBe(201);
    const crossWorkspace = await app.inject({
      method: 'POST',
      url: `/v1/output-documents/${initialized.id}/versions`,
      headers: { authorization: `Bearer ${isolated.json().accessToken}` },
      payload: { content: '# Unauthorized edit', baseVersionNumber: 4 },
    });
    expect(crossWorkspace.statusCode, crossWorkspace.body).toBe(404);
    expect(crossWorkspace.json()).toMatchObject({ error: 'OUTPUT_DOCUMENT_NOT_FOUND' });
    expect((await query<{ output: unknown }>('SELECT output FROM tasks WHERE id=$1', [task.id])).rows[0].output).toEqual(original);
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
