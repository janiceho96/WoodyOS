import { beforeAll, describe, expect, it, vi } from 'vitest';

const query = vi.fn(async (sql: string) => sql.includes('workspace_memberships') ? { rowCount: 1, rows: [{ role: 'member' }] } : { rowCount: 0, rows: [] });
vi.mock('../src/db/client.js', () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) }, query }));

describe('API input validation', () => {
  let app: Awaited<ReturnType<(typeof import('../src/server.js'))['buildApp']>>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'a-development-secret-that-is-at-least-32-characters';
    const { buildApp } = await import('../src/server.js');
    app = await buildApp();
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
});
