import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  workspace: '00000000-0000-4000-8000-000000000001',
  user: '00000000-0000-4000-8000-000000000002',
  task: '00000000-0000-4000-8000-000000000003',
  workflowRun: '00000000-0000-4000-8000-000000000004',
  childTask: '00000000-0000-4000-8000-000000000005',
}));
const state = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  audits: [] as string[],
  enqueuedTasks: [] as Array<unknown[]>,
  enqueuedWorkflows: [] as Array<unknown[]>,
}));

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn() },
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM tasks') && sql.includes('workflow_run_id')) {
      return {
        rowCount: 1,
        rows: [{
          id: ids.childTask,
          trace_id: '00000000-0000-4000-8000-000000000012',
        }],
      };
    }
    return { rowCount: 0, rows: [] };
  }),
}));
vi.mock('../src/runtime/cancellation.js', () => ({
  requestCancellation: vi.fn(async (input: Record<string, unknown>) => {
    state.requests.push(input);
    return {
      id: input.id,
      status: 'cancel_requested',
      trace_id: '00000000-0000-4000-8000-000000000010',
      span_id: '00000000-0000-4000-8000-000000000011',
      parent_span_id: null,
    };
  }),
}));
vi.mock('../src/lib/audit.js', () => ({
  audit: vi.fn(async (_workspaceId: string, _actorId: string, action: string) => {
    state.audits.push(action);
  }),
}));
vi.mock('../src/queue/task-queue.js', () => ({
  enqueueTask: vi.fn(async (...args: unknown[]) => {
    state.enqueuedTasks.push(args);
  }),
  enqueueWorkflowRun: vi.fn(async (...args: unknown[]) => {
    state.enqueuedWorkflows.push(args);
  }),
}));
vi.mock('../src/lib/ai-usage.js', () => ({
  assertWorkspaceAiBudgetAvailable: vi.fn(),
}));
vi.mock('../src/artifacts/service.js', () => ({
  requestTaskArtifacts: vi.fn(),
  requestWorkflowArtifacts: vi.fn(),
}));

import { taskRoutes } from '../src/routes/tasks.js';
import { workflowRoutes } from '../src/routes/workflows.js';

async function routeApp(register: (app: ReturnType<typeof Fastify>) => Promise<void>) {
  const app = Fastify();
  app.decorate('authenticate', async () => undefined);
  app.decorate('authorize', async () => undefined);
  app.addHook('preHandler', async (request) => {
    request.user = {
      sub: ids.user,
      workspaceId: ids.workspace,
      email: 'cancel@example.test',
    };
  });
  await register(app);
  return app;
}

describe('cancellation routes', () => {
  beforeEach(() => {
    state.requests = [];
    state.audits = [];
    state.enqueuedTasks = [];
    state.enqueuedWorkflows = [];
  });

  it('requests task cancellation idempotently without declaring immediate completion', async () => {
    const app = await routeApp(taskRoutes);
    const first = await app.inject({ method: 'POST', url: `/${ids.task}/cancel` });
    const second = await app.inject({ method: 'POST', url: `/${ids.task}/cancel` });
    await app.close();

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ id: ids.task, status: 'cancel_requested' });
    expect(second.json()).toEqual(first.json());
    expect(state.requests).toEqual([
      { kind: 'task', id: ids.task, workspaceId: ids.workspace, actorId: ids.user },
      { kind: 'task', id: ids.task, workspaceId: ids.workspace, actorId: ids.user },
    ]);
    expect(state.audits).toEqual(['task.cancel_requested', 'task.cancel_requested']);
    expect(state.enqueuedTasks).toEqual([
      [ids.task, ids.task, '00000000-0000-4000-8000-000000000010'],
      [ids.task, ids.task, '00000000-0000-4000-8000-000000000010'],
    ]);
    expect(state.enqueuedWorkflows).toEqual([]);
  });

  it('exposes the same cancellation transition for workflow runs', async () => {
    const app = await routeApp(workflowRoutes);
    const response = await app.inject({
      method: 'POST',
      url: `/runs/${ids.workflowRun}/cancel`,
    });
    await app.close();

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      id: ids.workflowRun,
      status: 'cancel_requested',
    });
    expect(state.requests).toEqual([{
      kind: 'workflow_run',
      id: ids.workflowRun,
      workspaceId: ids.workspace,
      actorId: ids.user,
    }]);
    expect(state.audits).toEqual(['workflow.cancel_requested']);
    expect(state.enqueuedWorkflows).toEqual([[
      ids.workflowRun,
      ids.workflowRun,
      0,
      '00000000-0000-4000-8000-000000000010',
    ]]);
    expect(state.enqueuedTasks).toEqual([[
      ids.childTask,
      ids.childTask,
      '00000000-0000-4000-8000-000000000012',
    ]]);
  });
});
