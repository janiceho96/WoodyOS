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
  candidateVersion: null as Record<string, unknown> | null,
  currentDocumentReads: 0,
}));

function evaluatedCandidateVersion() {
  return {
    id: ids.outputVersion,
    workspace_id: ids.workspace,
    document_id: '00000000-0000-4000-8000-000000000010',
    version_number: 1,
    content: 'Candidate evaluated by the grader',
    content_hash: 'a'.repeat(64),
    created_by: null,
    created_at: '2026-07-27T00:00:00.000Z',
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
  getOutputDocumentVersion: vi.fn(async () => state.candidateVersion),
  getTaskOutputDocument: vi.fn(async () => {
    state.currentDocumentReads += 1;
    return {
      currentVersion: {
        id: ids.currentOutputVersion,
        content_hash: 'c'.repeat(64),
        version_number: 3,
      },
    };
  }),
}));

import { executeLogicNode } from '../src/workflows/adapters/logic.js';

function context(input: {
  candidateIdentity?: boolean;
  graderIdentity?: boolean;
  graderIdentityOutput?: Record<string, unknown>;
  graderStateVerdict?: Record<string, unknown>;
  storedIdentities?: boolean;
  identitySchemaVersion?: boolean;
  compatibility?: 'exact' | 'legacy_partial';
  mode?: 'production' | 'test';
  leaseOwnerId?: string;
} = {}) {
  const graderStateVerdict = input.graderStateVerdict ?? { passed: true, score: 91, feedback: [], criteria: [] };
  const graderIdentityOutput = input.graderIdentityOutput ?? { data: graderStateVerdict };
  const mode = input.mode ?? 'production';
  const run = {
    id: ids.run,
    workspace_id: ids.workspace,
    workflow_id: '00000000-0000-4000-8000-000000000011',
    input: {},
    definition_snapshot: { nodes: [], edges: [] },
    state: {
      nodes: {
        worker: { text: 'Candidate' },
        grader: { data: graderStateVerdict },
      },
      ...(input.identitySchemaVersion === false ? {} : { agentExecutionIdentitySchemaVersion: 1 }),
      ...(input.storedIdentities === false ? {} : {
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
          ...(input.graderIdentity === false ? {} : { grader: {
          taskId: ids.graderTask,
          agentVersionId: ids.graderAgentVersion,
          outputDocumentVersionId: '00000000-0000-4000-8000-000000000012',
          modelIdentity: `openai-compatible:gpt-5:${'b'.repeat(64)}:${ids.graderAgentVersion}:runtime-4`,
          output: graderIdentityOutput,
          } }),
        },
      }),
    } as Record<string, unknown>,
    cursor: { nodeId: 'quality_loop', loops: { quality_loop: { iteration: 1 } }, attempt: 1 },
    step_count: 3,
    run_mode: mode,
    execution_manifest: mode === 'production'
      ? { compatibility: input.compatibility ?? 'exact' } as never
      : null,
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
      ...(mode === 'production'
        ? { mode: 'production' as const, manifest: {} as never }
        : { mode: 'test' as const, manifest: null }),
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
    state.candidateVersion = evaluatedCandidateVersion();
    state.currentDocumentReads = 0;
  });

  it('binds the durable grade to the exact candidate version evaluated before a later editable revision', async () => {
    const adapterContext = context();
    const execution = await executeLogicNode(adapterContext);

    expect(execution.result).toBe('done');
    expect(state.order).toEqual(['append', 'state']);
    expect(state.appendInput).toMatchObject({
      workspaceId: ids.workspace,
      workflowRunId: ids.run,
      sequence: 1,
      automatedRevision: 0,
      manualRevision: 0,
      candidateTaskId: ids.candidateTask,
      outputDocumentVersionId: ids.outputVersion,
      candidateHash: 'a'.repeat(64),
      graderTaskId: ids.graderTask,
      graderAgentVersionId: ids.graderAgentVersion,
      exitReason: 'quality_passed',
      traceId: ids.trace,
      leaseOwnerId: 'worker-owner',
    });
    expect(state.currentDocumentReads).toBe(0);
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
          manualRevision: 0,
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

  it('keeps successful test-mode quality loops publishable without durable identities', async () => {
    const adapterContext = context({ mode: 'test', candidateIdentity: false, graderIdentity: false });

    await expect(executeLogicNode(adapterContext)).resolves.toMatchObject({ result: 'done' });
    expect(state.order).toEqual(['state']);
    expect(adapterContext.run.state.qualityHistory).toMatchObject({
      quality_loop: [{ iteration: 1, verdict: { score: 91 } }],
    });
  });

  it('keeps in-flight exact production quality loops running when no identities were ever stored', async () => {
    const adapterContext = context({ candidateIdentity: false, graderIdentity: false, storedIdentities: false, identitySchemaVersion: false });

    await expect(executeLogicNode(adapterContext)).resolves.toMatchObject({ result: 'done' });
    expect(state.order).toEqual(['state']);
  });

  it('keeps a mixed pre-deployment candidate and post-deployment grader loop running without durable history', async () => {
    const adapterContext = context({ candidateIdentity: false, identitySchemaVersion: false });

    await expect(executeLogicNode(adapterContext)).resolves.toMatchObject({ result: 'done' });
    expect(state.order).toEqual(['state']);
    expect(adapterContext.run.state.qualityHistory).toMatchObject({
      quality_loop: [{ iteration: 1, verdict: { score: 91 } }],
    });
  });

  it('rejects a mutable grader state verdict that differs from the grader task output', async () => {
    const adapterContext = context({
      graderIdentityOutput: { data: { passed: false, score: 12, feedback: ['Rewrite'], criteria: [] } },
    });

    await expect(executeLogicNode(adapterContext)).rejects.toMatchObject({
      code: 'QUALITY_GRADER_RESULT_MISMATCH',
      retryable: false,
    });
    expect(state.order).toEqual([]);
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
          manualRevision: 0,
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
