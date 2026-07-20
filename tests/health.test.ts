import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/client.js', () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) }, query: vi.fn() }));

describe('health endpoint', () => {
  it('returns healthy when the database is reachable', async () => {
    process.env.NODE_ENV = 'test';
    const { buildApp } = await import('../src/server.js');
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
