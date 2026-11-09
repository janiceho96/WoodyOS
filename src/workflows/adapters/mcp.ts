import { authorizedMcpAction, executeAuthorizedMcpTool } from '../../mcp/runtime.js';
import { authorizeWorkflowAction, beginWorkflowAction, completeWorkflowAction, failWorkflowAction } from '../../policy/action-gateway.js';
import type { WorkflowAdapterContext } from './types.js';
import {
  assertWorkflowRunManifestDependencies,
  mcpActionManifestEntry,
} from '../../runtime/manifest.js';
import { childTraceContext } from '../../runtime/trace.js';
import { preserveActionFailure, uncertainActionOutcome } from '../../runtime/errors.js';
import { expirationPolicy } from '../../runtime/approval-expiry.js';
import { allowedAuthorizationId, completedAuthorizationResult } from './authorization-result.js';

export async function executeMcpActionNode(context: WorkflowAdapterContext) {
  const { execution, run, node, cursor, iterationKey, emitEvent, resolve, setNodeOutput } = context;
  execution.signal.throwIfAborted();
  await assertWorkflowRunManifestDependencies(run);
  const agentId = node.config.agentId;
  const mcpToolId = node.config.mcpToolId;
  if (typeof agentId !== 'string' || typeof mcpToolId !== 'string') throw new Error(`App action ${node.id} needs an agent and MCP tool`);
  const action = await authorizedMcpAction(
    run.workspace_id,
    agentId,
    mcpToolId,
    execution.mode === 'production' ? Object.keys(execution.manifest.agents) : [agentId],
  );
  if (!action) throw Object.assign(new Error(`App action ${node.id} is unavailable or not allowed for the selected agent`), { retryable: false });
  const { tool, manifestRows } = action;
  const manifestEntry = mcpActionManifestEntry(manifestRows);
  context.registerActionIdentity({
    adapter: 'mcp',
    resourceId: tool.id,
    agentId,
    ...(execution.mode === 'production'
      ? { agentManifestEntry: execution.manifest.agents[agentId] }
      : {}),
    riskLevel: manifestEntry.riskLevel,
    manifestEntry,
  });
  execution.signal.throwIfAborted();
  const configuredInput = node.config.input && typeof node.config.input === 'object' && !Array.isArray(node.config.input) ? node.config.input : {};
  const arguments_ = resolve(configuredInput) as Record<string, unknown>;
  const actionName = tool.title ?? tool.remote_name;
  const actionTrace = childTraceContext(execution.trace);
  const authorization = await authorizeWorkflowAction({
    workspaceId: run.workspace_id,
    workflowRunId: run.id,
    nodeId: node.id,
    iterationKey,
    attempt: cursor.attempt,
    adapter: 'mcp',
    resourceId: tool.id,
    operation: tool.remote_name,
    riskLevel: tool.risk_level,
    arguments: arguments_,
    requestedBy: run.created_by,
    targetSummary: `${actionName} via ${tool.connection_name}`,
    onExpiration: expirationPolicy(node.config.onExpiration),
    trace: actionTrace,
    leaseOwnerId: execution.leaseOwnerId,
  });
  execution.signal.throwIfAborted();
  if (authorization.status === 'awaiting_confirmation') {
    await emitEvent('action.confirmation_requested', `Confirmation is required before ${actionName}`, { authorizationId: authorization.authorizationId, toolId: tool.id, riskLevel: tool.risk_level }, actionTrace);
    return { waiting: true, waitingMessage: `Confirm ${actionName} before Woody continues`, output: null };
  }
  const completed = completedAuthorizationResult(authorization, setNodeOutput);
  if (completed) return completed;
  const authorizationId = allowedAuthorizationId(authorization);
  if (!(await beginWorkflowAction(authorizationId, execution.leaseOwnerId))) throw Object.assign(new Error('External action execution could not be claimed safely'), { retryable: false });
  await emitEvent('mcp.tool.called', `Calling ${actionName}`, { authorizationId, toolId: tool.id }, actionTrace);
  try {
    const executed = await executeAuthorizedMcpTool({
      tool,
      arguments_,
      agentId,
      taskId: null,
      workflowRunId: run.id,
      workflowNodeId: node.id,
      workflowIterationKey: iterationKey,
      workflowAttempt: cursor.attempt,
      actionAuthorizationId: authorizationId,
      trace: childTraceContext(actionTrace),
      signal: execution.signal,
    });
    await completeWorkflowAction(authorizationId, executed.result, execution.leaseOwnerId);
    await emitEvent('mcp.tool.completed', `${actionName} completed`, { authorizationId, toolCallId: executed.callId, toolId: tool.id }, actionTrace);
    setNodeOutput(executed.result);
    return { output: executed.result, result: executed.result };
  } catch (error) {
    const failure = tool.risk_level === 'read' ? error : uncertainActionOutcome(error);
    throw await preserveActionFailure(
      failure,
      () => failWorkflowAction(authorizationId, failure, execution.leaseOwnerId),
    );
  }
}
