import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  task: '00000000-0000-4000-8000-000000000001',
  workspace: '00000000-0000-4000-8000-000000000002',
  agent: '00000000-0000-4000-8000-000000000003',
  agentVersion: '00000000-0000-4000-8000-000000000004',
  trace: '00000000-0000-4000-8000-000000000005',
  span: '00000000-0000-4000-8000-000000000006',
}));
const state = vi.hoisted(() => ({
  taskStatus: 'queued',
  controller: new AbortController(),
  finalized: [] as string[],
  providerSignals: [] as Array<AbortSignal | undefined>,
  statements: [] as string[],
}));

const manifest = {
  manifestVersion: 1,
  createdAt: '2026-07-26T00:00:00.000Z',
  compatibility: 'exact',
  agents: {
    [ids.agent]: {
      versionId: ids.agentVersion,
      version: 1,
      snapshotHash: 'a'.repeat(64),
    },
  },
  prompts: {},
  models: {},
  apiTools: {},
  mcpActions: {},
  policy: { version: '1' },
  adapters: {},
  outputContracts: {},
  artifactTemplates: {},
  runtime: { version: '0.1.0', stateSchemaVersion: 1 },
};
const task = {
  id: ids.task,
  workspace_id: ids.workspace,
  title: 'Cancellation task',
  input: {},
  agent_id: ids.agent,
  requested_by: '00000000-0000-4000-8000-000000000007',
  workflow_run_id: null,
  workflow_node_id: null,
  agent_version_id: ids.agentVersion,
  execution_manifest: manifest,
  trace_id: ids.trace,
  span_id: ids.span,
  parent_span_id: null,
  created_at: '2026-07-27T00:00:00.000Z',
};

