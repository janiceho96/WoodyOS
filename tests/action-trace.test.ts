import { beforeEach, describe, expect, it, vi } from 'vitest';
import { childTraceContext, createTraceContext } from '../src/runtime/trace.js';

const state = vi.hoisted(() => ({
  inserts: [] as Array<{ sql: string; values: unknown[] }>,
}));

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('INSERT INTO action_authorizations(')) {
      state.inserts.push({ sql, values });
      return { rowCount: 1, rows: [{ id: crypto.randomUUID() }] };
    }
    return { rowCount: 0, rows: [] };
  }),
}));

import { authorizeAction } from '../src/policy/action-gateway.js';

describe('action trace identity', () => {
  beforeEach(() => {
    state.inserts = [];
  });

  it('persists trace linkage without changing action or argument identity', async () => {
    const root = createTraceContext();
    const common = {
      workspaceId: '00000000-0000-4000-8000-000000000001',
      subject: {
        type: 'task' as const,
        taskId: '00000000-0000-4000-8000-000000000002',
        agentId: '00000000-0000-4000-8000-000000000003',
      },
      actionKey: 'provider-call-1',
      adapter: 'api' as const,
      resourceId: '00000000-0000-4000-8000-000000000004',
      operation: 'create_record',
      riskLevel: 'write' as const,
      arguments: { title: 'Quarterly plan' },
      requestedBy: '00000000-0000-4000-8000-000000000005',
    };

    await authorizeAction({ ...common, trace: childTraceContext(root) });
    await authorizeAction({ ...common, trace: childTraceContext(root) });

    expect(state.inserts).toHaveLength(2);
    expect(state.inserts[0].sql).toContain('trace_id');
    expect(state.inserts[0].values[8]).toBe('provider-call-1');
    expect(state.inserts[1].values[8]).toBe(state.inserts[0].values[8]);
    expect(state.inserts[1].values[15]).toBe(state.inserts[0].values[15]);
    expect(state.inserts[0].values).toContain(root.traceId);
    expect(state.inserts[1].values).toContain(root.traceId);
  });
});
