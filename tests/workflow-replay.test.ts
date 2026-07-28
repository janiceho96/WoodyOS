import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = {
  workspace: '00000000-0000-4000-8000-000000000001',
  otherWorkspace: '00000000-0000-4000-8000-000000000002',
  run: '00000000-0000-4000-8000-000000000003',
  trace: '00000000-0000-4000-8000-000000000004',
  workflowEvent: '00000000-0000-4000-8000-000000000005',
  taskEvent: '00000000-0000-4000-8000-000000000006',
  nodeState: '00000000-0000-4000-8000-000000000007',
};
const instant = '2026-07-28T01:02:03.000Z';

const state = vi.hoisted(() => ({ statements: [] as Array<{ sql: string; values: unknown[] }>, includeAction: false }));

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    if (sql.includes('FROM workflow_runs')) return { rowCount: 1, rows: [{ id: ids.run, workspace_id: ids.workspace, trace_id: ids.trace, status: 'completed', created_at: instant, completed_at: instant, execution_manifest: { agents: {}, models: {} } }] };
    if (sql.includes('FROM workflow_run_events')) return { rowCount: 1, rows: [{ id: ids.workflowEvent, created_at: instant, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000008', parent_span_id: null, event_type: 'workflow.completed', message: 'authorization: Bearer top-secret', payload: { authorization: 'Bearer top-secret', safe: 'done' } }] };
    if (sql.includes('FROM workflow_run_node_states')) return { rowCount: 1, rows: [{ id: ids.nodeState, started_at: instant, completed_at: instant, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000009', parent_span_id: null, node_id: 'writer', iteration_key: 'root', attempt: 1, status: 'completed', error: null }] };
    if (sql.includes('FROM task_events')) return { rowCount: 1, rows: [{ id: ids.taskEvent, created_at: instant, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000010', parent_span_id: null, event_type: 'task.completed', message: 'Output stored', payload: { output: 'unrestricted output must not be replayed' }, title: 'Writer' }] };
    if (sql.includes('FROM action_authorizations')) return { rowCount: state.includeAction ? 1 : 0, rows: state.includeAction ? [{ id: '00000000-0000-4000-8000-000000000013', requested_at: instant, resolved_at: null, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000014', parent_span_id: null, node_id: 'notify', iteration_key: 'root', attempt: 1, adapter: 'api', operation: 'send', risk_level: 'external_write', target_summary: 'Bearer top-secret', status: 'approved', error_message: null, runtime_error: null }] : [] };
    return { rowCount: 0, rows: [] };
  }),
}));

import { getWorkflowReplay } from '../src/runtime/replay.js';

describe('workflow replay', () => {
  beforeEach(() => { state.statements = []; state.includeAction = false; });

  it('orders same-time trace history deterministically and redacts public summaries', async () => {
    // Break caught: returning source query order/raw persisted payloads rather than a stable, trace-safe history.
    const replay = await getWorkflowReplay({ workspaceId: ids.workspace, runId: ids.run, role: 'member' });

    expect(replay.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(replay.events.map((event) => event.traceId)).toEqual([ids.trace, ids.trace, ids.trace]);
    expect(replay.events.map((event) => event.kind)).toEqual(['workflow_event', 'node_state', 'task_event']);
    expect(JSON.stringify(replay)).not.toContain('top-secret');
    expect(JSON.stringify(replay)).not.toContain('unrestricted output');
    expect(replay.events[0]?.summary).toEqual({});
    expect(state.statements.every(({ sql }) => /^\s*SELECT\b/i.test(sql))).toBe(true);
  });

  it('withholds action targets from members and redacts them for administrators', async () => {
    // Break caught: displaying an action target to every member or returning a secret-bearing target unredacted.
    state.includeAction = true;
    const member = await getWorkflowReplay({ workspaceId: ids.workspace, runId: ids.run, role: 'member' });
    const administrator = await getWorkflowReplay({ workspaceId: ids.workspace, runId: ids.run, role: 'admin' });
    const memberAction = member!.events.find((item) => item.kind === 'action_authorization')!;
    const adminAction = administrator!.events.find((item) => item.kind === 'action_authorization')!;
    expect(memberAction.summary).not.toHaveProperty('target');
    expect(adminAction.summary.target).toBe('Bearer [REDACTED]');
  });
});
