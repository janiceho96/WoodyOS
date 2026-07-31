import { beforeEach, describe, expect, it, vi } from 'vitest';

const ids = vi.hoisted(() => ({
  task: '00000000-0000-4000-8000-000000000001',
  workspace: '00000000-0000-4000-8000-000000000002',
  agent: '00000000-0000-4000-8000-000000000003',
  agentVersion: '00000000-0000-4000-8000-000000000004',
  trace: '00000000-0000-4000-8000-000000000005',
  span: '00000000-0000-4000-8000-000000000006',
  workflowRun: '00000000-0000-4000-8000-000000000008',
  tool: '00000000-0000-4000-8000-000000000010',
  authorization: '00000000-0000-4000-8000-000000000011',
}));
const state = vi.hoisted(() => ({
  taskStatus: 'queued',
  workflowStatus: 'queued',
  controller: new AbortController(),
  finalized: [] as string[],
  providerSignals: [] as Array<AbortSignal | undefined>,
  providerInputs: [] as Array<{ system?: string }>,
  statements: [] as string[],
  providerError: false,
  workflowManifestError: false,
  processors: {} as Record<string, (job: { data: Record<string, string> }) => Promise<unknown>>,
  leaseAvailable: true,
  leaseController: new AbortController(),
  leaseAcquisitions: [] as string[],
  leaseStops: [] as string[],
  leaseReleases: [] as string[],
  leaseReleaseError: null as Error | null,
  withTool: false,
  abortLeaseOnProviderResponse: false,
  providerTurns: 0,
  authorizationCalls: 0,
  cancelWinsFailure: true,
  workflowStepCalls: 0,
  abortLeaseOnWorkflowStep: false,
  takeoverOnTaskTerminal: false,
  memoryEnabled: true,
  memoryContext: '',
  memoryClaimCalls: 0,
  artifactFailure: false,
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
  apiTools: { [ids.tool]: {} },
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
  Worker: class Worker {
    name: string;

    constructor(
      queue: string,
      processor: (job: { data: Record<string, string> }) => Promise<unknown>,
    ) {
      this.name = queue;
      state.processors[queue] = processor;
    }

    on() {
      return this;
    }
  },
}));
vi.mock('ioredis', () => ({
  Redis: class Redis {},
}));
vi.mock('../src/db/client.js', () => ({
  query: vi.fn(async (sql: string) => {
    state.statements.push(sql);
    if (sql.includes('runtime_trust_migration_applied_at')) {
      if (sql.includes('FROM workflow_runs')) {
        const selectable = state.workflowStatus === 'queued'
          || state.workflowStatus === 'cancel_requested';
        return {
          rowCount: selectable ? 1 : 0,
          rows: selectable ? [{
            workspace_id: ids.workspace,
            workflow_version_id: '00000000-0000-4000-8000-000000000009',
            definition_snapshot: { nodes: [], edges: [] },
            run_mode: 'production',
            execution_manifest: manifest,
            trace_id: ids.trace,
            span_id: ids.span,
            parent_span_id: null,
            created_at: task.created_at,
            runtime_trust_migration_applied_at: '2026-07-26T00:00:00.000Z',
            status: state.workflowStatus,
          }] : [],
        };
      }
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
    if (sql.includes("UPDATE tasks SET status='completed'") && state.takeoverOnTaskTerminal) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("UPDATE tasks SET status='failed'")) {
      if (state.cancelWinsFailure) {
        state.taskStatus = 'cancel_requested';
        return { rowCount: sql.includes("status='running'") ? 0 : 1, rows: [] };
      }
      state.taskStatus = 'failed';
      return { rowCount: 1, rows: [{ id: ids.task }] };
    }
    if (sql.includes('UPDATE workflow_runs') && sql.includes("SET status='failed'")) {
      state.workflowStatus = 'cancel_requested';
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT status FROM tasks')) {
      return { rowCount: 1, rows: [{ status: state.taskStatus }] };
    }
    if (sql.includes('SELECT status FROM workflow_runs')) {
      return { rowCount: 1, rows: [{ status: state.workflowStatus }] };
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
            apiToolIds: state.withTool ? [ids.tool] : [],
            memoryConfig: { longTerm: state.memoryEnabled },
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
    if (sql.includes('SELECT id,name,kind,config,permissions FROM tools')) {
      return {
        rowCount: 1,
        rows: [{
          id: ids.tool,
          name: 'lookup',
          kind: 'api',
          config: {},
          permissions: ['read'],
        }],
      };
    }
    if (sql.includes('FROM artifacts WHERE task_id=')) {
      if (state.artifactFailure) throw new Error('artifact lookup failed');
      return { rowCount: 0, rows: [] };
    }
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
vi.mock('../src/runtime/leases.js', () => ({
  acquireLease: vi.fn(async (subject: { id: string }) => {
    state.leaseAcquisitions.push(subject.id);
    return state.leaseAvailable;
  }),
  startLeaseHeartbeat: vi.fn((subject: { id: string }) => ({
    signal: state.leaseController.signal,
    stop: vi.fn(async () => {
      state.leaseStops.push(subject.id);
      return true;
    }),
  })),
  releaseLease: vi.fn(async (subject: { id: string }) => {
    state.leaseReleases.push(subject.id);
    if (state.leaseReleaseError) throw state.leaseReleaseError;
    return true;
  }),
  isLeaseFailure: vi.fn((error: unknown) => (
    Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'EXECUTION_LEASE_LOST')
  )),
  assertFencedMutation: vi.fn(async (rowCount: number | null | undefined) => {
    if (rowCount) return;
    if (state.takeoverOnTaskTerminal) {
      throw Object.assign(new Error('lease ownership lost'), {
        code: 'EXECUTION_LEASE_LOST',
      });
    }
  }),
  executionLeaseCleanupTimeout: vi.fn(() => Object.assign(
    new Error('lease cleanup timed out'),
    { code: 'EXECUTION_LEASE_CLEANUP_TIMEOUT' },
  )),
}));
vi.mock('../src/tools/runtime.js', () => ({
  definitionFor: vi.fn((tool: { id: string; name: string }) => ({
    name: `tool_${tool.id.replaceAll('-', '_')}`,
    description: tool.name,
    input_schema: { type: 'object', properties: {} },
  })),
  invokeTool: vi.fn(async () => ({ ok: true })),
  toolRiskLevel: vi.fn(() => 'read'),
}));
vi.mock('../src/policy/action-gateway.js', () => ({
  authorizeAction: vi.fn(async () => {
    state.authorizationCalls += 1;
    return { status: 'allowed', authorizationId: ids.authorization };
  }),
  beginAction: vi.fn(async () => true),
  completeAction: vi.fn(async () => undefined),
  failAction: vi.fn(async () => undefined),
}));
vi.mock('../src/runtime/manifest.js', () => ({
  assertManifestCompatible: vi.fn(() => manifest),
  assertTaskManifestDependencies: vi.fn(async () => undefined),
  assertWorkflowRunManifestDependencies: vi.fn(async () => {
    if (state.workflowManifestError) throw new Error('manifest dependency unavailable');
  }),
  validateManifestCompatibility: vi.fn(() => ({ ok: true, reasons: [] })),
}));
vi.mock('../src/runtime/approval-expiry.js', () => ({
  startApprovalExpiryScheduler: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../src/lib/ai-provider.js', () => ({
  assertConfiguredAiProvider: vi.fn((runtime: unknown) => runtime),
  configuredAiProviderForWorkspace: vi.fn(async () => ({
    provider: 'anthropic',
    defaultModel: 'model-a',
    openAiCompatible: null,
    anthropic: {
      messages: {
        create: vi.fn((input: { system?: string }, options?: { signal?: AbortSignal }) => {
          state.providerInputs.push(input);
          state.providerSignals.push(options?.signal);
          return {
            withResponse: vi.fn(async () => {
              if (state.providerError) throw new Error('provider unavailable');
              state.providerTurns += 1;
              if (state.withTool && state.providerTurns === 1) {
                if (state.abortLeaseOnProviderResponse) {
                  state.leaseController.abort(Object.assign(
                    new Error('lease ownership lost'),
                    { code: 'EXECUTION_LEASE_LOST' },
                  ));
                }
                return {
                  data: {
                    usage: { input_tokens: 1, output_tokens: 1 },
                    content: [{
                      type: 'tool_use',
                      id: 'provider-call',
                      name: `tool_${ids.tool.replaceAll('-', '_')}`,
                      input: {},
                    }],
                  },
                  request_id: 'request-a',
                  response: { headers: new Headers() },
                };
              }
              return {
                data: {
                  usage: { input_tokens: 1, output_tokens: 1 },
                  content: [{ type: 'text', text: 'done' }],
                },
                request_id: 'request-a',
                response: { headers: new Headers() },
              };
            }),
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
  retrieveAgentMemoryCandidates: vi.fn(async () => []),
  claimAgentMemoryContext: vi.fn(async () => {
    state.memoryClaimCalls += 1;
    return state.memoryContext;
  }),
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
  executeWorkflowStep: vi.fn(async (
    _id: string,
    _executeTask: unknown,
    signal: AbortSignal,
  ) => {
    state.workflowStepCalls += 1;
    if (state.abortLeaseOnWorkflowStep) {
      state.leaseController.abort(Object.assign(
        new Error('lease ownership lost'),
        { code: 'EXECUTION_LEASE_LOST' },
      ));
      signal.throwIfAborted();
    }
    return { queued: true };
  }),
}));

import { executeAgentTask, startWorkers } from '../src/worker.js';

startWorkers();

describe('task worker cancellation', () => {
  beforeEach(() => {
    state.taskStatus = 'queued';
    state.workflowStatus = 'queued';
    state.controller = new AbortController();
    state.finalized = [];
    state.providerSignals = [];
    state.providerInputs = [];
    state.statements = [];
    state.providerError = false;
    state.workflowManifestError = false;
    state.leaseAvailable = true;
    state.leaseController = new AbortController();
    state.leaseAcquisitions = [];
    state.leaseStops = [];
    state.leaseReleases = [];
    state.leaseReleaseError = null;
    state.withTool = false;
    state.abortLeaseOnProviderResponse = false;
    state.providerTurns = 0;
    state.authorizationCalls = 0;
    state.cancelWinsFailure = true;
    state.workflowStepCalls = 0;
    state.abortLeaseOnWorkflowStep = false;
    state.takeoverOnTaskTerminal = false;
    state.memoryEnabled = true;
    state.memoryContext = '';
    state.memoryClaimCalls = 0;
    state.artifactFailure = false;
  });

  it('finalizes queued cancellation without starting the provider', async () => {
    state.taskStatus = 'cancel_requested';
    state.controller.abort();

    await expect(executeAgentTask(ids.task, ids.trace)).resolves.toBeNull();
    expect(state.finalized).toEqual([ids.task]);
    expect(state.providerSignals).toEqual([]);
    expect(state.statements.some((sql) => sql.includes("SET status='running'"))).toBe(false);
    expect(state.leaseStops).toEqual([ids.task]);
    expect(state.leaseReleases).toEqual([ids.task]);
  });

  it('passes the worker cancellation signal into the AI provider request', async () => {
    await executeAgentTask(ids.task, ids.trace);

    expect(state.providerSignals).toHaveLength(1);
    expect(state.providerSignals[0]?.aborted).toBe(false);
    expect(state.leaseStops).toEqual([ids.task]);
    expect(state.leaseReleases).toEqual([ids.task]);
  });

  it('includes governed memory in the initial prompt and obeys long-term memory policy', async () => {
    state.memoryContext = '<UNTRUSTED_MEMORY_CONTEXT>\nMemory fact\n</UNTRUSTED_MEMORY_CONTEXT>';
    await executeAgentTask(ids.task, ids.trace);
    expect(state.providerInputs[0]?.system).toContain('<UNTRUSTED_MEMORY_CONTEXT>');

    state.taskStatus = 'queued';
    state.memoryEnabled = false;
    state.memoryContext = '<UNTRUSTED_MEMORY_CONTEXT>\nMust not appear\n</UNTRUSTED_MEMORY_CONTEXT>';
    await executeAgentTask(ids.task, ids.trace);
    expect(state.providerInputs[1]?.system).not.toContain('Must not appear');
  });

  it('does not claim memory when a sibling context retrieval fails', async () => {
    state.memoryContext = '<UNTRUSTED_MEMORY_CONTEXT>\nMemory fact\n</UNTRUSTED_MEMORY_CONTEXT>';
    state.artifactFailure = true;

    await expect(executeAgentTask(ids.task, ids.trace)).resolves.toBeNull();
    expect(state.providerInputs).toEqual([]);
    expect(state.memoryClaimCalls).toBe(0);
  });

  it('finalizes when cancellation wins before a task failure write observes the poll signal', async () => {
    state.providerError = true;

    await expect(executeAgentTask(ids.task, ids.trace)).resolves.toBeNull();

    expect(state.finalized).toEqual([ids.task]);
    const failureWrite = state.statements.find((sql) => sql.includes("UPDATE tasks SET status='failed'"));
    expect(failureWrite).toContain("status='running'");
    expect(failureWrite).toContain('RETURNING id');
  });

  it('finalizes when cancellation wins the workflow manifest failure transition', async () => {
    state.workflowManifestError = true;
    const processor = state.processors.workflows;

    await expect(processor({
      data: { workflowRunId: ids.workflowRun, traceId: ids.trace },
    })).resolves.toBeNull();

    expect(state.finalized).toEqual([ids.workflowRun]);
    expect(state.workflowStatus).toBe('cancel_requested');
  });

  it('returns a duplicate delivery without claiming or executing when a live owner holds the lease', async () => {
    state.leaseAvailable = false;

    await expect(executeAgentTask(ids.task, ids.trace)).resolves.toBeNull();

    expect(state.leaseAcquisitions).toEqual([ids.task]);
    expect(state.statements.some((sql) => sql.includes("SET status='running'"))).toBe(false);
    expect(state.providerSignals).toEqual([]);
    expect(state.leaseStops).toEqual([]);
    expect(state.leaseReleases).toEqual([]);
  });

  it('aborts after heartbeat ownership loss before creating the next action authorization', async () => {
    state.withTool = true;
    state.abortLeaseOnProviderResponse = true;

    await expect(executeAgentTask(ids.task, ids.trace)).resolves.toBeNull();

    expect(state.authorizationCalls).toBe(0);
    expect(state.finalized).toEqual([]);
    expect(state.taskStatus).toBe('running');
    expect(state.leaseStops).toEqual([ids.task]);
    expect(state.leaseReleases).toEqual([ids.task]);
  });

  it('does not let lease cleanup failure mask the primary worker error', async () => {
    state.providerError = true;
    state.cancelWinsFailure = false;
    state.leaseReleaseError = new Error('release failed with token=cleanup-secret');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(executeAgentTask(ids.task, ids.trace)).rejects.toThrow('provider unavailable');

    expect(state.leaseStops).toEqual([ids.task]);
    expect(state.leaseReleases).toEqual([ids.task]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('cleanup-secret');
    logged.mockRestore();
  });

  it('does not execute a duplicate workflow delivery while another owner holds the lease', async () => {
    state.leaseAvailable = false;
    const processor = state.processors.workflows;

    await expect(processor({
      data: { workflowRunId: ids.workflowRun, traceId: ids.trace },
    })).resolves.toBeNull();

    expect(state.workflowStepCalls).toBe(0);
    expect(state.leaseAcquisitions).toEqual([ids.workflowRun]);
    expect(state.leaseStops).toEqual([]);
    expect(state.leaseReleases).toEqual([]);
  });

  it('fails workflow execution closed when heartbeat ownership is lost', async () => {
    state.abortLeaseOnWorkflowStep = true;
    const processor = state.processors.workflows;

    await expect(processor({
      data: { workflowRunId: ids.workflowRun, traceId: ids.trace },
    })).resolves.toBeNull();

    expect(state.workflowStepCalls).toBe(1);
    expect(state.finalized).toEqual([]);
    expect(state.leaseStops).toEqual([ids.workflowRun]);
    expect(state.leaseReleases).toEqual([ids.workflowRun]);
  });

  it('does not report a stale task terminal write as user cancellation', async () => {
    state.takeoverOnTaskTerminal = true;

    await expect(executeAgentTask(ids.task, ids.trace)).resolves.toBeNull();

    const terminal = state.statements.find((sql) => sql.includes("UPDATE tasks SET status='completed'"));
    expect(terminal).toContain('execution_leases');
    expect(state.finalized).toEqual([]);
    expect(state.taskStatus).toBe('running');
  });
});
