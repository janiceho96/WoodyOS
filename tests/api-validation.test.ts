import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceId = '22222222-2222-4222-8222-222222222222';
const memberUserId = '11111111-1111-4111-8111-111111111111';
const adminUserId = '33333333-3333-4333-8333-333333333333';
const viewerUserId = '44444444-4444-4444-8444-444444444444';
const departmentId = '55555555-5555-4555-8555-555555555555';
const createdDepartmentId = '77777777-7777-4777-8777-777777777777';
const agentId = '66666666-6666-4666-8666-666666666666';
const now = new Date('2026-07-26T00:00:00.000Z');
let insertedDepartment:
  | { id: string; name: string; description: string }
  | undefined;
let forceDepartmentMissing = false;
let forceDepartmentArchived = false;
let forceMembershipMissing = false;
let forcedMutationRevision: number | undefined;

const membershipRole = (userId: unknown) => {
  if (userId === adminUserId) return 'admin';
  if (userId === viewerUserId) return 'viewer';
  return 'member';
};
const query = vi.fn(async (sql: string, values?: unknown[]) => {
  if (sql.includes('workspace_memberships')) {
    return {
      rowCount: 1,
      rows: [{ role: membershipRole(values?.[1]) }],
    };
  }
  if (sql.includes('FROM agents a')) {
    return {
      rowCount: 1,
      rows: [{
        id: agentId,
        name: 'Safe Agent',
        role: 'Operator',
        status: 'active',
        avatar: { type: 'icon', value: 'shield' },
        active_work_count: 2,
        api_tool_count: 3,
        mcp_connection_count: 1,
      }],
    };
  }
  return { rowCount: 0, rows: [] };
});
const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
  if (sql.includes('SELECT revision,executive_agent_id')) {
    return {
      rowCount: 1,
      rows: [{ revision: 2, executive_agent_id: agentId }],
    };
  }
  if (sql.includes('SELECT id,workspace_id,name,description,status')) {
    const rows = [{
      id: departmentId,
      workspace_id: workspaceId,
      name: 'Operations',
      description: 'Coordinates operations',
      status: 'active',
      display_order: 4,
      manager_agent_id: agentId,
      created_at: now,
      updated_at: now,
    }];
    if (insertedDepartment) {
      rows.push({
        id: insertedDepartment.id,
        workspace_id: workspaceId,
        name: insertedDepartment.name,
        description: insertedDepartment.description,
        status: 'active',
        display_order: 0,
        manager_agent_id: agentId,
        created_at: now,
        updated_at: now,
      });
    }
    return {
      rowCount: 1,
      rows,
    };
  }
  if (sql.includes('SELECT department_id,workspace_id,agent_id,membership_type')) {
    return {
      rowCount: 1,
      rows: [{
        department_id: departmentId,
        workspace_id: workspaceId,
        agent_id: agentId,
        membership_type: 'primary',
        created_at: now,
        updated_at: now,
      }],
    };
  }
  if (sql.includes('SELECT revision') && sql.includes('workspace_org_settings')) {
    return {
      rowCount: 1,
      rows: [{ revision: forcedMutationRevision ?? 2 }],
    };
  }
  if (sql.includes('FROM workspace_memberships')) {
    return { rowCount: 1, rows: [{ '?column?': 1 }] };
  }
  if (sql.includes('INSERT INTO departments')) {
    insertedDepartment = {
      id: createdDepartmentId,
      name: String(values?.[1]),
      description: String(values?.[2] ?? ''),
    };
    return {
      rowCount: 1,
      rows: [{
        id: createdDepartmentId,
        workspace_id: workspaceId,
        name: String(values?.[1]),
        description: String(values?.[2] ?? ''),
        status: 'active',
        display_order: Number(values?.[3] ?? 0),
        manager_agent_id: values?.[4] ?? null,
        created_at: now,
        updated_at: now,
      }],
    };
  }
  if (sql.includes('UPDATE workspace_org_settings')) {
    return { rowCount: 1, rows: [{ revision: 3 }] };
  }
  if (sql.includes('DELETE FROM department_memberships')) {
    if (forceMembershipMissing) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ membership_type: 'primary' }] };
  }
  if (sql.includes('SELECT id,status,manager_agent_id')) {
    if (forceDepartmentMissing) return { rowCount: 0, rows: [] };
    return {
      rowCount: 1,
      rows: [{
        id: departmentId,
        status: forceDepartmentArchived ? 'archived' : 'active',
        manager_agent_id: agentId,
      }],
    };
  }
  if (sql.includes('SELECT id,status') && sql.includes('FROM agents')) {
    return { rowCount: 1, rows: [{ id: agentId, status: 'active' }] };
  }
  return { rowCount: 1, rows: [] };
});
const release = vi.fn();
vi.mock('../src/db/client.js', () => ({
  db: {
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    connect: vi.fn(async () => ({ query: clientQuery, release })),
  },
  query,
}));

