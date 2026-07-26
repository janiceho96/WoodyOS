import { describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Worker: class Worker {},
}));
vi.mock('ioredis', () => ({
  Redis: class Redis {},
}));
vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
}));
vi.mock('../src/queue/task-queue.js', () => ({
  ARTIFACT_QUEUE: 'artifacts',
  FILE_QUEUE: 'files',
  KNOWLEDGE_QUEUE: 'knowledge',
  TASK_QUEUE: 'tasks',
  WORKFLOW_QUEUE: 'workflows',
  enqueueWorkflowRun: vi.fn(async () => undefined),
}));
vi.mock('../src/tools/runtime.js', () => ({
  definitionFor: vi.fn(),
  invokeTool: vi.fn(async () => {
    throw new Error('connection dropped with token=remote-secret');
  }),
  toolRiskLevel: vi.fn(() => 'write'),
}));
vi.mock('../src/mcp/runtime.js', () => ({
  anthropicMcpDefinition: vi.fn(),
  assertMcpPermission: vi.fn(),
  authorizedMcpTools: vi.fn(async () => []),
  executeAuthorizedMcpTool: vi.fn(),
  mcpToolRuntimeName: vi.fn(),
  openAiMcpDefinition: vi.fn(),
}));
vi.mock('../src/mcp/maintenance.js', () => ({
  startMcpMaintenance: vi.fn(),
}));
vi.mock('../src/policy/action-gateway.js', () => ({
  authorizeAction: vi.fn(),
  beginAction: vi.fn(async () => true),
  completeAction: vi.fn(async () => undefined),
  failAction: vi.fn(async () => {
    throw new Error('ledger update failed with token=ledger-secret');
  }),
}));
vi.mock('../src/runtime/manifest.js', () => ({
  assertManifestCompatible: vi.fn(),
  assertTaskManifestDependencies: vi.fn(async () => undefined),
  assertWorkflowRunManifestDependencies: vi.fn(async () => undefined),
  validateManifestCompatibility: vi.fn(),
}));
vi.mock('../src/artifacts/service.js', () => ({
  generateArtifact: vi.fn(),
  releaseTaskArtifacts: vi.fn(),
}));
vi.mock('../src/files/service.js', () => ({
  processFile: vi.fn(),
  purgeExpiredFiles: vi.fn(),
}));
vi.mock('../src/workflows/runtime.js', () => ({
  executeWorkflowStep: vi.fn(),
}));

import { executeTaskToolAction } from '../src/worker.js';
import { serializeRuntimeError } from '../src/runtime/errors.js';

describe('task action retry safety', () => {
  it('preserves an uncertain task action error when ledger failure persistence rejects', async () => {
    let failure: unknown;
    try {
      await executeTaskToolAction({
        task: {
          id: '00000000-0000-4000-8000-000000000001',
          workspace_id: '00000000-0000-4000-8000-000000000002',
          title: 'Task',
          input: {},
          agent_id: '00000000-0000-4000-8000-000000000003',
          requested_by: '00000000-0000-4000-8000-000000000004',
          workflow_run_id: null,
          workflow_node_id: null,
          agent_version_id: null,
          execution_manifest: null,
          trace_id: '00000000-0000-4000-8000-000000000005',
          span_id: '00000000-0000-4000-8000-000000000006',
          parent_span_id: null,
          created_at: '2026-07-27T00:00:00.000Z',
        },
        action: {
          adapter: 'api',
          tool: {
            id: '00000000-0000-4000-8000-000000000010',
            name: 'send_update',
            kind: 'api',
            config: {},
            permissions: ['write'],
          },
        },
        arguments_: {},
        authorizationId: '00000000-0000-4000-8000-000000000020',
        trace: {
          traceId: '00000000-0000-4000-8000-000000000005',
          spanId: '00000000-0000-4000-8000-000000000006',
          parentSpanId: null,
        },
      });
    } catch (error) {
      failure = error;
    }

    const serialized = serializeRuntimeError(failure);
    expect(serialized).toMatchObject({
      code: 'ACTION_OUTCOME_UNCERTAIN',
      category: 'permanent',
      retryable: false,
      details: {
        operatorContext: {
          actionFailurePersistence: {
            code: 'RUNTIME_ERROR',
            category: 'unknown',
            retryable: false,
          },
        },
      },
    });
    expect(JSON.stringify(serialized)).not.toContain('remote-secret');
    expect(JSON.stringify(serialized)).not.toContain('ledger-secret');
  });
});
