import { query } from '../../db/client.js';
import {
  invokeTool,
  toolRequiresApproval,
  toolRiskLevel,
  type ToolRecord,
} from '../../tools/runtime.js';
import { retryPolicy } from '../definition.js';
import type { WorkflowAdapterContext } from './types.js';
import {
  apiToolManifestEntry,
  assertWorkflowRunManifestDependencies,
} from '../../runtime/manifest.js';
import { childTraceContext } from '../../runtime/trace.js';
import { preserveActionFailure, uncertainActionOutcome } from '../../runtime/errors.js';
import {
  authorizeWorkflowAction,
  beginWorkflowAction,
  completeWorkflowAction,
  failWorkflowAction,
} from '../../policy/action-gateway.js';
import { limitedActionResult } from '../../lib/action-safety.js';
import { expirationPolicy } from '../../runtime/approval-expiry.js';
import { allowedAuthorizationId, completedAuthorizationResult } from './authorization-result.js';

function nonRetryable(message: string) {
  return Object.assign(new Error(message), { retryable: false });
}

async function requiredPrecedingApproval(context: WorkflowAdapterContext, tool: ToolRecord) {
  const { node, run, cursor, iterationKey } = context;
  if (!toolRequiresApproval(tool)) return undefined;
  if (retryPolicy(node).maxAttempts > 1) throw nonRetryable(`Write-capable action ${node.id} cannot use automatic retries`);
  const previous = run.definition_snapshot.nodes.find((candidate) => candidate.id === cursor.previousNodeId);
  if (!previous || previous.type !== 'approval') {
    throw nonRetryable(`Write-capable action ${node.id} requires a directly preceding approval node`);
  }
  const approved = (await query<{ approved: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM workflow_run_node_states
     WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND status='completed') approved`,
    [run.id, previous.id, iterationKey],
  )).rows[0]?.approved;
  if (!approved) throw nonRetryable(`Write-capable action ${node.id} has no completed approval for this loop iteration`);
  return { nodeId: previous.id, iterationKey };
}

export async function executeLegacyToolNode(context: WorkflowAdapterContext) {
  const { execution, run, node, cursor, iterationKey, emitEvent, resolve, setNodeOutput } = context;
  execution.signal.throwIfAborted();
  await assertWorkflowRunManifestDependencies(run);
  const toolId = node.config.toolId;
  if (typeof toolId !== 'string') throw new Error(`Action node ${node.id} has no toolId`);
  const tool = (await query<ToolRecord>('SELECT id,name,kind,config,permissions FROM tools WHERE id=$1 AND workspace_id=$2 AND enabled=true', [toolId, run.workspace_id])).rows[0];
  if (!tool) throw new Error(`Action node ${node.id} references an unavailable tool`);
  const manifestEntry = apiToolManifestEntry(tool);
  context.registerActionIdentity({
    adapter: 'api',
    resourceId: tool.id,
    riskLevel: manifestEntry.riskLevel,
    manifestEntry,
  });
  execution.signal.throwIfAborted();
  const precedingApproval = await requiredPrecedingApproval(context, tool);
  const configuredInput = node.config.input && typeof node.config.input === 'object' && !Array.isArray(node.config.input) ? node.config.input : run.state;
  const input = resolve(configuredInput) as Record<string, unknown>;
  const actionTrace = childTraceContext(execution.trace);
  const authorization = await authorizeWorkflowAction({
    workspaceId: run.workspace_id,
    workflowRunId: run.id,
    nodeId: node.id,
    iterationKey,
    attempt: cursor.attempt,
    adapter: 'api',
    resourceId: tool.id,
    operation: tool.name,
    riskLevel: toolRiskLevel(tool),
    arguments: input,
    requestedBy: run.created_by,
    targetSummary: tool.name,
    onExpiration: expirationPolicy(node.config.onExpiration),
    trace: actionTrace,
    precedingApproval,
    leaseOwnerId: execution.leaseOwnerId,
  });
  execution.signal.throwIfAborted();
  if (authorization.status === 'awaiting_confirmation') {
    throw Object.assign(new Error(`Write-capable action ${node.id} could not consume its preceding approval safely`), { retryable: false });
  }
  const completed = completedAuthorizationResult(authorization, setNodeOutput);
  if (completed) return completed;
  const authorizationId = allowedAuthorizationId(authorization);
  if (!(await beginWorkflowAction(authorizationId, execution.leaseOwnerId))) {
    throw Object.assign(new Error('Legacy action execution could not be claimed safely'), { retryable: false });
  }
  await emitEvent('tool.called', `Calling ${tool.name}`, {
    authorizationId,
    toolId: tool.id,
    iterationKey,
    attempt: cursor.attempt,
  }, actionTrace);
  try {
    const output = limitedActionResult(await invokeTool(tool, input, false, execution.signal));
    await completeWorkflowAction(authorizationId, output, execution.leaseOwnerId);
    await emitEvent('tool.completed', `${tool.name} completed`, {
      authorizationId,
      toolId: tool.id,
      iterationKey,
      attempt: cursor.attempt,
    }, actionTrace);
    setNodeOutput(output);
    return { output, result: output };
  } catch (error) {
    const failure = toolRiskLevel(tool) === 'read' ? error : uncertainActionOutcome(error);
    throw await preserveActionFailure(
      failure,
      () => failWorkflowAction(authorizationId, failure, execution.leaseOwnerId),
    );
  }
}