describe('API input validation', () => {
  let app: Awaited<ReturnType<(typeof import('../src/server.js'))['buildApp']>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'a-development-secret-that-is-at-least-32-characters';
    const { buildApp } = await import('../src/server.js');
    app = await buildApp();
  }, 30_000);

  beforeEach(() => {
    query.mockClear();
    clientQuery.mockClear();
    release.mockClear();
    insertedDepartment = undefined;
    forceDepartmentMissing = false;
    forceDepartmentArchived = false;
    forceMembershipMissing = false;
    forcedMutationRevision = undefined;
  });

  it('rejects incomplete registration data before database writes', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'not-an-email', password: 'short' } });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed agent definitions', async () => {
    const token = app.jwt.sign({ sub: '11111111-1111-1111-1111-111111111111', workspaceId: '22222222-2222-2222-2222-222222222222', role: 'member' });
    const response = await app.inject({ method: 'POST', url: '/v1/agents', headers: { authorization: `Bearer ${token}` }, payload: { name: '', role: '', goal: '' } });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  it('requires an agent name or role before generating a prompt', async () => {
    const token = app.jwt.sign({ sub: '11111111-1111-1111-1111-111111111111', workspaceId: '22222222-2222-2222-2222-222222222222', role: 'member' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agents/generate-prompt',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: '', role: '', tone: 'professional' },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid editable-output version payloads before database writes', async () => {
    const token = app.jwt.sign({ sub: '11111111-1111-1111-1111-111111111111', workspaceId: '22222222-2222-2222-2222-222222222222', role: 'member' });
    const headers = { authorization: `Bearer ${token}` };
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/output-documents/33333333-3333-4333-8333-333333333333/versions',
      headers,
      payload: { content: '', baseVersionNumber: 1 },
    });
    expect(empty.statusCode, empty.body).toBe(400);
    expect(empty.json().error).toBe('VALIDATION_ERROR');
    const invalidBase = await app.inject({
      method: 'POST',
      url: '/v1/output-documents/33333333-3333-4333-8333-333333333333/versions',
      headers,
      payload: { content: '# Revision', baseVersionNumber: 0 },
    });
    expect(invalidBase.statusCode, invalidBase.body).toBe(400);
    expect(invalidBase.json().error).toBe('VALIDATION_ERROR');
  });

  it('returns a forbidden response instead of masking authorization errors as an internal error', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const token = app.jwt.sign({ sub: '11111111-1111-1111-1111-111111111111', workspaceId: '22222222-2222-2222-2222-222222222222', role: 'member' });
    const response = await app.inject({ method: 'GET', url: '/v1/agents', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error).toBe('FORBIDDEN');
  });

  it('returns only safe runtime configuration to authenticated clients', async () => {
    const token = app.jwt.sign({ sub: '11111111-1111-1111-1111-111111111111', workspaceId: '22222222-2222-2222-2222-222222222222', role: 'member' });
    const response = await app.inject({ method: 'GET', url: '/v1/runtime/config', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      defaultModel: expect.any(String),
      provider: expect.any(String),
      source: expect.stringMatching(/^(workspace|environment|unconfigured)$/),
      configured: expect.any(Boolean),
      apiKeyHint: expect.toSatisfy((value: unknown) => value === null || /^•••• .{4}$/.test(String(value))),
    });
    expect(response.json()).not.toHaveProperty('apiKey');
    expect(response.json()).not.toHaveProperty('encryptedApiKey');
    expect(response.json()).not.toHaveProperty('encrypted_api_key');
    expect(response.body).not.toMatch(/"(?:secret|token|credential)"\s*:/i);
  });

  it('rejects unsupported analytics ranges before database queries', async () => {
    const token = app.jwt.sign({ sub: '11111111-1111-1111-1111-111111111111', workspaceId: '22222222-2222-2222-2222-222222222222', role: 'member' });
    const response = await app.inject({ method: 'GET', url: '/v1/analytics/overview?days=365', headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error).toBe('VALIDATION_ERROR');
  });

  it('allows admins to edit departments and members only to read them', async () => {
    const memberHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: memberUserId,
        workspaceId,
        role: 'member',
      })}`,
    };
    const adminHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: adminUserId,
        workspaceId,
        role: 'admin',
      })}`,
    };
    const viewerHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: viewerUserId,
        workspaceId,
        role: 'viewer',
      })}`,
    };

    const createAsMember = await app.inject({
      method: 'POST',
      url: '/v1/departments',
      headers: memberHeaders,
      payload: { name: 'Operations', expectedRevision: 2 },
    });
    expect(createAsMember.statusCode, createAsMember.body).toBe(403);

    const createAsAdmin = await app.inject({
      method: 'POST',
      url: '/v1/departments',
      headers: adminHeaders,
      payload: { name: 'Operations', expectedRevision: 2 },
    });
    expect(createAsAdmin.statusCode, createAsAdmin.body).toBe(201);
    expect(createAsAdmin.json()).toMatchObject({
      revision: 3,
      department: {
        id: createdDepartmentId,
        workspaceId,
        name: 'Operations',
        description: '',
        status: 'active',
        displayOrder: 0,
        managerAgentId: null,
      },
    });

    const readAsMember = await app.inject({
      method: 'GET',
      url: '/v1/departments',
      headers: memberHeaders,
    });
    expect(readAsMember.statusCode, readAsMember.body).toBe(200);

    const readAsViewer = await app.inject({
      method: 'GET',
      url: '/v1/departments',
      headers: viewerHeaders,
    });
    expect(readAsViewer.statusCode, readAsViewer.body).toBe(200);
  });

  it('returns a conflict with the current revision for stale edits', async () => {
    const adminHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: adminUserId,
        workspaceId,
        role: 'admin',
      })}`,
    };
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/departments/${departmentId}`,
      headers: adminHeaders,
      payload: { name: 'Sales Ops', expectedRevision: 1 },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'DEPARTMENT_REVISION_CONFLICT',
      currentRevision: 2,
    });
  });

  it('rejects malformed Department payloads before database writes', async () => {
    const adminHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: adminUserId,
        workspaceId,
        role: 'admin',
      })}`,
    };
    const invalidRevision = await app.inject({
      method: 'POST',
      url: '/v1/departments',
      headers: adminHeaders,
      payload: { name: 'Operations', expectedRevision: 0 },
    });
    expect(invalidRevision.statusCode, invalidRevision.body).toBe(400);
    expect(invalidRevision.json().error).toBe('VALIDATION_ERROR');

    const invalidId = await app.inject({
      method: 'PATCH',
      url: '/v1/departments/not-a-uuid',
      headers: adminHeaders,
      payload: { name: 'Operations', expectedRevision: 2 },
    });
    expect(invalidId.statusCode, invalidId.body).toBe(400);
    expect(invalidId.json().error).toBe('VALIDATION_ERROR');

    const oversizedName = await app.inject({
      method: 'POST',
      url: '/v1/departments',
      headers: adminHeaders,
      payload: { name: 'x'.repeat(121), expectedRevision: 2 },
    });
    expect(oversizedName.statusCode, oversizedName.body).toBe(400);
    expect(oversizedName.json().error).toBe('VALIDATION_ERROR');

    const oversizedDescription = await app.inject({
      method: 'POST',
      url: '/v1/departments',
      headers: adminHeaders,
      payload: {
        name: 'Operations',
        description: 'x'.repeat(2_001),
        expectedRevision: 2,
      },
    });
    expect(oversizedDescription.statusCode, oversizedDescription.body).toBe(400);
    expect(oversizedDescription.json().error).toBe('VALIDATION_ERROR');

    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('routes every Department mutation through revisioned service contracts', async () => {
    const adminHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: adminUserId,
        workspaceId,
        role: 'admin',
      })}`,
    };
    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/departments/${departmentId}`,
      headers: adminHeaders,
      payload: { name: 'Sales Operations', expectedRevision: 2 },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toEqual({ revision: 3 });

    const assigned = await app.inject({
      method: 'PUT',
      url: `/v1/departments/${departmentId}/members/${agentId}`,
      headers: adminHeaders,
      payload: { membershipType: 'shared', expectedRevision: 2 },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json()).toEqual({ revision: 3 });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/departments/${departmentId}/members/${agentId}`,
      headers: adminHeaders,
      payload: { expectedRevision: 2 },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ revision: 3 });

    const executive = await app.inject({
      method: 'PUT',
      url: '/v1/departments/settings/executive',
      headers: adminHeaders,
      payload: { agentId: null, expectedRevision: 2 },
    });
    expect(executive.statusCode, executive.body).toBe(200);
    expect(executive.json()).toEqual({ revision: 3 });

    const archived = await app.inject({
      method: 'DELETE',
      url: `/v1/departments/${departmentId}`,
      headers: adminHeaders,
      payload: { expectedRevision: 2 },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toEqual({ revision: 3 });
  });

  it('returns only one batched safe agent summary projection', async () => {
    const memberHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: memberUserId,
        workspaceId,
        role: 'member',
      })}`,
    };
    const response = await app.inject({
      method: 'GET',
      url: '/v1/departments',
      headers: memberHeaders,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      revision: 2,
      executiveAgentId: agentId,
      agents: [{
        id: agentId,
        name: 'Safe Agent',
        role: 'Operator',
        status: 'active',
        avatar: { type: 'icon', value: 'shield' },
        activeWorkCount: 2,
        apiToolCount: 3,
        mcpConnectionCount: 1,
      }],
    });
    expect(response.body).not.toMatch(
      /instructions|memory_config|credentials|encrypted_credentials|tool_ids|model_config|raw.*output/i,
    );
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('FROM agents a'))).toHaveLength(1);
  });

  it('keeps legacy team inputs and responses backed only by Departments', async () => {
    const adminHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: adminUserId,
        workspaceId,
        role: 'admin',
      })}`,
    };
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/teams',
      headers: adminHeaders,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.headers.deprecation).toBe('true');
    expect(listed.headers).not.toHaveProperty('sunset');
    expect(listed.json()).toMatchObject({
      data: [{
        id: departmentId,
        workspace_id: workspaceId,
        name: 'Operations',
        description: 'Coordinates operations',
        members: [{
          team_id: departmentId,
          agent_id: agentId,
          manager_agent_id: null,
          name: 'Safe Agent',
          role: 'Operator',
        }],
      }],
    });

    clientQuery.mockClear();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: adminHeaders,
      payload: { name: 'Customer Success', description: 'Supports customers' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers.deprecation).toBe('true');
    expect(created.json()).toMatchObject({
      id: createdDepartmentId,
      workspace_id: workspaceId,
      name: 'Customer Success',
      description: 'Supports customers',
    });
    expect(clientQuery.mock.calls.filter(([sql]) => (
      String(sql).includes('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    ))).toHaveLength(1);

    const membership = await app.inject({
      method: 'PUT',
      url: `/v1/teams/${departmentId}/members/${agentId}`,
      headers: adminHeaders,
      payload: { managerAgentId: null },
    });
    expect(membership.statusCode, membership.body).toBe(200);
    expect(membership.json()).toMatchObject({
      team_id: departmentId,
      agent_id: agentId,
      manager_agent_id: null,
    });

    expect([
      ...query.mock.calls,
      ...clientQuery.mock.calls,
    ].every(([sql]) => !/\b(?:agent_teams|team_memberships)\b/i.test(String(sql)))).toBe(true);
  });

  it('blocks members from solution installs before organization mutation', async () => {
    const memberHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: memberUserId,
        workspaceId,
        role: 'member',
      })}`,
    };
    const starterInstall = await app.inject({
      method: 'POST',
      url: '/v1/starter-solutions/executive-daily-brief/install',
      headers: memberHeaders,
      payload: {},
    });
    expect(starterInstall.statusCode, starterInstall.body).toBe(403);

    const generatedInstall = await app.inject({
      method: 'POST',
      url: '/v1/agent-solutions/install',
      headers: memberHeaders,
      payload: {},
    });
    expect(generatedInstall.statusCode, generatedInstall.body).toBe(403);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('preserves stable legacy team not-found errors', async () => {
    const adminHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: adminUserId,
        workspaceId,
        role: 'admin',
      })}`,
    };

    forceDepartmentMissing = true;
    const missingAssignment = await app.inject({
      method: 'PUT',
      url: `/v1/teams/${departmentId}/members/${agentId}`,
      headers: adminHeaders,
      payload: {},
    });
    expect(missingAssignment.statusCode, missingAssignment.body).toBe(404);
    expect(missingAssignment.json().error).toBe('TEAM_OR_AGENT_NOT_FOUND');

    const missingTeam = await app.inject({
      method: 'DELETE',
      url: `/v1/teams/${departmentId}`,
      headers: adminHeaders,
    });
    expect(missingTeam.statusCode, missingTeam.body).toBe(404);
    expect(missingTeam.json().error).toBe('TEAM_NOT_FOUND');

    forceDepartmentMissing = false;
    forceMembershipMissing = true;
    const missingMembership = await app.inject({
      method: 'DELETE',
      url: `/v1/teams/${departmentId}/members/${agentId}`,
      headers: adminHeaders,
    });
    expect(missingMembership.statusCode, missingMembership.body).toBe(404);
    expect(missingMembership.json().error).toBe('TEAM_MEMBERSHIP_NOT_FOUND');

    forceMembershipMissing = false;
    forceDepartmentArchived = true;
    const archivedAssignment = await app.inject({
      method: 'PUT',
      url: `/v1/teams/${departmentId}/members/${agentId}`,
      headers: adminHeaders,
      payload: {},
    });
    expect(archivedAssignment.statusCode, archivedAssignment.body).toBe(404);
    expect(archivedAssignment.json().error).toBe('TEAM_OR_AGENT_NOT_FOUND');

    const archivedMembership = await app.inject({
      method: 'DELETE',
      url: `/v1/teams/${departmentId}/members/${agentId}`,
      headers: adminHeaders,
    });
    expect(archivedMembership.statusCode, archivedMembership.body).toBe(404);
    expect(archivedMembership.json().error).toBe('TEAM_MEMBERSHIP_NOT_FOUND');

    const archivedTeam = await app.inject({
      method: 'DELETE',
      url: `/v1/teams/${departmentId}`,
      headers: adminHeaders,
    });
    expect(archivedTeam.statusCode, archivedTeam.body).toBe(404);
    expect(archivedTeam.json().error).toBe('TEAM_NOT_FOUND');
  });

  it('returns a stable conflict when a legacy-derived revision races', async () => {
    const adminHeaders = {
      authorization: `Bearer ${app.jwt.sign({
        sub: adminUserId,
        workspaceId,
        role: 'admin',
      })}`,
    };
    forcedMutationRevision = 3;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/teams',
      headers: adminHeaders,
      payload: { name: 'Racing Department' },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({
      error: 'DEPARTMENT_REVISION_CONFLICT',
      currentRevision: 3,
    });
    expect(insertedDepartment).toBeUndefined();
  });
});
