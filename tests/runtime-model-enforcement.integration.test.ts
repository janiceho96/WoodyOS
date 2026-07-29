import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { publishAgent } from '../src/agents/versions.js';
import { query } from '../src/db/client.js';

const enabled = process.env.RUN_INTEGRATION === 'true';

describe.runIf(enabled)('runtime provider model enforcement', () => {
  let app: Awaited<ReturnType<(typeof import('../src/server.js'))['buildApp']>>;
  const createdWorkspaces: string[] = [];
  const createdUsers: string[] = [];

  type WorkspaceFixture = {
    activeAgentId: string;
    draftAgentId: string;
    headers: { authorization: string };
    userId: string;
    workspaceId: string;
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const { buildApp } = await import('../src/server.js');
    app = await buildApp();
  });

  afterEach(async () => {
    await Promise.all(createdWorkspaces.splice(0).map((workspaceId) => query('DELETE FROM workspaces WHERE id=$1', [workspaceId])));
    await Promise.all(createdUsers.splice(0).map((userId) => query('DELETE FROM users WHERE id=$1', [userId])));
  });

  afterAll(async () => {
    await app.close();
  });

  async function createFixture(model: string): Promise<WorkspaceFixture> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspaceId = (await query<{ id: string }>(
      'INSERT INTO workspaces(name) VALUES($1) RETURNING id',
      [`Runtime enforcement ${suffix}`],
    )).rows[0].id;
    const userId = (await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,display_name)
       VALUES($1,'test-hash','Runtime enforcement') RETURNING id`,
      [`runtime-enforcement-${suffix}@example.test`],
    )).rows[0].id;
    createdWorkspaces.push(workspaceId);
    createdUsers.push(userId);
    await query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [workspaceId, userId],
    );

    const createAgent = async (name: string, status: 'active' | 'draft') => (await query<{ id: string }>(
      `INSERT INTO agents(
         workspace_id,name,role,goal,instructions,personality,model,status,tool_ids,
         memory_config,model_config,capabilities,avatar_config,created_by
       ) VALUES($1,$2,'Researcher','Find evidence','Original',NULL,$3,$4,
         '[]','{"knowledgeBase":true}','{"temperature":0.2,"maxTokens":4096,"topP":1}',
         '{"webBrowser":false,"codeInterpreter":false,"knowledgeBase":true}',
         '{"type":"initials","value":"R"}',$5)
       RETURNING id`,
      [workspaceId, name, model, status, userId],
    )).rows[0].id;

    const draftAgentId = await createAgent('Draft model agent', 'draft');
    const activeAgentId = await createAgent('Published model agent', 'active');
    await publishAgent({ workspaceId, agentId: activeAgentId, actorId: userId });

    return {
      activeAgentId,
      draftAgentId,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: userId, workspaceId, role: 'owner' })}` },
      userId,
      workspaceId,
    };
  }

  it('updates provider configuration and workspace agents atomically without exposing credentials', async () => {
    const fixture = await createFixture('model-before-enforcement');

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/runtime/config',
      headers: fixture.headers,
      payload: {
        provider: 'openai-compatible',
        defaultModel: 'model-after-enforcement',
        baseUrl: 'https://example.com/v1',
        apiKey: 'test-compatible-key',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().modelEnforcement).toEqual({ agentsUpdated: 2, versionsPublished: 1 });
    expect(JSON.stringify(response.json())).not.toContain('test-compatible-key');
    expect(JSON.stringify(response.json())).not.toContain('encrypted_api_key');
    expect((await query<{ provider: string; default_model: string }>(
      'SELECT provider,default_model FROM workspace_ai_provider_configs WHERE workspace_id=$1',
      [fixture.workspaceId],
    )).rows).toEqual([{ provider: 'openai-compatible', default_model: 'model-after-enforcement' }]);
    expect((await query<{ model: string }>(
      'SELECT model FROM agents WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[fixture.activeAgentId, fixture.draftAgentId]],
    )).rows).toEqual([{ model: 'model-after-enforcement' }, { model: 'model-after-enforcement' }]);
    expect((await query<{ version: number; model: string }>(
      "SELECT version,snapshot->>'model' AS model FROM agent_versions WHERE agent_id=$1 ORDER BY version",
      [fixture.activeAgentId],
    )).rows).toEqual([
      { version: 1, model: 'model-before-enforcement' },
      { version: 2, model: 'model-after-enforcement' },
    ]);
    expect((await query<{ metadata: { modelEnforcement: unknown } }>(
      "SELECT metadata FROM audit_events WHERE workspace_id=$1 AND action='runtime.provider.updated' ORDER BY created_at DESC LIMIT 1",
      [fixture.workspaceId],
    )).rows[0].metadata.modelEnforcement).toEqual({ agentsUpdated: 2, versionsPublished: 1 });

    const unchanged = await app.inject({
      method: 'PUT',
      url: '/v1/runtime/config',
      headers: fixture.headers,
      payload: {
        provider: 'openai-compatible',
        defaultModel: 'model-after-enforcement',
        baseUrl: 'https://example.com/v1',
      },
    });

    expect(unchanged.statusCode, unchanged.body).toBe(200);
    expect(unchanged.json().modelEnforcement).toEqual({ agentsUpdated: 0, versionsPublished: 0 });
  });

  it('rolls back provider configuration and agent models when publishing replacement versions fails', async () => {
    const fixture = await createFixture('model-before-failure');
    const baseline = await app.inject({
      method: 'PUT',
      url: '/v1/runtime/config',
      headers: fixture.headers,
      payload: {
        provider: 'openai-compatible',
        defaultModel: 'model-before-failure',
        baseUrl: 'https://example.com/v1',
        apiKey: 'test-compatible-key',
      },
    });
    expect(baseline.statusCode, baseline.body).toBe(200);

    const suffix = fixture.workspaceId.replaceAll('-', '');
    const functionName = `runtime_enforcement_failure_${suffix}`;
    const triggerName = `runtime_enforcement_failure_trigger_${suffix}`;
    await query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.workspace_id = '${fixture.workspaceId}'::uuid THEN
           RAISE EXCEPTION 'replacement version failure';
         END IF;
         RETURN NEW;
       END;
       $$`,
    );
    await query(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON agent_versions
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );

    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/v1/runtime/config',
        headers: fixture.headers,
        payload: {
          provider: 'openai-compatible',
          defaultModel: 'model-after-failure',
          baseUrl: 'https://example.com/v1',
        },
      });

      expect(response.statusCode, response.body).toBe(500);
      expect(response.json()).toMatchObject({ error: 'INTERNAL_ERROR' });
      expect((await query<{ default_model: string }>(
        'SELECT default_model FROM workspace_ai_provider_configs WHERE workspace_id=$1',
        [fixture.workspaceId],
      )).rows).toEqual([{ default_model: 'model-before-failure' }]);
      expect((await query<{ model: string }>(
        'SELECT model FROM agents WHERE id=ANY($1::uuid[]) ORDER BY id',
        [[fixture.activeAgentId, fixture.draftAgentId]],
      )).rows).toEqual([{ model: 'model-before-failure' }, { model: 'model-before-failure' }]);
      expect((await query<{ version: number }>(
        'SELECT version FROM agent_versions WHERE agent_id=$1 ORDER BY version',
        [fixture.activeAgentId],
      )).rows).toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${triggerName} ON agent_versions`);
      await query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });
});
