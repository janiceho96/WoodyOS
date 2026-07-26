import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mode: 'task-action' as 'task-action' | 'task-action-missing-trace' | 'task-action-queue-failure' | 'workflow-action' | 'mcp-call',
  statements: [] as string[],
  enqueued: [] as string[],
  queueFailure: false,
}));

const incompatibleManifest = {
  manifestVersion: 1,
  createdAt: '2026-07-26T00:00:00.000Z',
  compatibility: 'exact',
  agents: { '00000000-0000-4000-8000-000000000010': {} },
};

const client = {
  async query(sql: string) {
    state.statements.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rowCount: null, rows: [] };
    if (state.mode.startsWith('task-action') && sql.includes('FROM action_authorizations authorization')) {
      return {
        rowCount: 1,
        rows: [{
          task_id: '00000000-0000-4000-8000-000000000020',
          agent_id: '00000000-0000-4000-8000-000000000010',
          workflow_run_id: null,
          pending_tool_call_id: null,
          run_mode: state.mode === 'task-action' ? null : 'test',
          execution_manifest: state.mode === 'task-action' ? incompatibleManifest : null,
          trace_id: state.mode === 'task-action-missing-trace' ? null : '00000000-0000-4000-8000-000000000050',
          span_id: state.mode === 'task-action-missing-trace' ? null : '00000000-0000-4000-8000-000000000051',
          parent_span_id: null,
        }],
      };
    }
    if (state.mode === 'workflow-action' && sql.includes('FROM action_authorizations')) {
      return {
        rowCount: 1,
        rows: [{
          workflow_run_id: '00000000-0000-4000-8000-000000000030',
          run_mode: 'production',
          workflow_version_id: '00000000-0000-4000-8000-000000000031',
          definition_snapshot: { nodes: [], edges: [] },
          execution_manifest: incompatibleManifest,
          trace_id: '00000000-0000-4000-8000-000000000050',
          span_id: '00000000-0000-4000-8000-000000000051',
          parent_span_id: null,
        }],
      };
    }
    if (state.mode === 'mcp-call' && sql.includes('SELECT action_authorization_id FROM mcp_tool_calls')) {
      return { rowCount: 1, rows: [{ action_authorization_id: null }] };
    }
    if (state.mode === 'mcp-call' && sql.includes('FROM mcp_tool_calls calls')) {
      return {
        rowCount: 1,
        rows: [{
          task_id: '00000000-0000-4000-8000-000000000020',
          agent_id: '00000000-0000-4000-8000-000000000010',
          workflow_run_id: null,
          action_authorization_id: null,
          execution_manifest: incompatibleManifest,
          trace_id: '00000000-0000-4000-8000-000000000050',
          span_id: '00000000-0000-4000-8000-000000000051',
          parent_span_id: null,
        }],
      };
    }
    return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000099' }] };
  },
  release() {},
};

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => client) },
  query: vi.fn(async (sql: string) => client.query(sql)),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/queue/task-queue.js', () => ({
  enqueueTask: vi.fn(async (id: string) => {
    state.enqueued.push(id);
    if (state.queueFailure) throw new Error('queue unavailable');
  }),
  enqueueWorkflowRun: vi.fn(async (id: string) => { state.enqueued.push(id); }),
}));

import { actionAuthorizationRoutes } from '../src/routes/action-authorizations.js';
import { workflowActionRoutes } from '../src/routes/workflow-actions.js';
import { mcpToolCallRoutes } from '../src/routes/mcp/tool-calls.js';

async function routeApp(register: (app: ReturnType<typeof Fastify>) => Promise<void>) {
  const app = Fastify();
  app.decorate('authenticate', async () => undefined);
  app.decorate('authorize', async () => undefined);
  app.addHook('preHandler', async (request) => {
    request.user = {
      sub: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000002',
      email: 'manifest-route@example.test',
    };
  });
  await register(app);
  return app;
}

describe('production resume manifest gates', () => {
  beforeEach(() => {
    state.statements = [];
    state.enqueued = [];
    state.queueFailure = false;
  });

  it('rejects a task action decision before consuming authorization or checkpoint state', async () => {
    state.mode = 'task-action';
    const app = await routeApp(actionAuthorizationRoutes);
    const response = await app.inject({
      method: 'POST',
      url: '/00000000-0000-4000-8000-000000000040/decision',
      payload: { decision: 'approved' },
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'RUN_MANIFEST_INCOMPATIBLE' });
    expect(state.statements.filter((sql) => sql.trimStart().startsWith('UPDATE'))).toEqual([]);
    expect(state.enqueued).toEqual([]);
  });

  it('rejects a workflow action approval before consuming authorization state', async () => {
    state.mode = 'workflow-action';
    const app = await routeApp(workflowActionRoutes);
    const response = await app.inject({
      method: 'POST',
      url: '/00000000-0000-4000-8000-000000000040/decision',
      payload: { decision: 'approved' },
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'RUN_MANIFEST_INCOMPATIBLE' });
    expect(state.statements.filter((sql) => sql.trimStart().startsWith('UPDATE'))).toEqual([]);
    expect(state.enqueued).toEqual([]);
  });

  it('rejects an MCP confirmation before consuming call or checkpoint state', async () => {
    state.mode = 'mcp-call';
    const app = await routeApp(mcpToolCallRoutes);
    const response = await app.inject({
      method: 'POST',
      url: '/00000000-0000-4000-8000-000000000040/decision',
      payload: { decision: 'approved' },
    });
    await app.close();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'RUN_MANIFEST_INCOMPATIBLE' });
    expect(state.statements.filter((sql) => sql.trimStart().startsWith('UPDATE'))).toEqual([]);
    expect(state.enqueued).toEqual([]);
  });

  it('fails closed on a missing trace before consuming task approval state', async () => {
    state.mode = 'task-action-missing-trace';
    const app = await routeApp(actionAuthorizationRoutes);
    const response = await app.inject({
      method: 'POST',
      url: '/00000000-0000-4000-8000-000000000040/decision',
      payload: { decision: 'approved' },
    });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(state.statements.filter((sql) => sql.trimStart().startsWith('UPDATE'))).toEqual([]);
    expect(state.enqueued).toEqual([]);
  });

  it('restores task approval and checkpoint state when enqueue fails', async () => {
    state.mode = 'task-action-queue-failure';
    state.queueFailure = true;
    const app = await routeApp(actionAuthorizationRoutes);
    const response = await app.inject({
      method: 'POST',
      url: '/00000000-0000-4000-8000-000000000040/decision',
      payload: { decision: 'approved' },
    });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(state.statements.some((sql) => (
      sql.includes("UPDATE action_authorizations SET status='awaiting_confirmation'")
    ))).toBe(true);
    expect(state.statements.some((sql) => (
      sql.includes("UPDATE task_runtime_checkpoints SET status='awaiting_confirmation'")
    ))).toBe(true);
    expect(state.statements.some((sql) => (
      sql.includes("UPDATE tasks SET status='awaiting_approval'")
    ))).toBe(true);
  });
});
