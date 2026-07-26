import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const agentId = '44444444-4444-4444-8444-444444444444';
const connectionId = '55555555-5555-4555-8555-555555555555';
const toolId = '66666666-6666-4666-8666-666666666666';

const storedRows = [{
  agent_id: agentId,
  agent_status: 'paused',
  connection_id: connectionId,
  connection_name: 'Docs MCP',
  connection_permission: 'read',
  connection_access_enabled: true,
  connection_enabled: false,
  health_status: 'unhealthy',
  tool_id: toolId,
  remote_name: 'search_docs',
  tool_title: 'Search docs',
  risk_level: 'read',
  tool_permission: 'read',
  tool_access_enabled: false,
  tool_enabled: false,
  endpoint_url: 'https://secret.example.test/mcp',
  auth_type: 'bearer',
  encrypted_credentials: { token: 'never-return-this' },
  server_info: { authorization: 'never-return-this-either' },
  input_schema: { apiKey: 'schema-secret' },
}];

const query = vi.fn(async (sql: string, values: unknown[] = []) => {
  if (sql.includes('workspace_memberships')) return { rowCount: 1, rows: [{ role: 'viewer' }] };
  if (sql.includes('mcp_agent_access')) {
    return values[0] === agentId && values[1] === workspaceId
      ? { rowCount: storedRows.length, rows: storedRows }
      : { rowCount: 0, rows: [] };
  }
  return { rowCount: 0, rows: [] };
});

vi.mock('../src/db/client.js', () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) },
  query,
}));

describe('agent-scoped saved MCP access', () => {
  let app: Awaited<ReturnType<(typeof import('../src/server.js'))['buildApp']>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'a-development-secret-that-is-at-least-32-characters';
    const { buildApp } = await import('../src/server.js');
    app = await buildApp();
  }, 30_000);

  beforeEach(() => {
    query.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('requires an authenticated workspace membership', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/mcp-access` });

    expect(response.statusCode, response.body).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not reveal whether an agent belongs to another workspace', async () => {
    const token = app.jwt.sign({ sub: userId, workspaceId: otherWorkspaceId, role: 'viewer' });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/agents/${agentId}/mcp-access`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toEqual({ error: 'AGENT_NOT_FOUND' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('mcp_agent_access'), [agentId, otherWorkspaceId]);
  });

  it('returns saved assignments with separate availability metadata and no MCP configuration', async () => {
    const token = app.jwt.sign({ sub: userId, workspaceId, role: 'viewer' });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/agents/${agentId}/mcp-access`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      agentId,
      agentStatus: 'paused',
      connections: [{
        id: connectionId,
        name: 'Docs MCP',
        permissionLevel: 'read',
        assignmentEnabled: true,
        availability: {
          available: false,
          status: 'agent_inactive',
          connectionEnabled: false,
          healthStatus: 'unhealthy',
        },
        tools: [{
          id: toolId,
          remoteName: 'search_docs',
          title: 'Search docs',
          riskLevel: 'read',
          permissionLevel: 'read',
          assignmentEnabled: false,
          availability: {
            available: false,
            status: 'agent_inactive',
            toolEnabled: false,
          },
        }],
      }],
    });
    expect(response.body).not.toMatch(/endpoint|auth_type|encrypted|credential|server_info|input_schema|never-return|schema-secret/i);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('mcp_agent_access'))).toHaveLength(1);
  });
});
