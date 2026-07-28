import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = {
  workspace: '00000000-0000-4000-8000-000000000001',
  run: '00000000-0000-4000-8000-000000000002',
  candidateTask: '00000000-0000-4000-8000-000000000003',
  graderTask: '00000000-0000-4000-8000-000000000004',
  candidateAgentVersion: '00000000-0000-4000-8000-000000000005',
  graderAgentVersion: '00000000-0000-4000-8000-000000000006',
  outputVersion: '00000000-0000-4000-8000-000000000007',
  currentOutputVersion: '00000000-0000-4000-8000-000000000015',
  trace: '00000000-0000-4000-8000-000000000008',
  entry: '00000000-0000-4000-8000-000000000009',
};

const state = vi.hoisted(() => ({
  order: [] as string[],
  appendInput: null as Record<string, unknown> | null,
  candidateDocument: null as Record<string, unknown> | null,
}));

function currentCandidateDocument() {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    workspace_id: ids.workspace,
    task_id: ids.candidateTask,
    current_version_number: 3,
    created_by: null,
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    currentVersion: {
      id: ids.currentOutputVersion,
      workspace_id: ids.workspace,
      document_id: '00000000-0000-4000-8000-000000000010',
      version_number: 3,
      content: 'Human-revised candidate',
      content_hash: 'c'.repeat(64),
      created_by: null,
      created_at: '2026-07-27T00:00:00.000Z',
    },
    versions: [],
  };
}

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
}));
vi.mock('../src/quality/history.js', async () => {
  const actual = await vi.importActual<typeof import('../src/quality/history.js')>('../src/quality/history.js');
  return {
    ...actual,
    appendQualityHistoryEntry: vi.fn(async (input: Record<string, unknown>) => {
      state.order.push('append');
      state.appendInput = input;
      return {
        id: ids.entry,
        ...input,
        createdAt: '2026-07-27T00:00:00.000Z',
      };
    }),
  };
});
vi.mock('../src/outputs/service.js', () => ({
  getTaskOutputDocument: vi.fn(async () => state.candidateDocument),
  initializeTaskOutputDocument: vi.fn(async () => {
    state.order.push('initialize');
    return currentCandidateDocument();
  }),
}));

import { executeLogicNode } from '../src/workflows/adapters/logic.js';

function context(input: { candidateIdentity?: boolean; leaseOwnerId?: string } = {}) {
  const run = {
    id: ids.run,
    workspace_id: ids.workspace,
    workflow_id: '00000000-0000-4000-8000-000000000011',
    input: {},
    definition_snapshot: { nodes: [], edges: [] },
    state: {
      nodes: {
        worker: { text: 'Candidate' },
        grader: { data: { passed: true, score: 91, feedback: [], criteria: [] } },
      },
      agentExecutionIdentities: {
        ...(input.candidateIdentity === false ? {} : {
          worker: {
            taskId: ids.candidateTask,
            agentVersionId: ids.candidateAgentVersion,
            outputDocumentVersionId: ids.outputVersion,
            modelIdentity: 'candidate-model',
            output: { text: 'Candidate' },
          },
        }),
        grader: {
          taskId: ids.graderTask,
          agentVersionId: ids.graderAgentVersion,
          outputDocumentVersionId: '00000000-0000-4000-8000-000000000012',
          modelIdentity: `openai-compatible:gpt-5:${'b'.repeat(64)}:${ids.graderAgentVersion}:runtime-4`,
          output: { data: { passed: true, score: 91, feedback: [], criteria: [] } },
        },
      },
    } as Record<string, unknown>,
    cursor: { nodeId: 'quality_loop', loops: { quality_loop: { iteration: 1 } }, attempt: 1 },
    step_count: 3,
    run_mode: 'production' as const,
    execution_manifest: null,
    trace_id: ids.trace,
    span_id: '00000000-0000-4000-8000-000000000013',
    parent_span_id: null,
    name: 'Quality',
    created_by: '00000000-0000-4000-8000-000000000014',
  };
  const node = {
    id: 'quality_loop',
    type: 'loop' as const,
    config: {
      mode: 'while',
      maxIterations: 3,
      passingScore: 80,
      onLimit: 'exit',
      quality: {
        graderNodeId: 'grader',
        workerNodeId: 'worker',
        revisionNodeId: 'revision_agent',
      },
    },
  };
  return {
    execution: {
      mode: 'production' as const,
      manifest: {} as never,
      trace: {
        traceId: ids.trace,
        spanId: run.span_id,
        parentSpanId: null,
      },
      signal: new AbortController().signal,
      leaseOwnerId: input.leaseOwnerId ?? 'worker-owner',
    },
    run,
    node,
    cursor: run.cursor,
    iterationKey: 'quality_loop:1',
    executeAgentTask: async () => null,
    emitEvent: async () => undefined,
    resolve: (value: unknown) => value,
    setNodeOutput: (value: unknown) => {
      state.order.push('state');
      run.state[node.id] = value;
    },
  };
}

