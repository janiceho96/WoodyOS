import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = {
  workspace: '00000000-0000-4000-8000-000000000001',
  otherWorkspace: '00000000-0000-4000-8000-000000000002',
  run: '00000000-0000-4000-8000-000000000003',
  trace: '00000000-0000-4000-8000-000000000004',
  workflowEvent: '00000000-0000-4000-8000-000000000005',
  taskEvent: '00000000-0000-4000-8000-000000000006',
  nodeState: '00000000-0000-4000-8000-000000000007',
  task: '00000000-0000-4000-8000-000000000011',
  outputDocument: '00000000-0000-4000-8000-000000000012',
  outputVersion: '00000000-0000-4000-8000-000000000013',
  candidateAgent: '00000000-0000-4000-8000-000000000014',
  candidateAgentVersion: '00000000-0000-4000-8000-000000000015',
  graderTask: '00000000-0000-4000-8000-000000000016',
  graderAgent: '00000000-0000-4000-8000-000000000017',
  graderAgentVersion: '00000000-0000-4000-8000-000000000018',
};
const instant = '2026-07-28T01:02:03.000Z';

const state = vi.hoisted(() => ({ statements: [] as Array<{ sql: string; values: unknown[] }>, includeAction: false, includeQuality: false, includeUsage: false, includeTaskError: false }));

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, values: unknown[] = []) => {
    state.statements.push({ sql, values });
    if (sql.includes('FROM workflow_runs')) return { rowCount: 1, rows: [{ id: ids.run, workspace_id: ids.workspace, trace_id: ids.trace, status: 'completed', created_at: instant, completed_at: instant, execution_manifest: { agents: {}, models: {} } }] };
    if (sql.includes('FROM workflow_run_events')) return { rowCount: 1, rows: [{ id: ids.workflowEvent, created_at: instant, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000008', parent_span_id: null, event_type: 'workflow.completed', message: 'authorization: Bearer top-secret', payload: { authorization: 'Bearer top-secret', safe: 'done' } }] };
    if (sql.includes('FROM workflow_run_node_states')) return { rowCount: 1, rows: [{ id: ids.nodeState, started_at: instant, completed_at: instant, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000009', parent_span_id: null, node_id: 'writer', iteration_key: 'root', attempt: 1, status: 'completed', error: null }] };
    if (sql.includes('FROM task_events')) return { rowCount: 1, rows: [{ id: ids.taskEvent, created_at: instant, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000010', parent_span_id: null, event_type: 'task.completed', message: 'Output stored', payload: state.includeTaskError ? { error: { code: 'RATE_LIMITED', category: 'rate_limited', retryable: true, message: 'Authorization: Bearer top-secret', details: { token: 'top-secret' } }, output: 'unrestricted output must not be replayed' } : { output: 'unrestricted output must not be replayed' }, title: 'Writer' }] };
    if (sql.includes('action_authorizations')) return { rowCount: state.includeAction ? 1 : 0, rows: state.includeAction ? [{ id: '00000000-0000-4000-8000-000000000019', requested_at: instant, resolved_at: null, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000020', parent_span_id: '00000000-0000-4000-8000-000000000010', subject_type: 'task', task_id: ids.task, workflow_run_id: null, node_id: null, iteration_key: null, attempt: null, adapter: 'api', operation: 'send', risk_level: 'external_write', target_summary: 'Bearer top-secret', status: 'approved', error_message: null, runtime_error: null }] : [] };
    if (sql.includes('quality_history_entries')) return { rowCount: state.includeQuality ? 1 : 0, rows: state.includeQuality ? [{ id: '00000000-0000-4000-8000-000000000021', sequence: 2, created_at: instant, trace_id: ids.trace, output_document_version_id: ids.outputVersion, output_document_id: ids.outputDocument, version_number: 7, candidate_task_id: ids.task, candidate_agent_id: ids.candidateAgent, candidate_agent_version_id: ids.candidateAgentVersion, grader_task_id: ids.graderTask, grader_agent_id: ids.graderAgent, grader_agent_version_id: ids.graderAgentVersion, grader_agent_version: 9, model_identity: 'openai:gpt-5', result: { passed: true, score: 96 }, exit_reason: null }] : [] };
    if (sql.includes('SELECT id,created_at,completed_at,trace_id') && sql.includes('FROM tasks')) return { rowCount: state.includeUsage ? 2 : 0, rows: state.includeUsage ? [{ id: ids.task, created_at: instant, completed_at: null, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000010', parent_span_id: null, title: 'Writer', status: 'running', agent_id: ids.candidateAgent, agent_version_id: ids.candidateAgentVersion, token_input: 0, token_output: 0, estimated_cost_usd: null, duration_ms: null, error: null }, { id: ids.graderTask, created_at: instant, completed_at: instant, trace_id: ids.trace, span_id: '00000000-0000-4000-8000-000000000022', parent_span_id: null, title: 'Grader', status: 'completed', agent_id: ids.graderAgent, agent_version_id: ids.graderAgentVersion, token_input: 4, token_output: 8, estimated_cost_usd: '0.025', duration_ms: 0, error: null }] : [] };
    return { rowCount: 0, rows: [] };
  }),
}));

import { getWorkflowReplay } from '../src/runtime/replay.js';

describe('workflow replay', () => {
  beforeEach(() => { state.statements = []; state.includeAction = false; state.includeQuality = false; state.includeUsage = false; state.includeTaskError = false; });

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

  it('includes child-task action authorizations without trusting a workflow_run_id on the authorization', async () => {
    // Break caught: replay omitting real task-owned tool approvals because their authorization workflow_run_id is null.
    state.includeAction = true;
    const replay = await getWorkflowReplay({ workspaceId: ids.workspace, runId: ids.run, role: 'member' });
    const authorization = replay!.events.find((event) => event.kind === 'action_authorization')!;
    expect(authorization).toMatchObject({ traceId: ids.trace, spanId: '00000000-0000-4000-8000-000000000020', parentSpanId: '00000000-0000-4000-8000-000000000010', status: 'approved', title: 'Action send' });
    expect(authorization.summary).toMatchObject({ adapter: 'api', operation: 'send', risk_level: 'external_write' });
    expect(authorization.summary).not.toHaveProperty('target');
    const authorizationQuery = state.statements.find(({ sql }) => sql.includes('action_authorizations'))?.sql ?? '';
    expect(authorizationQuery).toContain('authorization.task_id=child_task.id');
    expect(authorizationQuery).toContain('child_task.workflow_run_id=$1');
  });

  it('preserves immutable quality provenance and exact output-version identity', async () => {
    // Break caught: reducing a quality record to a score so the reviewed output and grader can no longer be identified.
    state.includeQuality = true;
    const replay = await getWorkflowReplay({ workspaceId: ids.workspace, runId: ids.run, role: 'member' });
    const quality = replay!.events.find((event) => event.kind === 'quality_history')!;
    expect(quality.summary).toMatchObject({ outputDocumentVersionId: ids.outputVersion, outputDocumentId: ids.outputDocument, outputVersionNumber: 7, candidateTaskId: ids.task, candidateAgentId: ids.candidateAgent, candidateAgentVersionId: ids.candidateAgentVersion, graderTaskId: ids.graderTask, graderAgentId: ids.graderAgent, graderAgentVersionId: ids.graderAgentVersion, graderAgentVersion: 9, graderModelIdentity: 'openai:gpt-5', passed: true, qualityScore: 96 });
  });

  it('keeps missing task durations and costs null while preserving numeric zero', async () => {
    // Break caught: Number(null) turning an in-flight task into a completed-looking zero-duration/cost record.
    state.includeUsage = true;
    const replay = await getWorkflowReplay({ workspaceId: ids.workspace, runId: ids.run, role: 'member' });
    const usage = replay!.events.filter((event) => event.kind === 'task_usage');
    expect(usage.map((event) => ({ durationMs: event.durationMs, costUsd: event.costUsd }))).toEqual([{ durationMs: null, costUsd: null }, { durationMs: 0, costUsd: 0.025 }]);
  });

  it('maps nested persisted task errors to a redacted structured recovery summary', async () => {
    // Break caught: losing the retry classification in task events or exposing nested error details/secrets.
    state.includeTaskError = true;
    const replay = await getWorkflowReplay({ workspaceId: ids.workspace, runId: ids.run, role: 'member' });
    const taskEvent = replay!.events.find((event) => event.kind === 'task_event')!;
    expect(taskEvent.summary).toMatchObject({ code: 'RATE_LIMITED', category: 'rate_limited', retryable: true, message: '[REDACTED]' });
    expect(JSON.stringify(taskEvent.summary)).not.toContain('top-secret');
    expect(JSON.stringify(taskEvent.summary)).not.toContain('details');
  });
});
