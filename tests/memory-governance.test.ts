import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryRoutes } from '../src/routes/memories.js';
import {
  MemoryServiceError,
  confirmMemory,
  createMemory,
  deleteMemory,
  disputeMemory,
  expireMemory,
  listEligibleMemories,
  claimAgentMemoriesForPrompt,
  retrieveAgentMemories,
  supersedeMemory,
} from '../src/memories/service.js';
import { rankMemoryCandidate } from '../src/memories/ranking.js';
import type { MemoryRecord } from '../src/memories/types.js';

const workspaceId = '22222222-2222-4222-8222-222222222222';
const userId = '11111111-1111-4111-8111-111111111111';
const agentId = '33333333-3333-4333-8333-333333333333';

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(async (sql?: string, values?: unknown[]) => {
    if (String(sql).includes('FROM agents')) return { rowCount: 1, rows: [{ id: agentId }] };
    if (String(sql).includes('INSERT INTO memories')) {
      return {
        rowCount: 1,
        rows: [{
          id: '44444444-4444-4444-8444-444444444444', workspace_id: values?.[0], agent_id: values?.[1], user_id: values?.[2],
          kind: values?.[3], content: values?.[4], importance: values?.[5], metadata: values?.[6], memory_type: values?.[7],
          scope: values?.[8], source_type: values?.[9], source_id: values?.[10], confidence: values?.[11],
          verification_status: values?.[12], expires_at: values?.[13] ?? null, superseded_by: null, last_accessed_at: null,
          access_count: 0, created_at: new Date('2026-07-26T00:00:00.000Z'), updated_at: new Date('2026-07-26T00:00:00.000Z'),
        }],
      };
    }
    return { rowCount: 1, rows: [] };
  }),
}));

vi.mock('../src/db/client.js', () => ({
  db: { connect: state.connect },
  query: state.query,
}));

function memoryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444', workspace_id: workspaceId, agent_id: agentId, user_id: userId,
    kind: 'knowledge', content: 'The customer prefers weekly reports', importance: 0.5, metadata: {}, memory_type: 'hypothesis',
    scope: 'agent', source_type: 'agent', source_id: agentId, confidence: 0.5, verification_status: 'agent_inferred',
    expires_at: null, superseded_by: null, last_accessed_at: null, access_count: 0,
    created_at: new Date('2026-07-26T00:00:00.000Z'), updated_at: new Date('2026-07-26T00:00:00.000Z'),
    ...overrides,
  };
}

function rankableMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: '44444444-4444-4444-8444-444444444444', workspaceId, agentId, userId,
    kind: 'knowledge', content: 'The customer prefers weekly reports', importance: 0.5, metadata: {},
    memoryType: 'hypothesis', scope: 'agent', sourceType: 'agent', sourceId: agentId,
    confidence: 0.5, verificationStatus: 'agent_inferred', expiresAt: null, supersededBy: null,
    lastAccessedAt: null, accessCount: 0,
    createdAt: new Date('2026-07-26T00:00:00.000Z'), updatedAt: new Date('2026-07-26T00:00:00.000Z'),
    ...overrides,
  };
}

async function routeApp() {
  const app = Fastify();
  app.decorate('authenticate', async () => undefined);
  app.decorate('authorize', async () => undefined);
  app.addHook('preHandler', async (request) => {
    request.user = { sub: userId, workspaceId, email: 'member@example.test' };
  });
  await memoryRoutes(app);
  return app;
}

