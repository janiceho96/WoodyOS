import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db/client.js';
import { getAgentVersion, publishAgent, resolvePublishedAgentVersion } from '../src/agents/versions.js';

const enabled = process.env.RUN_INTEGRATION === 'true';

describe.runIf(enabled)('immutable agent versions', () => {
  let workspaceId = '';
  let actorId = '';
  let agentId = '';

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    workspaceId = (await query<{ id: string }>(
      'INSERT INTO workspaces(name) VALUES($1) RETURNING id',
      [`Agent version test ${suffix}`],
    )).rows[0].id;
    actorId = (await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,display_name)
       VALUES($1,'test-hash','Agent version test') RETURNING id`,
      [`agent-version-${suffix}@example.test`],
    )).rows[0].id;
    await query(
      'INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)',
      [workspaceId, actorId, 'owner'],
    );
    agentId = (await query<{ id: string }>(
      `INSERT INTO agents(
         workspace_id,name,role,goal,instructions,personality,model,status,tool_ids,
         memory_config,model_config,capabilities,avatar_config,created_by
       ) VALUES($1,'Publisher','Researcher','Find evidence','Original',NULL,'model-a','active',
         '[]','{"knowledgeBase":true}','{"temperature":0.2,"maxTokens":4096,"topP":1}',
         '{"webBrowser":false,"codeInterpreter":false,"knowledgeBase":true}',
         '{"type":"initials","value":"P"}',$2)
       RETURNING id`,
      [workspaceId, actorId],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (workspaceId) await query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    if (actorId) await query('DELETE FROM users WHERE id=$1', [actorId]);
  });

  it('publishes immutable sequential agent versions', async () => {
    const first = await publishAgent({ workspaceId, agentId, actorId });
    await query('UPDATE agents SET instructions=$1 WHERE id=$2 AND workspace_id=$3', ['Changed', agentId, workspaceId]);
    const second = await publishAgent({ workspaceId, agentId, actorId });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(first.snapshot.instructions).toBe('Original');
    expect(second.snapshot.instructions).toBe('Changed');
  });

  it('does not mutate a published snapshot when the draft changes', async () => {
    const published = await resolvePublishedAgentVersion(workspaceId, agentId);
    await query('UPDATE agents SET model=$1 WHERE id=$2 AND workspace_id=$3', ['different-model', agentId, workspaceId]);
    const stored = await getAgentVersion(workspaceId, published.id);

    expect(stored.snapshot.model).toBe(published.snapshot.model);
  });

  it('keeps published versions inside their workspace boundary', async () => {
    const otherWorkspaceId = (await query<{ id: string }>(
      "INSERT INTO workspaces(name) VALUES('Other version tenant') RETURNING id",
    )).rows[0].id;
    const published = await resolvePublishedAgentVersion(workspaceId, agentId);
    await expect(getAgentVersion(otherWorkspaceId, published.id))
      .rejects.toMatchObject({ code: 'AGENT_VERSION_NOT_FOUND' });
    await query('DELETE FROM workspaces WHERE id=$1', [otherWorkspaceId]);
  });
});
