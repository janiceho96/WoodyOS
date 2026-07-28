import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({ workspace: '00000000-0000-4000-8000-000000000001', user: '00000000-0000-4000-8000-000000000002', run: '00000000-0000-4000-8000-000000000003' }));
const state = vi.hoisted(() => ({ role: 'member', calls: [] as unknown[][], membershipReads: 0, replayMissing: false }));

vi.mock('../src/db/client.js', () => ({ db: { connect: vi.fn() }, query: vi.fn(async () => { state.membershipReads += 1; return { rowCount: 1, rows: [{ role: state.role }] }; }) }));
vi.mock('../src/queue/task-queue.js', () => ({ enqueueTask: vi.fn(), enqueueWorkflowRun: vi.fn() }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../src/artifacts/service.js', () => ({ requestWorkflowArtifacts: vi.fn() }));
vi.mock('../src/runtime/replay.js', () => ({
  getWorkflowReplay: vi.fn(async (input: unknown) => {
    state.calls.push([input]);
    if (state.replayMissing) return null;
    return { run: { id: ids.run, traceId: '00000000-0000-4000-8000-000000000004', status: 'completed', createdAt: '2026-07-28T00:00:00.000Z', completedAt: null, modelVersions: [] }, events: [] };
  }),
}));

import { workflowRoutes } from '../src/routes/workflows.js';

async function app() {
  const instance = Fastify();
  instance.decorate('authenticate', async () => undefined);
  instance.decorate('authorize', async () => { if (state.role === 'viewer') { const error = new Error('FORBIDDEN') as Error & { statusCode: number }; error.statusCode = 403; throw error; } });
  instance.addHook('preHandler', async (request) => { request.user = { sub: ids.user, workspaceId: ids.workspace, email: 'replay@example.test', role: state.role }; });
  await instance.register(workflowRoutes);
  return instance;
}

describe('workflow replay route', () => {
  beforeEach(() => { state.role = 'member'; state.calls = []; state.membershipReads = 0; state.replayMissing = false; });

  it('authorizes a member and derives trace history from the tenant-scoped run ID only', async () => {
    // Break caught: allowing arbitrary trace selection or returning replay without member authorization.
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: `/runs/${ids.run}/replay?traceId=attacker-controlled` });
    await instance.close();

    expect(response.statusCode).toBe(200);
    expect(state.calls).toEqual([[{ workspaceId: ids.workspace, runId: ids.run, role: 'member' }]]);
    expect(state.membershipReads).toBe(1);
  });

  it('uses the current membership role rather than a stale privileged token claim', async () => {
    // Break caught: a demoted member retaining admin-only replay summaries through an old access token.
    state.role = 'member';
    const instance = Fastify();
    instance.decorate('authenticate', async () => undefined);
    instance.decorate('authorize', async () => undefined);
    instance.addHook('preHandler', async (request) => { request.user = { sub: ids.user, workspaceId: ids.workspace, email: 'replay@example.test', role: 'admin' }; });
    await instance.register(workflowRoutes);
    const response = await instance.inject({ method: 'GET', url: `/runs/${ids.run}/replay` });
    await instance.close();
    expect(response.statusCode).toBe(200);
    expect(state.calls).toEqual([[{ workspaceId: ids.workspace, runId: ids.run, role: 'member' }]]);
  });

  it('rejects a viewer before asking for replay history', async () => {
    state.role = 'viewer';
    const instance = await app();
    const response = await instance.inject({ method: 'GET', url: `/runs/${ids.run}/replay` });
    await instance.close();
    expect(response.statusCode).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it('returns the same not-found response for a missing or cross-tenant run', async () => {
    // Break caught: exposing whether a run exists outside the caller workspace through a distinct replay response.
    state.replayMissing = true;
    const instance = await app();
    const missing = await instance.inject({ method: 'GET', url: `/runs/${ids.run}/replay` });
    const foreign = await instance.inject({ method: 'GET', url: '/runs/00000000-0000-4000-8000-000000000099/replay' });
    await instance.close();
    expect(missing.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    expect(missing.json()).toEqual(foreign.json());
  });
});
