import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertManifestDependenciesMatch,
  assertTaskManifestDependencies,
  assertWorkflowManifestDependencies,
  buildWorkflowDependencySnapshot,
  buildWorkflowManifest,
  canonicalJsonHash,
  validateManifestCompatibility,
  type ExecutionManifest,
} from '../src/runtime/manifest.js';
import { query } from '../src/db/client.js';
import { publishAgent } from '../src/agents/versions.js';
import { encryptJson } from '../src/lib/crypto.js';

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

  it('rejects malformed nested entries in an otherwise exact manifest', () => {
    const agentId = '00000000-0000-4000-8000-000000000001';
    expect(validateManifestCompatibility({
      ...exactManifest(),
      agents: { [agentId]: {} },
    })).toMatchObject({ ok: false });
    expect(validateManifestCompatibility({
      ...exactManifest(),
      adapters: { node: 1 },
    })).toMatchObject({ ok: false });
    expect(validateManifestCompatibility({
      ...exactManifest(),
      outputContracts: { node: null },
    })).toMatchObject({ ok: false });
    expect(validateManifestCompatibility({
      ...exactManifest(),
      unexpected: 'field',
    })).toMatchObject({ ok: false });
  });

  it('fails closed when any executable dependency descriptor drifts', () => {
    const agentId = '00000000-0000-4000-8000-000000000001';
    const toolId = '00000000-0000-4000-8000-000000000002';
    const connectionId = '00000000-0000-4000-8000-000000000003';
    const hash = canonicalJsonHash('original');
    const baseline: ExecutionManifest = {
      ...exactManifest(),
      agents: { [agentId]: { versionId: agentId, version: 1, snapshotHash: hash } },
      models: { [agentId]: { provider: 'anthropic', model: 'model-a', parametersHash: hash } },
      apiTools: { [toolId]: { toolId, schemaHash: hash, permissionHash: hash } },
      mcpActions: { [toolId]: { connectionId, toolId, schemaHash: hash, permissionHash: hash } },
      adapters: { node: 'api:1' },
      outputContracts: { node: hash },
    };
    const changedHash = canonicalJsonHash('changed');
    const drifted = [
      { ...baseline, agents: { [agentId]: { ...baseline.agents[agentId], snapshotHash: changedHash } } },
      { ...baseline, models: { [agentId]: { ...baseline.models[agentId], provider: 'openai-compatible' } } },
      { ...baseline, models: { [agentId]: { ...baseline.models[agentId], parametersHash: changedHash } } },
      { ...baseline, apiTools: { [toolId]: { ...baseline.apiTools[toolId], schemaHash: changedHash } } },
      { ...baseline, apiTools: { [toolId]: { ...baseline.apiTools[toolId], permissionHash: changedHash } } },
      { ...baseline, mcpActions: { [toolId]: { ...baseline.mcpActions[toolId], schemaHash: changedHash } } },
      { ...baseline, mcpActions: { [toolId]: { ...baseline.mcpActions[toolId], permissionHash: changedHash } } },
      { ...baseline, adapters: { node: 'api:2' } },
      { ...baseline, outputContracts: { node: changedHash } },
      { ...baseline, runtime: { version: '0.2.0', stateSchemaVersion: 1 as const } },
    ];

    for (const current of drifted) {
      expect(() => assertManifestDependenciesMatch(baseline, current))
        .toThrow(expect.objectContaining({ code: 'RUN_MANIFEST_INCOMPATIBLE', retryable: false }));
    }
    expect(() => assertManifestDependenciesMatch(
      baseline,
      { ...baseline, createdAt: '2026-07-27T00:00:00.000Z' },
    )).not.toThrow();
  });

  it('enforces task and workflow manifest semantics before querying live dependencies', async () => {
    const noQueries = {
      query: async () => {
        throw new Error('Malformed manifests must fail before database access');
      },
    };
    await expect(assertTaskManifestDependencies({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      agentId: '00000000-0000-4000-8000-000000000002',
      manifest: { ...exactManifest(), agents: {} },
    }, noQueries)).rejects.toMatchObject({ code: 'RUN_MANIFEST_INCOMPATIBLE', retryable: false });
    await expect(assertWorkflowManifestDependencies({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      workflowVersionId: '00000000-0000-4000-8000-000000000003',
      definition: { nodes: [], edges: [] },
      manifest: exactManifest(),
    }, noQueries)).rejects.toMatchObject({ code: 'RUN_MANIFEST_INCOMPATIBLE', retryable: false });
  });

  it('builds dry-run dependencies with the exact sorted production identities', async () => {
    // Break caught: preview hashing a partial or differently canonicalized dependency set.
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const workspaceId = '00000000-0000-4000-8000-000000000100';
    const agentA = '00000000-0000-4000-8000-000000000101';
    const agentB = '00000000-0000-4000-8000-000000000102';
    const explicitTool = '00000000-0000-4000-8000-000000000103';
    const inheritedTool = '00000000-0000-4000-8000-000000000104';
    const mcpTool = '00000000-0000-4000-8000-000000000105';
    const connectionId = '00000000-0000-4000-8000-000000000106';
    const promptVersion = '00000000-0000-4000-8000-000000000107';
    const artifactTemplate = '00000000-0000-4000-8000-000000000108';
    const snapshotA = { name: 'Agent A', role: 'Writer', goal: 'Write', instructions: 'Carefully', personality: null, model: 'model-a', modelConfig: { temperature: 0.2 }, capabilities: {}, apiToolIds: [inheritedTool], memoryConfig: {}, avatarIdentity: {} };
    const snapshotB = { name: 'Agent B', role: 'Reviewer', goal: 'Review', instructions: 'Strictly', personality: null, model: 'model-b', modelConfig: { temperature: 0.1 }, capabilities: {}, apiToolIds: [], memoryConfig: {}, avatarIdentity: {} };
    const toolRows = [
      { id: inheritedTool, kind: 'plugin', config: encryptJson({ endpoint: 'https://api.test/fallback', readOnly: true }), permissions: ['zeta', 'alpha'] },
      { id: explicitTool, kind: 'api', config: encryptJson({ endpoint: 'https://api.test/search', method: 'post', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }), permissions: ['records.write', 'records.read'] },
    ];
    const definition = {
      nodes: [
        { id: 'start', type: 'trigger' as const, config: {} },
        { id: 'writer', type: 'agent' as const, config: { agentId: agentA, promptVersionId: promptVersion, outputContract: 'grader' } },
        { id: 'reviewer', type: 'agent' as const, config: { agentId: agentB } },
        { id: 'call_api', type: 'api_action' as const, config: { toolId: explicitTool } },
        { id: 'call_mcp', type: 'mcp_action' as const, config: { agentId: agentA, mcpToolId: mcpTool } },
        { id: 'finish', type: 'output' as const, config: { fromNodeId: 'writer', artifactFormats: ['xlsx', 'pdf'], artifactTemplateId: artifactTemplate } },
      ],
      edges: [
        { source: 'start', target: 'writer' },
        { source: 'writer', target: 'reviewer' },
        { source: 'reviewer', target: 'call_api' },
        { source: 'call_api', target: 'call_mcp' },
        { source: 'call_mcp', target: 'finish' },
      ],
    };
    const client = {
      query: async (sql: string) => {
        if (sql.includes('FROM agents agent')) return { rows: [
          { id: agentB, agent_id: agentB, version: 2, snapshot: snapshotB },
          { id: agentA, agent_id: agentA, version: 3, snapshot: snapshotA },
        ] };
        if (sql.includes('FROM tools')) return { rows: toolRows };
        if (sql.includes('FROM mcp_connection_tools')) return { rows: [
          { id: mcpTool, agent_id: agentB, connection_id: connectionId, remote_name: 'lookup', input_schema: { type: 'object', properties: { id: { type: 'string' } } }, transport: 'streamable-http', endpoint_url: 'https://mcp.test/rpc', risk_level: 'write', connection_permission: 'read_write', tool_permission: 'read' },
          { id: mcpTool, agent_id: agentA, connection_id: connectionId, remote_name: 'lookup', input_schema: { type: 'object', properties: { id: { type: 'string' } } }, transport: 'streamable-http', endpoint_url: 'https://mcp.test/rpc', risk_level: 'write', connection_permission: 'read', tool_permission: 'read_write' },
        ] };
        if (sql.includes('FROM prompt_versions')) return { rows: [{ id: promptVersion, content: 'Use {{topic}}', variables: [{ name: 'topic' }] }] };
        if (sql.includes('FROM artifact_templates')) return { rows: [{ id: artifactTemplate, format: 'pdf', design_markdown: '# Report', theme: { accent: 'blue' } }] };
        if (sql.includes('FROM workspace_ai_provider_configs')) return { rows: [{ provider: 'openai-compatible', base_url: 'https://provider.test/v1', default_model: 'default-model' }] };
        throw new Error(`Unexpected dependency query: ${sql}`);
      },
    };

    const dependencies = await buildWorkflowDependencySnapshot({ workspaceId, definition }, client);

    expect(dependencies).toEqual({
      agents: {
        [agentA]: { versionId: agentA, version: 3, snapshotHash: '965ec2f48e1ddfbebc2eacbcc2db76caba432ab145a5179a4bc71ec01eb5b1c2' },
        [agentB]: { versionId: agentB, version: 2, snapshotHash: '5d8b19901fd37dd62a1633891cf9a0ef51b80a2eb71eac55ffbd406f3c3fa526' },
      },
      prompts: { [promptVersion]: { versionId: promptVersion, contentHash: '6b6507dfaa4d276164691da043b6a96fc77ebdf8b9608cc5b0dea912ae8e15a5' } },
      models: {
        [agentA]: { provider: 'openai-compatible', model: 'model-a', parametersHash: '8e5186b2082d8fe36a96cc33e09124dc78c13fa5b6e5e98cf4a41735694c2f26' },
        [agentB]: { provider: 'openai-compatible', model: 'model-b', parametersHash: 'cc3d662e9f4a3e3b46d7307849ab076a908a64567bd8de4ff92b905a0ab5c857' },
      },
      apiTools: {
        [explicitTool]: { toolId: explicitTool, schemaHash: '5b6007a34f75efed6c77d19577b2ed0cdef3e0053fcd66d6d619a255e5484201', permissionHash: '98755d0787c53348b161083f2ccd2506b9df8183d21f8aa7f159cc683f9e17ac' },
        [inheritedTool]: { toolId: inheritedTool, schemaHash: 'dad58d0fbc78e65b514a0e690bcc88c2d170dd2b7f808257f17082a315e9d40c', permissionHash: '5db56212646466bdddd7234073c0499fe1bec0f1e3f3810216952954df737320' },
      },
      mcpActions: { [mcpTool]: { connectionId, toolId: mcpTool, schemaHash: '19ceb1e04464cc2f718e6f2463481202496aa0950f7c531835248c06506d27d9', permissionHash: '35bdffe5870d68c4e59ce4409a302cd939e9366abf56aaad41d530cb766cd40a' } },
      policy: { version: '1' },
      adapters: { start: 'logic:1', writer: 'agent:1', reviewer: 'agent:1', call_api: 'api:1', call_mcp: 'mcp:1', finish: 'file:1' },
      outputContracts: {
        writer: '931123fda47bb7a99ef763fd5a0b8b7230f53f2cf1e063951dc74298e1016553',
        reviewer: '1e1d0f251d3a76fa2b1bfc81164078572623403887db02988b504b0492e9f076',
        finish: 'e73a192737867ae65131ef81ab33da034274695158ae98a538d82189bf83f3bd',
      },
      artifactTemplates: { [artifactTemplate]: '94b462d0d75b0dca10282413c936e5f7f84a0ac7645ba690792f8fec475fcb88' },
      runtime: { version: '0.1.0', stateSchemaVersion: 1 },
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

  it('rejects live API, MCP, permission, and provider drift against a stored manifest', async () => {
    const manifest = await buildWorkflowManifest({ workspaceId, workflowVersionId, definition });
    const assertCurrent = () => assertWorkflowManifestDependencies({
      workspaceId,
      workflowVersionId,
      definition,
      manifest,
    });
    await expect(assertCurrent()).resolves.toBeUndefined();

    await query("UPDATE tools SET permissions='[\"records.write\"]'::jsonb WHERE id=$1", [apiToolId]);
    await expect(assertCurrent()).rejects.toMatchObject({ code: 'RUN_MANIFEST_INCOMPATIBLE', retryable: false });
    await query("UPDATE tools SET permissions='[\"records.read\"]'::jsonb WHERE id=$1", [apiToolId]);

    await query("UPDATE mcp_connection_tools SET risk_level='write' WHERE id=$1", [mcpToolId]);
    await expect(assertCurrent()).rejects.toMatchObject({ code: 'RUN_MANIFEST_INCOMPATIBLE', retryable: false });
    await query("UPDATE mcp_connection_tools SET risk_level='read' WHERE id=$1", [mcpToolId]);

    await query("UPDATE mcp_agent_tool_access SET permission_level='write' WHERE agent_id=$1 AND mcp_tool_id=$2", [agentId, mcpToolId]);
    await expect(assertCurrent()).rejects.toMatchObject({ code: 'RUN_MANIFEST_INCOMPATIBLE', retryable: false });
    await query("UPDATE mcp_agent_tool_access SET permission_level='read' WHERE agent_id=$1 AND mcp_tool_id=$2", [agentId, mcpToolId]);

    await query(
      `INSERT INTO workspace_ai_provider_configs(
         workspace_id,provider,base_url,default_model,encrypted_api_key,api_key_hint,created_by,updated_by
       ) VALUES($1,'openai-compatible','https://example.test/v1','model-a','{}'::jsonb,'test',$2,$2)`,
      [workspaceId, actorId],
    );
    await expect(assertCurrent()).rejects.toMatchObject({ code: 'RUN_MANIFEST_INCOMPATIBLE', retryable: false });
    await query('DELETE FROM workspace_ai_provider_configs WHERE workspace_id=$1', [workspaceId]);
    await expect(assertCurrent()).resolves.toBeUndefined();
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