describe('quality-loop durable history', () => {
  beforeEach(() => {
    state.order = [];
    state.appendInput = null;
    state.candidateDocument = currentCandidateDocument();
  });

  it('inserts the exact durable grade before materializing and advancing loop state', async () => {
    const adapterContext = context();
    const execution = await executeLogicNode(adapterContext);

    expect(execution.result).toBe('done');
    expect(state.order).toEqual(['append', 'state']);
    expect(state.appendInput).toMatchObject({
      workspaceId: ids.workspace,
      workflowRunId: ids.run,
      sequence: 1,
      automatedRevision: 0,
      manualRevision: 2,
      candidateTaskId: ids.candidateTask,
      outputDocumentVersionId: ids.currentOutputVersion,
      candidateHash: 'c'.repeat(64),
      graderTaskId: ids.graderTask,
      graderAgentVersionId: ids.graderAgentVersion,
      exitReason: 'quality_passed',
      traceId: ids.trace,
      leaseOwnerId: 'worker-owner',
    });
    expect(adapterContext.run.state.nodes).toEqual({
      worker: { text: 'Candidate' },
      grader: { data: { passed: true, score: 91, feedback: [], criteria: [] } },
    });
    expect(adapterContext.run.state.qualityHistory).toEqual({
      quality_loop: {
        entryIds: [ids.entry],
        current: {
          entryId: ids.entry,
          iteration: 1,
          automatedRevision: 0,
          manualRevision: 2,
          candidate: { text: 'Candidate' },
          verdict: { passed: true, score: 91, feedback: [], criteria: [] },
          revisionAgentNodeId: 'worker',
        },
      },
    });
  });

  it('fails nonretryably before state advancement when the candidate has no version identity', async () => {
    const adapterContext = context({ candidateIdentity: false });

    await expect(executeLogicNode(adapterContext)).rejects.toMatchObject({
      code: 'QUALITY_CANDIDATE_VERSION_REQUIRED',
      retryable: false,
    });
    expect(state.order).toEqual([]);
    expect(adapterContext.run.state.qualityHistory).toBeUndefined();
  });

  it('initializes a missing candidate document before appending the grade', async () => {
    state.candidateDocument = null;
    const adapterContext = context();

    await executeLogicNode(adapterContext);

    expect(state.order).toEqual(['initialize', 'append', 'state']);
    expect(state.appendInput).toMatchObject({
      outputDocumentVersionId: ids.currentOutputVersion,
      candidateHash: 'c'.repeat(64),
    });
  });

  it('reconfirms durable history when a retry carries a materialized current entry', async () => {
    const adapterContext = context();
    adapterContext.run.state.qualityHistory = {
      quality_loop: {
        entryIds: [ids.entry],
        current: {
          entryId: ids.entry,
          iteration: 1,
          automatedRevision: 0,
          manualRevision: 2,
          candidate: { text: 'Candidate' },
          verdict: { passed: true, score: 91, feedback: [], criteria: [] },
          revisionAgentNodeId: 'worker',
        },
      },
    };

    await executeLogicNode(adapterContext);

    expect(state.order).toEqual(['append', 'state']);
  });
});
