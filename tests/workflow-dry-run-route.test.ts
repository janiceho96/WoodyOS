import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({ workspace: '00000000-0000-4000-8000-000000000001', user: '00000000-0000-4000-8000-000000000002', workflow: '00000000-0000-4000-8000-000000000003' }));
const state = vi.hoisted(() => ({ statements: [] as string[], role: 'member' }));
const definition = { nodes: [{ id: 'start', type: 'trigger', config: {} }, { id: 'finish', type: 'output', config: {} }], edges: [{ source: 'start', target: 'finish' }] };

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn() },
  query: vi.fn(async (sql: string) => {
    state.statements.push(sql);
    if (sql.includes('FROM workflows')) return { rowCount: 1, rows: [{ id: ids.workflow, workspace_id: ids.workspace, definition, status: 'draft' }] };
    return { rowCount: 0, rows: [] };
  }),
}));
vi.mock('../src/queue/task-queue.js', () => ({ enqueueTask: vi.fn(), enqueueWorkflowRun: vi.fn() }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/artifacts/service.js', () => ({ requestWorkflowArtifacts: vi.fn() }));

import { workflowRoutes } from '../src/routes/workflows.js';

async function app() {
  const instance = Fastify();
  instance.decorate('authenticate', async () => undefined);
  instance.decorate('authorize', async () => { if (state.role === 'viewer') { const error = new Error('FORBIDDEN') as Error & { statusCode: number }; error.statusCode = 403; throw error; } });
  instance.addHook('preHandler', async (request) => { request.user = { sub: ids.user, workspaceId: ids.workspace, email: 'dry-run@example.test' }; });
  await instance.register(workflowRoutes);
  return instance;
}

describe('workflow dry-run route', () => {
  beforeEach(() => { state.statements = []; state.role = 'member'; });

  it('authorizes a member and performs only tenant-scoped reads without creating a run', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/${ids.workflow}/dry-run`, payload: { input: {} } });
    await instance.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().errors).toEqual([]);
    expect(response.json()).toMatchObject({ valid: true, executionPath: ['start', 'finish'] });
    expect(state.statements.length).toBeGreaterThanOrEqual(1);
    expect(state.statements[0]).toContain('workspace_id=$2');
    expect(state.statements.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
    expect(state.statements.join('\n')).not.toMatch(/workflow_runs|INSERT|UPDATE|DELETE|audit/i);
  });

  it('rejects an unauthorized role before any database read', async () => {
    state.role = 'viewer';
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/${ids.workflow}/dry-run`, payload: { input: {} } });
    await instance.close();
    expect(response.statusCode).toBe(403);
    expect(state.statements).toEqual([]);
  });
});
