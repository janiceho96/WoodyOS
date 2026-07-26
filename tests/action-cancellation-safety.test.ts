import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  statements: [] as Array<{ sql: string; values: unknown[] }>,
  subjectAllowsActions: false,
}));

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    if (sql.includes('subject_allows_actions')) {
      return { rowCount: 1, rows: [{ subject_allows_actions: state.subjectAllowsActions }] };
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
    state.subjectAllowsActions = false;
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

  it('atomically rejects authorization and execution claims from a former lease owner', async () => {
    state.subjectAllowsActions = true;
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
      leaseOwnerId: 'former-owner',
      trace: {
        traceId: '00000000-0000-4000-8000-000000000006',
        spanId: '00000000-0000-4000-8000-000000000007',
        parentSpanId: null,
      },
    });
    await beginAction('00000000-0000-4000-8000-000000000008', 'former-owner');

    expect(result).toMatchObject({ status: 'denied' });
    const subjectGuard = state.statements.find(({ sql }) => sql.includes('subject_allows_actions'));
    const claim = state.statements.find(({ sql }) => sql.includes("SET status='executing'"));
    expect(subjectGuard?.sql).toContain('execution_leases');
    expect(subjectGuard?.sql).toContain('owner_id');
    expect(claim?.sql).toContain('execution_leases');
    expect(claim?.values).toContain('former-owner');
  });
});
