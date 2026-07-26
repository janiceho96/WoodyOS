import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildWorkflowManifest,
  canonicalJsonHash,
  validateManifestCompatibility,
  type ExecutionManifest,
} from '../src/runtime/manifest.js';
import { query } from '../src/db/client.js';
import { publishAgent } from '../src/agents/versions.js';

function exactManifest(): ExecutionManifest {
  return {
    manifestVersion: 1,
    createdAt: '2026-07-26T00:00:00.000Z',
    compatibility: 'exact',
    agents: {},
    prompts: {},
    models: {},
    apiTools: {},
    mcpActions: {},
    policy: { version: '1' },
    adapters: {},
    outputContracts: {},
    artifactTemplates: {},
    runtime: { version: '0.1.0', stateSchemaVersion: 1 },
  };
}

describe('execution manifest compatibility', () => {
  it('hashes canonical JSON independently of object key insertion order', () => {
    expect(canonicalJsonHash({ first: 1, nested: { left: true, right: false } }))
      .toBe(canonicalJsonHash({ nested: { right: false, left: true }, first: 1 }));
    expect(canonicalJsonHash({ first: 2 })).not.toBe(canonicalJsonHash({ first: 1 }));
    expect(canonicalJsonHash({ first: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts an exact supported manifest and rejects legacy or malformed resumes', () => {
    expect(validateManifestCompatibility(exactManifest())).toEqual({ ok: true, reasons: [] });
    expect(validateManifestCompatibility({ ...exactManifest(), compatibility: 'legacy_partial' })).toEqual({
      ok: false,
      reasons: ['Execution manifest is a legacy partial snapshot'],
    });
    expect(validateManifestCompatibility({ manifestVersion: 99, compatibility: 'exact' })).toMatchObject({
      ok: false,
      reasons: expect.arrayContaining(['Unsupported manifest version 99']),
    });
    expect(validateManifestCompatibility({
      ...exactManifest(),
      runtime: { version: '0.1.0', stateSchemaVersion: 2 },
    })).toMatchObject({
      ok: false,
      reasons: ['Unsupported runtime state schema 2'],
    });
    expect(validateManifestCompatibility(null)).toEqual({
      ok: false,
      reasons: ['Execution manifest is missing'],
    });
  });

  it('never treats credentials as a valid manifest field', () => {
    expect(validateManifestCompatibility({
      ...exactManifest(),
      credentials: { apiKey: 'must-not-be-stored' },
    })).toEqual({
      ok: false,
      reasons: ['Execution manifest contains forbidden sensitive fields'],
    });
  });
});

const integrationEnabled = process.env.RUN_INTEGRATION === 'true';

describe.runIf(integrationEnabled)('database-backed execution manifests', () => {
  let workspaceId = '';
  let actorId = '';
  let agentId = '';
  let agentVersionId = '';
  let workflowVersionId = '';
  let apiToolId = '';
  let mcpToolId = '';
  let definition: {
    nodes: Array<{ id: string; type: 'trigger' | 'agent' | 'api_action' | 'mcp_action' | 'output'; config: Record<string, unknown> }>;
    edges: Array<{ source: string; target: string }>;
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    workspaceId = (await query<{ id: string }>(
      'INSERT INTO workspaces(name) VALUES($1) RETURNING id',
      [`Manifest workspace ${suffix}`],
    )).rows[0].id;
    actorId = (await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,display_name)
       VALUES($1,'test-hash','Manifest test') RETURNING id`,
      [`manifest-${suffix}@example.test`],
    )).rows[0].id;
    await query(
      "INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [workspaceId, actorId],
    );
    const { encryptJson } = await import('../src/lib/crypto.js');
    apiToolId = (await query<{ id: string }>(
      `INSERT INTO tools(workspace_id,name,kind,description,config,permissions,enabled)
       VALUES($1,'Manifest API','api','', $2,$3,true) RETURNING id`,
      [
        workspaceId,
        JSON.stringify(encryptJson({
          endpoint: 'https://example.test/api',
          method: 'POST',
          headers: { authorization: 'must-not-leak' },
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        })),
        JSON.stringify(['records.read']),
      ],
    )).rows[0].id;
    agentId = (await query<{ id: string }>(
      `INSERT INTO agents(
         workspace_id,name,role,goal,instructions,model,status,tool_ids,created_by
       ) VALUES($1,'Manifest agent','Researcher','Find evidence','Use tools','model-a','active',$2,$3)
       RETURNING id`,
      [workspaceId, JSON.stringify([apiToolId]), actorId],
    )).rows[0].id;
    agentVersionId = (await publishAgent({ workspaceId, agentId, actorId })).id;
    const connectionId = (await query<{ id: string }>(
      `INSERT INTO mcp_connections(
         workspace_id,name,transport,endpoint_url,auth_type,enabled,health_status,installed_by
       ) VALUES($1,'Manifest MCP','streamable-http','https://example.test/mcp','none',true,'healthy',$2)
       RETURNING id`,
      [workspaceId, actorId],
    )).rows[0].id;
    mcpToolId = (await query<{ id: string }>(
      `INSERT INTO mcp_connection_tools(
         connection_id,remote_name,input_schema,risk_level,enabled,schema_hash
       ) VALUES($1,'lookup',$2,'read',true,$3) RETURNING id`,
      [
        connectionId,
        JSON.stringify({ type: 'object', properties: { id: { type: 'string' } } }),
        canonicalJsonHash({ type: 'object', properties: { id: { type: 'string' } } }),
      ],
    )).rows[0].id;
    await query(
      `INSERT INTO mcp_agent_access(agent_id,connection_id,permission_level,enabled,assigned_by)
       VALUES($1,$2,'read',true,$3)`,
      [agentId, connectionId, actorId],
    );
    await query(
      `INSERT INTO mcp_agent_tool_access(agent_id,mcp_tool_id,permission_level,enabled,assigned_by)
       VALUES($1,$2,'read',true,$3)`,
      [agentId, mcpToolId, actorId],
    );
    definition = {
      nodes: [
        { id: 'start', type: 'trigger', config: {} },
        { id: 'research', type: 'agent', config: { agentId } },
        { id: 'api', type: 'api_action', config: { toolId: apiToolId } },
        { id: 'mcp', type: 'mcp_action', config: { agentId, mcpToolId } },
        { id: 'finish', type: 'output', config: {} },
      ],
      edges: [
        { source: 'start', target: 'research' },
        { source: 'research', target: 'api' },
        { source: 'api', target: 'mcp' },
        { source: 'mcp', target: 'finish' },
      ],
    };
    const workflowId = (await query<{ id: string }>(
      `INSERT INTO workflows(workspace_id,name,definition,created_by)
       VALUES($1,'Manifest workflow',$2,$3) RETURNING id`,
      [workspaceId, JSON.stringify(definition), actorId],
    )).rows[0].id;
    workflowVersionId = (await query<{ id: string }>(
      `INSERT INTO workflow_versions(
         workspace_id,workflow_id,version,name,definition,published_by
       ) VALUES($1,$2,1,'Manifest workflow',$3,$4) RETURNING id`,
      [workspaceId, workflowId, JSON.stringify(definition), actorId],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (workspaceId) await query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    if (actorId) await query('DELETE FROM users WHERE id=$1', [actorId]);
  });

  it('freezes every production workflow dependency without credentials', async () => {
    const manifest = await buildWorkflowManifest({ workspaceId, workflowVersionId, definition });

    expect(manifest).toMatchObject({
      manifestVersion: 1,
      compatibility: 'exact',
      workflow: { versionId: workflowVersionId },
      runtime: { version: expect.any(String), stateSchemaVersion: 1 },
    });
    expect(manifest.agents[agentId].versionId).toBe(agentVersionId);
    expect(manifest.apiTools[apiToolId].schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.mcpActions[mcpToolId].schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain('must-not-leak');
    expect(validateManifestCompatibility(manifest)).toEqual({ ok: true, reasons: [] });
  });

  it('rejects production execution when an agent node has no published version', async () => {
    const unpublishedAgentId = (await query<{ id: string }>(
      `INSERT INTO agents(workspace_id,name,role,goal,model,status,created_by)
       VALUES($1,'Unpublished agent','Writer','Draft','model-a','active',$2) RETURNING id`,
      [workspaceId, actorId],
    )).rows[0].id;
    const draftDefinition = {
      nodes: [
        { id: 'start', type: 'trigger' as const, config: {} },
        { id: 'draft', type: 'agent' as const, config: { agentId: unpublishedAgentId } },
        { id: 'finish', type: 'output' as const, config: {} },
      ],
      edges: [{ source: 'start', target: 'draft' }, { source: 'draft', target: 'finish' }],
    };
    const workflowId = (await query<{ id: string }>(
      `INSERT INTO workflows(workspace_id,name,definition,created_by)
       VALUES($1,'Draft manifest workflow',$2,$3) RETURNING id`,
      [workspaceId, JSON.stringify(draftDefinition), actorId],
    )).rows[0].id;
    const versionId = (await query<{ id: string }>(
      `INSERT INTO workflow_versions(workspace_id,workflow_id,version,name,definition,published_by)
       VALUES($1,$2,1,'Draft manifest workflow',$3,$4) RETURNING id`,
      [workspaceId, workflowId, JSON.stringify(draftDefinition), actorId],
    )).rows[0].id;

    await expect(buildWorkflowManifest({
      workspaceId,
      workflowVersionId: versionId,
      definition: draftDefinition,
    })).rejects.toMatchObject({ code: 'AGENT_VERSION_REQUIRED' });
  });
});
