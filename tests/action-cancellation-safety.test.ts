import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  statements: [] as Array<{ sql: string; values: unknown[] }>,
}));

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    if (sql.includes('subject_allows_actions')) {
      return { rowCount: 1, rows: [{ subject_allows_actions: false }] };
    }
    return { rowCount: 0, rows: [] };
  }),
}));
vi.mock('../src/lib/crypto.js', () => ({
  decryptJsonWithContext: vi.fn(),
  encryptJsonWithContext: vi.fn(),
}));

import { authorizeAction, beginAction } from '../src/policy/action-gateway.js';

describe('action cancellation safety', () => {
  beforeEach(() => {
    state.statements = [];
  });

  it('does not create a new authorization after cancellation is requested', async () => {
    const result = await authorizeAction({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      subject: {
        type: 'task',
        taskId: '00000000-0000-4000-8000-000000000002',
        agentId: '00000000-0000-4000-8000-000000000003',
      },
      actionKey: 'provider-call',
      adapter: 'api',
      resourceId: '00000000-0000-4000-8000-000000000004',
      operation: 'send',
      riskLevel: 'write',
      arguments: {},
      requestedBy: '00000000-0000-4000-8000-000000000005',
      trace: {
        traceId: '00000000-0000-4000-8000-000000000006',
        spanId: '00000000-0000-4000-8000-000000000007',
        parentSpanId: null,
      },
    });

    expect(result).toMatchObject({ status: 'denied' });
    expect(state.statements.some(({ sql }) => sql.includes('INSERT INTO action_authorizations'))).toBe(false);
  });

  it('does not claim an approved authorization for a cancelling subject', async () => {
    await expect(beginAction('00000000-0000-4000-8000-000000000008')).resolves.toBe(false);
    const claim = state.statements.find(({ sql }) => sql.includes("SET status='executing'"));
    expect(claim?.sql).toContain('cancel_requested');
    expect(claim?.sql).toContain('cancelling');
  });
});
