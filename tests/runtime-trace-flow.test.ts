import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  workspace: '00000000-0000-4000-8000-000000000001',
  user: '00000000-0000-4000-8000-000000000002',
  agent: '00000000-0000-4000-8000-000000000003',
  agentVersion: '00000000-0000-4000-8000-000000000004',
  task: '00000000-0000-4000-8000-000000000005',
  workflow: '00000000-0000-4000-8000-000000000006',
  workflowVersion: '00000000-0000-4000-8000-000000000007',
  workflowRun: '00000000-0000-4000-8000-000000000008',
}));

const state = vi.hoisted(() => ({
  mode: 'task' as 'task' | 'workflow',
  inserts: [] as Array<{ sql: string; values: unknown[] }>,
  enqueued: [] as Array<{ kind: 'task' | 'workflow'; id: string; traceId: string }>,
}));

const definition = {
  nodes: [
    { id: 'start', type: 'trigger' as const, config: {} },
    { id: 'finish', type: 'output' as const, config: {} },
  ],
  edges: [{ source: 'start', target: 'finish' }],
};

const exactManifest = (workflow = false) => ({
  manifestVersion: 1 as const,
  createdAt: '2026-07-26T00:00:00.000Z',
  compatibility: 'exact' as const,
  ...(workflow ? {
    workflow: {
      id: ids.workflow,
      versionId: ids.workflowVersion,
      version: 1,
      definitionHash: 'a'.repeat(64),
    },
  } : {}),
  agents: workflow ? {} : {
    [ids.agent]: {
      versionId: ids.agentVersion,
      version: 1,
      snapshotHash: 'b'.repeat(64),
    },
  },
  prompts: {},
  models: workflow ? {} : {
    [ids.agent]: {
      provider: 'anthropic',
      model: 'model-a',
      parametersHash: 'c'.repeat(64),
    },
  },
  apiTools: {},
  mcpActions: {},
  policy: { version: '1' },
  adapters: workflow ? { start: 'trigger:1', finish: 'output:1' } : { agent: '1', api: '1', mcp: '1' },
  outputContracts: workflow ? { finish: 'd'.repeat(64) } : { task: 'd'.repeat(64) },
  artifactTemplates: {},
  runtime: { version: '0.1.0', stateSchemaVersion: 1 as const },
});

const client = {
  async query(sql: string, values: unknown[] = []) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
    if (sql.includes('INSERT INTO tasks(')) {
      state.inserts.push({ sql, values });
      return {
        rowCount: 1,
        rows: [{
          id: ids.task,
          title: 'Trace task',
          trace_id: values[8],
          span_id: values[9],
          parent_span_id: values[10],
        }],
      };
    }
    if (sql.includes('INSERT INTO workflow_runs(')) {
      state.inserts.push({ sql, values });
      return {
        rowCount: 1,
        rows: [{
          id: ids.workflowRun,
          trace_id: values[12],
          span_id: values[13],
          parent_span_id: values[14],
        }],
      };
    }
    return { rowCount: 0, rows: [] };
  },
  release() {},
};

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => client) },
  query: vi.fn(async (sql: string) => {
    if (state.mode === 'task' && sql.includes('FROM agents')) {
      return { rowCount: 1, rows: [{ id: ids.agent, status: 'active', published_version_id: ids.agentVersion }] };
    }
    if (state.mode === 'workflow' && sql.includes('FROM workflows w JOIN workflow_versions')) {
      return {
        rowCount: 1,
        rows: [{
          id: ids.workflow,
          workspace_id: ids.workspace,
          name: 'Trace workflow',
          published_name: 'Trace workflow',
          description: '',
          definition,
          published_definition: definition,
          enabled: true,
          status: 'published',
          draft_revision: 1,
          published_version_id: ids.workflowVersion,
        }],
      };
    }
    return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000099' }] };
  }),
}));
vi.mock('../src/runtime/manifest.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/runtime/manifest.js')>(),
  buildTaskManifest: vi.fn(async () => exactManifest(false)),
  buildWorkflowManifest: vi.fn(async () => exactManifest(true)),
}));
vi.mock('../src/queue/task-queue.js', () => ({
  enqueueTask: vi.fn(async (id: string, _phaseId: string, traceId: string) => {
    state.enqueued.push({ kind: 'task', id, traceId });
  }),
  enqueueWorkflowRun: vi.fn(async (id: string, _phaseId: string, _delay: number, traceId: string) => {
    state.enqueued.push({ kind: 'workflow', id, traceId });
  }),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/ai-usage.js', () => ({ assertWorkspaceAiBudgetAvailable: vi.fn(async () => undefined) }));
vi.mock('../src/artifacts/service.js', () => ({
  requestTaskArtifacts: vi.fn(async () => []),
  requestWorkflowArtifacts: vi.fn(async () => []),
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
      email: 'trace@example.test',
    };
  });
  await register(app);
  return app;
}

describe('root trace route, persistence, and queue flow', () => {
  beforeEach(() => {
    state.inserts = [];
    state.enqueued = [];
  });

  it('persists one task root trace atomically and queues the authoritative trace id', async () => {
    state.mode = 'task';
    const app = await routeApp(taskRoutes);
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { agentId: ids.agent, title: 'Trace task', input: {} },
    });
    await app.close();

    expect(response.statusCode).toBe(202);
    const insert = state.inserts.find((entry) => entry.sql.includes('INSERT INTO tasks('));
    expect(insert?.sql).toContain('trace_id');
    const traceId = response.json().trace_id;
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(insert?.values).toContain(traceId);
    expect(state.enqueued).toEqual([{ kind: 'task', id: ids.task, traceId }]);
  });

  it('persists one workflow root trace atomically and queues the authoritative trace id', async () => {
    state.mode = 'workflow';
    const app = await routeApp(workflowRoutes);
    const response = await app.inject({
      method: 'POST',
      url: `/${ids.workflow}/runs`,
      payload: { input: {} },
    });
    await app.close();

    expect(response.statusCode).toBe(202);
    const insert = state.inserts.find((entry) => entry.sql.includes('INSERT INTO workflow_runs('));
    expect(insert?.sql).toContain('trace_id');
    const traceId = response.json().trace_id;
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(insert?.values).toContain(traceId);
    expect(state.enqueued).toEqual([{ kind: 'workflow', id: ids.workflowRun, traceId }]);
  });
});
