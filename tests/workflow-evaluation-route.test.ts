import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({ workspace: '00000000-0000-4000-8000-000000000001', user: '00000000-0000-4000-8000-000000000002', workflow: '00000000-0000-4000-8000-000000000003', case: '00000000-0000-4000-8000-000000000004', version: '00000000-0000-4000-8000-000000000005', run: '00000000-0000-4000-8000-000000000006' }));
const state = vi.hoisted(() => ({ statements: [] as string[], selected: null as Record<string, unknown> | null, role: 'member' }));
const apiDefinition = vi.hoisted(() => ({ nodes: [{ id: 'start', type: 'trigger', config: {} }, { id: 'external', type: 'api_action', config: { toolId: 'weather-tool', operation: 'weather.lookup' } }, { id: 'finish', type: 'output', config: { fromNodeId: 'external' } }], edges: [{ source: 'start', target: 'external' }, { source: 'external', target: 'finish' }] }));

const client = vi.hoisted(() => ({ query: vi.fn(async (sql: string) => {
  state.statements.push(sql);
  if (sql.includes('FROM workflow_regression_cases regression')) return { rowCount: state.selected ? 1 : 0, rows: state.selected ? [state.selected] : [] };
  if (sql.includes('INSERT INTO workflow_evaluation_runs')) return { rowCount: 1, rows: [{ id: ids.run }] };
  return { rowCount: 0, rows: [] };
}), release: vi.fn() }));

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => client) },
  query: vi.fn(async (sql: string) => {
    state.statements.push(sql);
    if (sql.includes('UPDATE workflow_evaluation_runs')) return { rowCount: 1, rows: [{ id: ids.run, status: 'failed' }] };
    return { rowCount: 0, rows: [] };
  }),
}));
vi.mock('../src/runtime/manifest.js', () => ({
  buildWorkflowManifest: vi.fn(async () => ({ manifestVersion: 1, compatibility: 'exact', createdAt: '2026-07-28T00:00:00.000Z', workflow: { id: ids.workflow, versionId: ids.version, version: 1, definitionHash: 'a'.repeat(64) }, agents: {}, prompts: {}, models: {}, apiTools: {}, mcpActions: {}, policy: { version: '1' }, adapters: {}, outputContracts: {}, artifactTemplates: {}, runtime: { version: '0.1.0', stateSchemaVersion: 1 } })),
  buildWorkflowDependencySnapshot: vi.fn(), validateManifestCompatibility: vi.fn(() => ({ ok: true, reasons: [] })), canonicalJsonHash: vi.fn(() => 'a'.repeat(64)),
}));
vi.mock('../src/queue/task-queue.js', () => ({ enqueueTask: vi.fn(), enqueueWorkflowRun: vi.fn() }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/artifacts/service.js', () => ({ requestWorkflowArtifacts: vi.fn() }));

import { workflowRoutes } from '../src/routes/workflows.js';

async function app() {
  const instance = Fastify();
  instance.decorate('authenticate', async () => undefined);
  instance.decorate('authorize', async () => { if (state.role === 'viewer') { const error = new Error('FORBIDDEN') as Error & { statusCode: number }; error.statusCode = 403; throw error; } });
  instance.addHook('preHandler', async (request) => { request.user = { sub: ids.user, workspaceId: ids.workspace, email: 'evaluation@example.test' }; });
  await instance.register(workflowRoutes);
  return instance;
}

describe('workflow evaluation route', () => {
  beforeEach(() => {
    state.statements = []; state.role = 'member'; client.query.mockClear();
    state.selected = { case_id: ids.case, case_input: {}, fixtures: {}, assertions: [], version_id: ids.version, definition: apiDefinition };
  });

  it('closes a persisted evaluation as failed when a required fixture is absent', async () => {
    // Break caught: an evaluation failure leaving a durable row in running state.
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/${ids.workflow}/evaluations`, payload: { caseId: ids.case, workflowVersionId: ids.version } });
    await instance.close();

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('EVALUATION_FIXTURE_REQUIRED');
    expect(state.statements.some((sql) => sql.includes('INSERT INTO workflow_evaluation_runs'))).toBe(true);
    expect(state.statements.some((sql) => sql.includes("SET status='failed'"))).toBe(true);
    expect(state.statements.every((sql) => !/invokeTool|executeAuthorizedMcpTool|browser/i.test(sql))).toBe(true);
  });

  it('rejects a model-node evaluation before creating a running row', async () => {
    // Break caught: presenting an unsupported paid model evaluation as a runnable fixture case.
    state.selected = { case_id: ids.case, case_input: {}, fixtures: {}, assertions: [], version_id: ids.version, definition: { nodes: [{ id: 'start', type: 'trigger', config: {} }, { id: 'agent', type: 'agent', config: { agentId: ids.user } }, { id: 'finish', type: 'output', config: {} }], edges: [{ source: 'start', target: 'agent' }, { source: 'agent', target: 'finish' }] } };
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/${ids.workflow}/evaluations`, payload: { caseId: ids.case, workflowVersionId: ids.version } });
    await instance.close();

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('EVALUATION_MODEL_EXECUTOR_REQUIRED');
    expect(state.statements.some((sql) => sql.includes('INSERT INTO workflow_evaluation_runs'))).toBe(false);
  });

  it('keeps the requested workflow version and workspace in the target query', async () => {
    // Break caught: running a tenant case against a version from another workflow or workspace.
    state.selected = null;
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/${ids.workflow}/evaluations`, payload: { caseId: ids.case, workflowVersionId: ids.version } });
    await instance.close();

    expect(response.statusCode).toBe(404);
    const selection = state.statements.find((sql) => sql.includes('FROM workflow_regression_cases regression')) ?? '';
    expect(selection).toContain('version.workflow_id=regression.workflow_id');
    expect(selection).toContain('version.workspace_id=regression.workspace_id');
    expect(selection).toContain('regression.workspace_id=$4');
  });

  it('rejects an invalid assertion when creating a tenant-owned case', async () => {
    // Break caught: persisting a malformed rule that would silently pass later.
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/${ids.workflow}/regression-cases`, payload: { name: 'Bad rule', input: {}, fixtures: {}, assertions: [{ kind: 'cost_usd', operator: '>=', expected: 1 }] } });
    await instance.close();
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('EVALUATION_ASSERTION_INVALID');
  });
});
