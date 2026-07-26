import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  searchTrace: null as Record<string, unknown> | null,
  eventTraces: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('../src/knowledge/retrieval.js', () => ({
  searchWorkspaceKnowledge: vi.fn(async (
    _workspaceId: string,
    _search: string,
    _limit: number,
    trace?: Record<string, unknown>,
  ) => {
    state.searchTrace = trace ?? null;
    return [];
  }),
}));

import { executeKnowledgeSearchNode } from '../src/workflows/adapters/knowledge.js';

describe('knowledge operation traces', () => {
  it('uses one child span for search and its workflow events', async () => {
    const nodeTrace = {
      traceId: '00000000-0000-4000-8000-000000000001',
      spanId: '00000000-0000-4000-8000-000000000002',
      parentSpanId: '00000000-0000-4000-8000-000000000003',
    };
    await executeKnowledgeSearchNode({
      execution: { mode: 'test', manifest: null, trace: nodeTrace, signal: new AbortController().signal },
      run: { id: 'run', workspace_id: 'workspace' },
      node: { id: 'knowledge', type: 'knowledge', config: { query: 'trust runtime' } },
      resolve: (value: unknown) => value,
      emitEvent: async (_type, _message, _payload, trace) => {
        state.eventTraces.push(trace);
      },
      setNodeOutput: () => undefined,
    } as never);

    expect(state.searchTrace).toMatchObject({
      traceId: nodeTrace.traceId,
      parentSpanId: nodeTrace.spanId,
    });
    expect(state.eventTraces).toEqual([state.searchTrace, state.searchTrace]);
  });
});
