import { query } from '../../db/client.js';
import type { WorkflowAdapterContext } from './types.js';
import { resolveNodeInput } from './templates.js';
import { childTraceContext } from '../../runtime/trace.js';
import { assertFencedMutation } from '../../runtime/leases.js';
import { initializeTaskOutputDocument } from '../../outputs/service.js';
import { modelIdentityFromManifest } from '../../quality/history.js';
import type { AgentNodeExecutionIdentity } from './types.js';

function json(value: unknown) {
  return JSON.stringify(value === undefined ? null : value);
}

type AgentTask = {
  id: string;
  status: string;
  output: unknown;
  error: unknown;
  trace_id: string;
  agent_id: string;
  agent_version_id: string | null;
};

async function loadAgentTask(context: WorkflowAdapterContext, agentId: string) {
  const { execution, run, node, cursor, iterationKey } = context;
  const existing = (await query<AgentTask>(
    `SELECT id,status,output,error,trace_id,agent_id,agent_version_id FROM tasks
     WHERE workflow_run_id=$1 AND workflow_node_id=$2 AND workflow_iteration_key=$3 AND workflow_attempt=$4`,
    [run.id, node.id, iterationKey, cursor.attempt],
  )).rows[0];
  if (existing) return existing;

  execution.signal.throwIfAborted();
  const agentTrace = childTraceContext(execution.trace);
  const inputMapping = context.node.config.inputMapping && typeof context.node.config.inputMapping === 'object' && !Array.isArray(context.node.config.inputMapping)
    ? context.node.config.inputMapping as Record<string, unknown>
    : undefined;
  const agentInput = {
    ...resolveNodeInput(inputMapping, run.state),
    workflow: { name: run.name, runId: run.id, nodeId: node.id, iterationKey, attempt: cursor.attempt, responsibility: node.config.responsibility ?? null, expectedOutput: node.config.expectedOutput ?? null, outputContract: node.config.outputContract ?? 'text' },
  };
  const agentVersionId = run.execution_manifest?.agents[agentId]?.versionId ?? null;
  if (run.run_mode === 'production' && !agentVersionId) {
    throw Object.assign(new Error('AGENT_VERSION_REQUIRED'), { code: 'AGENT_VERSION_REQUIRED', retryable: false });
  }
  execution.signal.throwIfAborted();
  const childTask = await query<AgentTask>(
    `INSERT INTO tasks(
       workspace_id,agent_id,agent_version_id,workflow_run_id,workflow_node_id,workflow_iteration_key,
       workflow_attempt,title,input,requested_by,manifest_version,execution_manifest,
       trace_id,span_id,parent_span_id
     )
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
     WHERE (
       $16::text IS NULL
       OR EXISTS(
         SELECT 1 FROM execution_leases
         WHERE subject_type='workflow_run' AND subject_id=$4
           AND owner_id=$16 AND expires_at>now()
       )
     )
     RETURNING id,status,output,error,trace_id,agent_id,agent_version_id`,
    [
      run.workspace_id,
      agentId,
      agentVersionId,
      run.id,
      node.id,
      iterationKey,
      cursor.attempt,
      String(node.config.title ?? `Workflow ${run.name}`),
      json(agentInput),
      run.created_by,
      run.execution_manifest?.manifestVersion ?? 1,
      run.execution_manifest ? json(run.execution_manifest) : null,
      agentTrace.traceId,
      agentTrace.spanId,
      agentTrace.parentSpanId,
      execution.leaseOwnerId ?? null,
    ],
  );
  await assertFencedMutation(
    childTask.rowCount,
    execution.leaseOwnerId
      ? { subject: { kind: 'workflow_run', id: run.id }, ownerId: execution.leaseOwnerId }
      : undefined,
  );
  return childTask.rows[0];
}

async function resolveAgentTaskOutput(context: WorkflowAdapterContext, initialTask: AgentTask) {
  const { execution, node, executeAgentTask } = context;
  let task = initialTask;
  if (task.status === 'failed') throw new Error(typeof task.error === 'object' && task.error && 'message' in task.error ? String((task.error as { message: unknown }).message) : `Agent node ${node.id} failed`);
  let output = task.status === 'completed'
    ? task.output
    : await executeAgentTask(task.id, task.trace_id, execution.signal);
  if (output && typeof output === 'object' && 'awaitingApproval' in output) return { waiting: true, waitingMessage: 'Agent tool confirmation is required', output };
  if (task.status !== 'completed' || output === null) {
    task = (await query<AgentTask>(
      'SELECT id,status,output,error,trace_id,agent_id,agent_version_id FROM tasks WHERE id=$1',
      [task.id],
    )).rows[0];
    if (task?.status === 'completed') output = task.output as Record<string, unknown>;
    else if (task?.status === 'awaiting_approval') return { waiting: true, waitingMessage: 'Agent tool confirmation is required', output: null };
    else throw new Error(`Agent node ${node.id} did not produce an output`);
  }
  return { task, output };
}

async function agentExecutionIdentityFor(
  context: WorkflowAdapterContext,
  task: AgentTask,
  output: unknown,
): Promise<AgentNodeExecutionIdentity | undefined> {
  const { run } = context;
  if (!task.agent_version_id || !run.execution_manifest) return undefined;
  try {
    const document = await initializeTaskOutputDocument({
      workspaceId: run.workspace_id,
      taskId: task.id,
      actorId: run.created_by,
    });
    return {
      taskId: task.id,
      agentVersionId: task.agent_version_id,
      outputDocumentVersionId: document.currentVersion.id,
      modelIdentity: modelIdentityFromManifest(run.execution_manifest, task.agent_id, task.agent_version_id),
      output,
    };
  } catch (error) {
    if (!(error instanceof Error && error.message === 'OUTPUT_SOURCE_EMPTY')) throw error;
    return undefined;
  }
}

export async function executeAgentNode(context: WorkflowAdapterContext) {
  const { execution, node, setNodeOutput } = context;
  execution.signal.throwIfAborted();
  const agentId = node.config.agentId;
  if (typeof agentId !== 'string') throw new Error(`Agent node ${node.id} has no agentId`);
  const task = await loadAgentTask(context, agentId);
  const resolved = await resolveAgentTaskOutput(context, task);
  if ('waiting' in resolved) return resolved;
  const agentExecutionIdentity = await agentExecutionIdentityFor(context, resolved.task, resolved.output);
  setNodeOutput(resolved.output);
  return { output: resolved.output, result: resolved.output, ...(agentExecutionIdentity ? { agentExecutionIdentity } : {}) };
}
