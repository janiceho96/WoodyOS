import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  workspace: '00000000-0000-4000-8000-000000000001',
  user: '00000000-0000-4000-8000-000000000002',
  task: '00000000-0000-4000-8000-000000000003',
}));

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn() },
  query: vi.fn(async (sql: string) => {
    if (sql.includes('SELECT t.*,a.name agent_name')) {
      return {
        rowCount: 1,
        rows: [{
          id: ids.task,
          workspace_id: ids.workspace,
          error: { message: 'Provider failed with {"apiKey":"hunter2","retryAfterMs":2000}' },
          agent_name: 'Agent',
          agent_role: 'Researcher',
          agent_avatar: {},
        }],
      };
    }
    if (sql.includes('FROM task_events')) {
      return {
        rowCount: 1,
        rows: [{
          event_type: 'task.failed',
          message: 'Request failed with {"apiKey":"event-secret"}',
          payload: { apiKey: 'payload-secret', retryAfterMs: 100 },
        }],
      };
    }
    if (sql.includes('FROM action_authorizations')) {
      return {
        rowCount: 1,
        rows: [{
          id: '00000000-0000-4000-8000-000000000004',
          error_message: 'Provider failed with {"authorization":"auth-secret"}',
          runtime_error: null,
        }],
      };
    }
    return { rowCount: 0, rows: [] };
  }),
}));

import { taskRoutes } from '../src/routes/tasks.js';

describe('browser runtime error redaction', () => {
  it('never exposes raw historical task, event, or action secrets', async () => {
    const app = Fastify();
    app.decorate('authenticate', async () => undefined);
    app.decorate('authorize', async () => undefined);
    app.addHook('preHandler', async (request) => {
      request.user = {
        sub: ids.user,
        workspaceId: ids.workspace,
        email: 'browser@example.test',
      };
    });
    await taskRoutes(app);

    const response = await app.inject({ method: 'GET', url: `/${ids.task}` });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.error).toMatchObject({ code: 'RUNTIME_ERROR', category: 'unknown', retryable: false });
    expect(body.events[0]).toMatchObject({
      payload: { apiKey: '[REDACTED]', retryAfterMs: 100 },
    });
    expect(body.actionAuthorizations[0].runtime_error).toMatchObject({
      code: 'RUNTIME_ERROR',
      category: 'unknown',
    });
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('event-secret');
    expect(JSON.stringify(body)).not.toContain('payload-secret');
    expect(JSON.stringify(body)).not.toContain('auth-secret');
  });
});