describe('governed memories', () => {
  beforeEach(() => {
    state.query.mockClear();
    state.connect.mockReset();
  });

  it('accepts an agent-inferred governed payload without requiring legacy kind', async () => {
    const app = await routeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: {
        agentId,
        type: 'hypothesis',
        scope: 'agent',
        content: 'The customer prefers weekly reports',
        source: { type: 'agent', id: agentId },
        verificationStatus: 'agent_inferred',
      },
    });
    await app.close();

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({
      verification_status: 'agent_inferred',
      memory_type: 'hypothesis',
      kind: 'knowledge',
    });
  });

  it('continues to accept and return the legacy kind payload during the compatibility release', async () => {
    const app = await routeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { agentId, kind: 'conversation', content: 'Discussed weekly reports' },
    });
    await app.close();

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ kind: 'conversation', memory_type: 'summary' });
  });

  it('returns provenance and lifecycle fields without exposing the embedding vector', async () => {
    state.query.mockResolvedValueOnce({ rowCount: 1, rows: [memoryRow({ embedding: '[secret-vector]' })] });
    const app = await routeApp();
    const response = await app.inject({ method: 'GET', url: '/' });
    await app.close();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data[0]).toMatchObject({ source_type: 'agent', verification_status: 'agent_inferred' });
    expect(response.body).not.toMatch(/embedding|secret-vector/i);
  });

  it('does not allow an agent inference to auto-promote itself to user confirmed', async () => {
    await expect(createMemory({
      workspaceId,
      agentId,
      type: 'hypothesis',
      content: 'The customer prefers weekly reports',
      source: { type: 'agent', id: agentId },
      verificationStatus: 'user_confirmed',
      actor: { type: 'agent', id: agentId },
    })).rejects.toMatchObject({ message: 'USER_CONFIRMATION_REQUIRED', statusCode: 403 });
  });

  it.each(['disputed', 'superseded'] as const)('rejects terminal %s status at the public creation boundary', async (verificationStatus) => {
    const app = await routeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/',
      payload: { agentId, type: 'fact', content: 'Terminal lifecycle bypass', verificationStatus },
    });
    await app.close();

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it.each(['disputed', 'superseded'] as const)('rejects terminal %s status when service callers bypass the route', async (verificationStatus) => {
    await expect(createMemory({
      workspaceId,
      type: 'fact',
      content: 'Terminal lifecycle bypass',
      verificationStatus,
      actor: { type: 'user', id: userId },
    })).rejects.toMatchObject({ message: 'TERMINAL_VERIFICATION_STATUS', statusCode: 400 });
  });

  it('guards confirmation and disputes by workspace and authenticated actor', async () => {
    state.query.mockResolvedValueOnce({ rowCount: 1, rows: [memoryRow({ verification_status: 'user_confirmed' })] });
    const confirmed = await confirmMemory({ workspaceId, memoryId: memoryRow().id, actorId: userId });
    expect(confirmed.verificationStatus).toBe('user_confirmed');
    expect(state.query.mock.calls[0][0]).toContain('workspace_memberships');

    state.query.mockResolvedValueOnce({ rowCount: 1, rows: [memoryRow({ verification_status: 'disputed' })] });
    const disputed = await disputeMemory({ workspaceId, memoryId: memoryRow().id, actorId: userId });
    expect(disputed.verificationStatus).toBe('disputed');
  });

  it('expires and deletes only within the requested workspace', async () => {
    state.query.mockResolvedValueOnce({ rowCount: 1, rows: [memoryRow({ expires_at: new Date('2026-07-26T00:00:00.000Z') })] });
    const expired = await expireMemory({ workspaceId, memoryId: memoryRow().id, now: new Date('2026-07-26T00:00:00.000Z') });
    expect(expired.expiresAt).toEqual(new Date('2026-07-26T00:00:00.000Z'));
    expect(state.query.mock.calls[0][1]).toContain(workspaceId);

    state.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(deleteMemory({ workspaceId: '55555555-5555-4555-8555-555555555555', memoryId: memoryRow().id }))
      .rejects.toBeInstanceOf(MemoryServiceError);
    expect(state.query.mock.calls[1][1]).toEqual([memoryRow().id, '55555555-5555-4555-8555-555555555555']);
  });

  it('lists only eligible memory and never selects an embedding vector', async () => {
    state.query.mockResolvedValueOnce({ rowCount: 1, rows: [memoryRow({ embedding: '[secret-vector]' })] });
    const memories = await listEligibleMemories({ workspaceId, agentId, now: new Date('2026-07-26T00:00:00.000Z') });
    expect(memories).toHaveLength(1);
    const [sql, values] = state.query.mock.calls[0];
    expect(sql).toContain("verification_status NOT IN ('disputed','superseded')");
    expect(sql).toContain('(expires_at IS NULL OR expires_at > $2)');
    expect(sql).not.toMatch(/embedding/i);
    expect(values).toContain(workspaceId);
    expect(values).toContain(agentId);
  });

  it('supersedes under row locks in a single transaction', async () => {
    const oldId = memoryRow().id;
    const replacementId = '66666666-6666-4666-8666-666666666666';
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
        if (sql.includes('id=ANY')) return { rowCount: 2, rows: [memoryRow(), memoryRow({ id: replacementId })] };
        if (sql.includes('WITH RECURSIVE')) return { rowCount: 1, rows: [{ cycle: false }] };
        return { rowCount: 1, rows: [memoryRow({ verification_status: 'superseded', superseded_by: replacementId })] };
      }),
      release: vi.fn(),
    };
    state.connect.mockResolvedValueOnce(client);

    const result = await supersedeMemory({ workspaceId, memoryId: oldId, replacementMemoryId: replacementId });

    expect(result.memory.verificationStatus).toBe('superseded');
    expect(result.memory.supersededBy).toBe(replacementId);
    expect(statements).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(statements.filter((statement) => statement.includes('FOR UPDATE'))).toHaveLength(1);
    expect(statements.indexOf('COMMIT')).toBeGreaterThan(statements.findIndex((statement) => statement.startsWith('UPDATE')));
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    ['disputed', null],
    ['superseded', null],
    ['agent_inferred', new Date('2026-07-25T00:00:00.000Z')],
  ] as const)('rejects a %s existing replacement that is not eligible', async (verificationStatus, expiresAt) => {
    const replacementId = '66666666-6666-4666-8666-666666666666';
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
        if (sql.includes('id=ANY')) return { rowCount: 2, rows: [memoryRow(), memoryRow({ id: replacementId, verification_status: verificationStatus, expires_at: expiresAt })] };
        if (sql.startsWith('SELECT') && sql.includes("verification_status <> 'superseded'")) return { rowCount: 1, rows: [memoryRow()] };
        if (sql.startsWith('SELECT')) return { rowCount: 1, rows: [memoryRow({ id: replacementId, verification_status: verificationStatus, expires_at: expiresAt })] };
        return { rowCount: 1, rows: [memoryRow({ verification_status: 'superseded', superseded_by: replacementId })] };
      }),
      release: vi.fn(),
    };
    state.connect.mockResolvedValueOnce(client);

    await expect(supersedeMemory({ workspaceId, memoryId: memoryRow().id, replacementMemoryId: replacementId }))
      .rejects.toMatchObject({ message: 'REPLACEMENT_NOT_ELIGIBLE', statusCode: 409 });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rejects an existing replacement whose supersession ancestry reaches the source', async () => {
    const sourceId = memoryRow().id;
    const replacementId = '66666666-6666-4666-8666-666666666666';
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
        if (sql.includes('WITH RECURSIVE')) return { rowCount: 1, rows: [{ cycle: true }] };
        if (sql.includes('id=ANY')) return { rowCount: 2, rows: [memoryRow(), memoryRow({ id: replacementId, superseded_by: sourceId })] };
        if (sql.startsWith('SELECT') && sql.includes("verification_status <> 'superseded'")) return { rowCount: 1, rows: [memoryRow()] };
        if (sql.startsWith('SELECT')) return { rowCount: 1, rows: [memoryRow({ id: replacementId, superseded_by: sourceId })] };
        return { rowCount: 1, rows: [memoryRow({ verification_status: 'superseded', superseded_by: replacementId })] };
      }),
      release: vi.fn(),
    };
    state.connect.mockResolvedValueOnce(client);

    await expect(supersedeMemory({ workspaceId, memoryId: sourceId, replacementMemoryId: replacementId }))
      .rejects.toMatchObject({ message: 'MEMORY_SUPERSESSION_CYCLE', statusCode: 409 });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('locks existing source and replacement IDs once in deterministic order', async () => {
    const lowId = memoryRow().id;
    const highId = '66666666-6666-4666-8666-666666666666';
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
        if (sql.includes('id=ANY')) return { rowCount: 2, rows: [memoryRow(), memoryRow({ id: highId })] };
        if (sql.includes('WITH RECURSIVE')) return { rowCount: 1, rows: [{ cycle: false }] };
        return { rowCount: 1, rows: [memoryRow({ id: highId, verification_status: 'superseded', superseded_by: lowId })] };
      }),
      release: vi.fn(),
    };
    state.connect.mockResolvedValueOnce(client);

    await supersedeMemory({ workspaceId, memoryId: highId, replacementMemoryId: lowId });

    const lockCall = client.query.mock.calls.find(([sql]) => String(sql).includes('id=ANY'));
    expect(lockCall).toBeDefined();
    expect(lockCall?.[0]).toContain('ORDER BY id FOR UPDATE');
    expect(lockCall?.[1]).toEqual([workspaceId, [lowId, highId]]);
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('FOR UPDATE'))).toHaveLength(1);
  });

  it('rejects a replacement that targets an agent outside the workspace', async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
        if (sql.startsWith('SELECT') && sql.includes("verification_status <> 'superseded'")) return { rowCount: 1, rows: [memoryRow()] };
        if (sql.includes('FROM agents')) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [memoryRow()] };
      }),
      release: vi.fn(),
    };
    state.connect.mockResolvedValueOnce(client);

    await expect(supersedeMemory({
      workspaceId,
      memoryId: memoryRow().id,
      replacement: { agentId, type: 'fact', content: 'Replacement fact' },
    })).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND', statusCode: 404 });
    expect(statements).toContain('ROLLBACK');
    expect(statements.some((statement) => statement.includes('INSERT INTO memories'))).toBe(false);
  });

  it('uses the documented normalized weights and clamps out-of-range ranking signals', () => {
    const candidate = rankableMemory({
      sourceType: 'user', confidence: 2, importance: -2, createdAt: new Date('2026-07-26T00:00:00.000Z'),
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    expect(rankMemoryCandidate(candidate, {
      workspaceId,
      agentId,
      userId,
      query: 'weekly reports',
      semanticRelevance: 0.5,
      now: new Date('2026-07-26T00:00:00.000Z'),
    })).toBeCloseTo(0.7, 8);
  });

  it('assigns zero rank to disputed or confirmed-only agent-inferred candidates', () => {
    const context = {
      workspaceId,
      agentId,
      userId,
      query: 'weekly reports',
      semanticRelevance: 1,
      now: new Date('2026-07-26T00:00:00.000Z'),
    };
    const confirmed = rankableMemory({ verificationStatus: 'user_confirmed', sourceType: 'user' });

    expect(rankMemoryCandidate(confirmed, context)).toBeGreaterThan(rankMemoryCandidate(
      rankableMemory({ verificationStatus: 'disputed' }), context,
    ));
    expect(rankMemoryCandidate(rankableMemory({ verificationStatus: 'agent_inferred' }), {
      ...context,
      confirmedOnly: true,
    })).toBe(0);
  });

  it('filters candidates to the tenant and exact agent or user scope before ranking', async () => {
    state.query.mockResolvedValueOnce({
      rowCount: 4,
      rows: [
        memoryRow({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', scope: 'workspace', verification_status: 'user_confirmed' }),
        memoryRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', scope: 'agent', agent_id: '99999999-9999-4999-8999-999999999999', verification_status: 'user_confirmed' }),
        memoryRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scope: 'user', user_id: '88888888-8888-4888-8888-888888888888', verification_status: 'user_confirmed' }),
        memoryRow({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', workspace_id: '77777777-7777-4777-8777-777777777777', scope: 'workspace', verification_status: 'user_confirmed' }),
      ],
    });
    const results = await retrieveAgentMemories({ workspaceId, agentId, userId, query: 'weekly reports', limit: 8 });

    expect(results.map((item) => item.id)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    const [sql, values] = state.query.mock.calls[0];
    expect(sql).toContain("scope='workspace'");
    expect(sql).toContain("scope='agent'");
    expect(sql).toContain("scope='user'");
    expect(values).toEqual(expect.arrayContaining([workspaceId, agentId, userId]));
  });

  it('excludes agent-inferred memory in confirmed-only mode before selection', async () => {
    state.query.mockResolvedValueOnce({
      rowCount: 2,
      rows: [
        memoryRow({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', scope: 'workspace', verification_status: 'agent_inferred' }),
        memoryRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', scope: 'workspace', verification_status: 'user_confirmed' }),
      ],
    });
    const results = await retrieveAgentMemories({
      workspaceId, agentId, userId, query: 'weekly reports', limit: 8, confirmedOnly: true,
    });

    expect(results.map((item) => item.id)).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    expect(state.query.mock.calls[0][0]).toContain("verification_status <> 'agent_inferred'");
  });

  it('uses deterministic score and ID ordering without accounting candidates before prompt inclusion', async () => {
    state.query.mockResolvedValueOnce({
      rowCount: 3,
      rows: [
        memoryRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', scope: 'workspace', verification_status: 'user_confirmed' }),
        memoryRow({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', scope: 'workspace', verification_status: 'user_confirmed' }),
        memoryRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', scope: 'workspace', verification_status: 'user_confirmed' }),
      ],
    });
    const results = await retrieveAgentMemories({ workspaceId, agentId, userId, query: 'unrelated', limit: 2 });

    expect(results.map((item) => item.id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
    expect(state.query).toHaveBeenCalledTimes(1);
  });

  it('claims only still-eligible final prompt memories atomically', async () => {
    const selected = [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'Weekly reports', memoryType: 'preference' as const,
      scope: 'workspace' as const, verificationStatus: 'user_confirmed' as const, score: 0.9,
    }];
    state.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(claimAgentMemoriesForPrompt({ workspaceId, agentId, userId, selected, confirmedOnly: true }))
      .resolves.toEqual([]);

    const [sql, values] = state.query.mock.calls[0];
    expect(sql).toMatch(/access_count=access_count\+1/);
    expect(sql).toContain("verification_status <> 'agent_inferred'");
    expect(sql).toContain("scope='agent'");
    expect(values).toEqual(expect.arrayContaining([workspaceId, agentId, userId]));
    expect(values[0]).toEqual([selected[0].id]);
  });

  it('returns fresh content from the atomic claim rather than stale selected content', async () => {
    const selected = [{
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content: 'Stale content', memoryType: 'preference' as const,
      scope: 'workspace' as const, verificationStatus: 'user_confirmed' as const, score: 0.9,
    }];
    state.query.mockResolvedValueOnce({ rowCount: 1, rows: [memoryRow({
      id: selected[0].id, content: 'Fresh content', scope: 'workspace', verification_status: 'user_confirmed',
    })] });

    await expect(claimAgentMemoriesForPrompt({ workspaceId, agentId, userId, selected }))
      .resolves.toMatchObject([{ content: 'Fresh content' }]);
  });

  it('paginates eligible candidates so an older high-trust memory can beat the first 100', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => memoryRow({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      scope: 'workspace', source_type: 'agent', verification_status: 'agent_inferred',
      content: 'unrelated', importance: 0, confidence: 0,
    }));
    const olderWinner = memoryRow({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', scope: 'workspace', source_type: 'user',
      verification_status: 'user_confirmed', content: 'weekly reports', importance: 1, confidence: 1,
      created_at: new Date('2026-04-26T00:00:00.000Z'),
    });
    state.query.mockResolvedValueOnce({ rowCount: 101, rows: [...firstPage, olderWinner] });

    const results = await retrieveAgentMemories({ workspaceId, agentId, userId, query: 'weekly reports', limit: 1 });

    expect(results.map((item) => item.id)).toEqual([olderWinner.id]);
    expect(state.query).toHaveBeenCalledTimes(1);
    expect(state.query.mock.calls[0][0]).toContain('ts_rank');
  });

  it('uses a database scalar similarity when a query embedding is supplied without selecting vectors', async () => {
    state.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await retrieveAgentMemories({ workspaceId, agentId, userId, query: 'weekly reports', queryEmbedding: [0.1, 0.2] });

    const [sql, values] = state.query.mock.calls[0];
    expect(sql).toContain('embedding <=>');
    expect(sql).not.toMatch(/,embedding(?:,|\s+FROM)/i);
    expect(values).toContain('[0.1,0.2]');
  });

  it('does not let an agent actor forge user source authority', async () => {
    state.query.mockResolvedValueOnce({ rowCount: 1, rows: [memoryRow()] });
    const memory = await createMemory({
      workspaceId, agentId, type: 'hypothesis', content: 'Forged provenance',
      source: { type: 'user', id: userId }, actor: { type: 'agent', id: agentId },
    });

    expect(memory.sourceType).toBe('agent');
    expect(memory.sourceId).toBe(agentId);
    expect(memory.metadata).toMatchObject({ provenance: { type: 'user', id: userId } });
  });
});