vi.mock('bullmq', () => ({
  Worker: class Worker {},
}));
vi.mock('ioredis', () => ({
  Redis: class Redis {},
}));
vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string) => {
    state.statements.push(sql);
    if (sql.includes('runtime_trust_migration_applied_at')) {
      const selectable = state.taskStatus === 'queued'
        || (state.taskStatus === 'cancel_requested' && sql.includes('cancel_requested'));
      return {
        rowCount: selectable ? 1 : 0,
        rows: selectable ? [{
          trace_id: ids.trace,
          span_id: ids.span,
          parent_span_id: null,
          created_at: task.created_at,
          runtime_trust_migration_applied_at: '2026-07-26T00:00:00.000Z',
          status: state.taskStatus,
        }] : [],
      };
    }
    if (sql.includes("UPDATE tasks SET status='running'")) {
      state.taskStatus = 'running';
      return { rowCount: 1, rows: [{ ...task }] };
    }
    if (sql.includes('FROM agent_versions')) {
      return {
        rowCount: 1,
        rows: [{
          snapshot: {
            name: 'Agent',
            role: 'analyst',
            goal: 'Answer',
            instructions: 'Be concise',
            model: 'model-a',
            modelConfig: { temperature: 0.2, maxTokens: 128, topP: 1 },
            capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: false },
            apiToolIds: [],
            memoryConfig: {},
          },
        }],
      };
    }
    if (sql.includes('SELECT trace_id,span_id,parent_span_id FROM tasks')) {
      return {
        rowCount: 1,
        rows: [{ trace_id: ids.trace, span_id: ids.span, parent_span_id: null }],
      };
    }
    if (sql.includes('FROM artifacts WHERE task_id=')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [] };
  }),
}));
vi.mock('../src/queue/task-queue.js', () => ({
  ARTIFACT_QUEUE: 'artifacts',
  FILE_QUEUE: 'files',
  KNOWLEDGE_QUEUE: 'knowledge',
  TASK_QUEUE: 'tasks',
  WORKFLOW_QUEUE: 'workflows',
  enqueueWorkflowRun: vi.fn(),
}));
vi.mock('../src/runtime/cancellation.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/runtime/cancellation.js')>(),
  createCancellationContext: vi.fn(async () => ({
    signal: state.controller.signal,
    stop: vi.fn(),
    cleanup: vi.fn(),
  })),
  finalizeCancellation: vi.fn(async ({ id }: { id: string }) => {
    state.finalized.push(id);
    return 'cancelled';
  }),
}));
vi.mock('../src/runtime/manifest.js', () => ({
  assertManifestCompatible: vi.fn(() => manifest),
  assertTaskManifestDependencies: vi.fn(async () => undefined),
  assertWorkflowRunManifestDependencies: vi.fn(async () => undefined),
  validateManifestCompatibility: vi.fn(() => ({ ok: true, reasons: [] })),
}));
vi.mock('../src/lib/ai-provider.js', () => ({
  assertConfiguredAiProvider: vi.fn((runtime: unknown) => runtime),
  configuredAiProviderForWorkspace: vi.fn(async () => ({
    provider: 'anthropic',
    defaultModel: 'model-a',
    openAiCompatible: null,
    anthropic: {
      messages: {
        create: vi.fn((_input: unknown, options?: { signal?: AbortSignal }) => {
          state.providerSignals.push(options?.signal);
          return {
            withResponse: vi.fn(async () => ({
              data: {
                usage: { input_tokens: 1, output_tokens: 1 },
                content: [{ type: 'text', text: 'done' }],
              },
              request_id: 'request-a',
              response: { headers: new Headers() },
            })),
          };
        }),
      },
    },
  })),
}));
vi.mock('../src/lib/ai-usage.js', () => ({
  assertWorkspaceAiBudgetAvailable: vi.fn(async () => undefined),
  estimatedWorkspaceAiCost: vi.fn(async () => 0),
  recordAiUsage: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/agent-runtime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/agent-runtime.js')>(),
  retrieveAgentKnowledge: vi.fn(async () => ''),
}));
vi.mock('../src/files/context.js', () => ({
  retrieveTaskAttachmentContext: vi.fn(async () => ({ text: '', citations: [] })),
}));
vi.mock('../src/mcp/runtime.js', () => ({
  anthropicMcpDefinition: vi.fn(),
  authorizedMcpTools: vi.fn(async () => []),
  executeAuthorizedMcpTool: vi.fn(),
  mcpToolRuntimeName: vi.fn(),
  assertMcpPermission: vi.fn(),
  openAiMcpDefinition: vi.fn(),
}));
vi.mock('../src/mcp/checkpoints.js', () => ({
  loadTaskActionCheckpoint: vi.fn(async () => null),
  pauseForActionConfirmation: vi.fn(),
}));
vi.mock('../src/mcp/maintenance.js', () => ({
  startMcpMaintenance: vi.fn(),
}));
vi.mock('../src/artifacts/service.js', () => ({
  generateArtifact: vi.fn(),
  releaseTaskArtifacts: vi.fn(async () => []),
}));
vi.mock('../src/files/service.js', () => ({
  processFile: vi.fn(),
  purgeExpiredFiles: vi.fn(),
}));
vi.mock('../src/workflows/runtime.js', () => ({
  executeWorkflowStep: vi.fn(),
}));

import { executeAgentTask } from '../src/worker.js';

describe('task worker cancellation', () => {
  beforeEach(() => {
    state.taskStatus = 'queued';
    state.controller = new AbortController();
    state.finalized = [];
    state.providerSignals = [];
    state.statements = [];
  });

  it('finalizes queued cancellation without starting the provider', async () => {
    state.taskStatus = 'cancel_requested';
    state.controller.abort();

    await expect(executeAgentTask(ids.task, ids.trace)).resolves.toBeNull();
    expect(state.finalized).toEqual([ids.task]);
    expect(state.providerSignals).toEqual([]);
    expect(state.statements.some((sql) => sql.includes("SET status='running'"))).toBe(false);
  });

  it('passes the worker cancellation signal into the AI provider request', async () => {
    await executeAgentTask(ids.task, ids.trace);

    expect(state.providerSignals).toEqual([state.controller.signal]);
  });
});
