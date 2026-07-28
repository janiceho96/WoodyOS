import { describe, expect, it, vi } from 'vitest';

const ids = {
  workspace: '00000000-0000-4000-8000-000000000001',
  run: '00000000-0000-4000-8000-000000000002',
  task: '00000000-0000-4000-8000-000000000003',
  agent: '00000000-0000-4000-8000-000000000004',
  agentVersion: '00000000-0000-4000-8000-000000000005',
  outputVersion: '00000000-0000-4000-8000-000000000006',
  trace: '00000000-0000-4000-8000-000000000007',
};

vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM tasks')) {
      return {
        rowCount: 1,
        rows: [{
          id: ids.task,
          status: 'completed',
          output: { text: 'Stable candidate' },
          error: null,
          trace_id: ids.trace,
          agent_id: ids.agent,
          agent_version_id: ids.agentVersion,
        }],
      };
    }
    return { rowCount: 0, rows: [] };
  }),
}));
vi.mock('../src/outputs/service.js', () => ({
  initializeTaskOutputDocument: vi.fn(async () => ({
    id: '00000000-0000-4000-8000-000000000008',
    workspace_id: ids.workspace,
    task_id: ids.task,
    current_version_number: 1,
    created_by: null,
    created_at: '2026-07-27T00:00:00.000Z',
    updated_at: '2026-07-27T00:00:00.000Z',
    currentVersion: {
      id: ids.outputVersion,
      workspace_id: ids.workspace,
      document_id: '00000000-0000-4000-8000-000000000008',
      version_number: 1,
      content: 'Stable candidate',
      content_hash: 'a'.repeat(64),
      created_by: null,
      created_at: '2026-07-27T00:00:00.000Z',
    },
    versions: [],
  })),
}));

import { executeAgentNode } from '../src/workflows/adapters/agent.js';

describe('agent workflow execution identity', () => {
  it('returns exact task, version, output version, and pinned model identity without wrapping node output', async () => {
    const observed: unknown[] = [];
    const manifest = {
      manifestVersion: 1 as const,
      createdAt: '2026-07-27T00:00:00.000Z',
      compatibility: 'exact' as const,
      agents: {
        [ids.agent]: { versionId: ids.agentVersion, version: 1, snapshotHash: 'a'.repeat(64) },
      },
      prompts: {},
      models: {
        [ids.agent]: {
          provider: 'openai-compatible',
          model: 'gpt-5',
          parametersHash: 'b'.repeat(64),
        },
      },
      apiTools: {},
      mcpActions: {},
      policy: { version: '1' },
      adapters: {},
      outputContracts: {},
      artifactTemplates: {},
      runtime: { version: 'runtime-4', stateSchemaVersion: 1 as const },
    };
    const execution = await executeAgentNode({
      execution: {
        mode: 'production',
        manifest,
        trace: {
          traceId: ids.trace,
          spanId: '00000000-0000-4000-8000-000000000009',
          parentSpanId: null,
        },
        signal: new AbortController().signal,
      },
      run: {
        id: ids.run,
        workspace_id: ids.workspace,
        workflow_id: '00000000-0000-4000-8000-000000000010',
        input: {},
        definition_snapshot: { nodes: [], edges: [] },
        state: {},
        cursor: { nodeId: 'worker', loops: {}, attempt: 1 },
        step_count: 0,
        run_mode: 'production',
        execution_manifest: manifest,
        trace_id: ids.trace,
        span_id: '00000000-0000-4000-8000-000000000009',
        parent_span_id: null,
        name: 'Quality',
        created_by: '00000000-0000-4000-8000-000000000011',
      },
      node: { id: 'worker', type: 'agent', config: { agentId: ids.agent } },
      cursor: { nodeId: 'worker', loops: {}, attempt: 1 },
      iterationKey: 'quality_loop:1',
      executeAgentTask: async () => null,
      emitEvent: async () => undefined,
      resolve: (value) => value,
      setNodeOutput: (value) => { observed.push(value); },
    });

    expect(execution.output).toEqual({ text: 'Stable candidate' });
    expect(execution.agentExecutionIdentity).toEqual({
      taskId: ids.task,
      agentVersionId: ids.agentVersion,
      outputDocumentVersionId: ids.outputVersion,
      modelIdentity: `openai-compatible:gpt-5:${'b'.repeat(64)}:${ids.agentVersion}:runtime-4`,
      output: { text: 'Stable candidate' },
    });
    expect(observed).toEqual([{ text: 'Stable candidate' }]);
  });
});
