import { authorizedMcpTool, executeAuthorizedMcpTool } from '../../mcp/runtime.js';
import { authorizeWorkflowAction, beginWorkflowAction, completeWorkflowAction, failWorkflowAction } from '../../policy/action-gateway.js';
import type { WorkflowAdapterContext } from './types.js';

export async function executeMcpActionNode(context: WorkflowAdapterContext) {
  const { run, node, cursor, iterationKey, emitEvent, resolve, setNodeOutput } = context;
  const agentId = node.config.agentId;
  const mcpToolId = node.config.mcpToolId;
  if (typeof agentId !== 'string' || typeof mcpToolId !== 'string') throw new Error(`App action ${node.id} needs an agent and MCP tool`);
  const tool = await authorizedMcpTool(run.workspace_id, agentId, mcpToolId);
  if (!tool) throw Object.assign(new Error(`App action ${node.id} is unavailable or not allowed for the selected agent`), { retryable: false });
  const configuredInput = node.config.input && typeof node.config.input === 'object' && !Array.isArray(node.config.input) ? node.config.input : {};
  const arguments_ = resolve(configuredInput) as Record<string, unknown>;
  const actionName = tool.title ?? tool.remote_name;
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
  });
  if (authorization.status === 'awaiting_confirmation') {
    await emitEvent('action.confirmation_requested', `Confirmation is required before ${actionName}`, { authorizationId: authorization.authorizationId, toolId: tool.id, riskLevel: tool.risk_level });
    return { waiting: true, waitingMessage: `Confirm ${actionName} before Woody continues`, output: null };
  }
  if (authorization.status === 'denied') throw Object.assign(new Error(authorization.reason), { retryable: false });
  if (authorization.status === 'completed') {
    setNodeOutput(authorization.result);
    return { output: authorization.result, result: authorization.result };
  }
  if (!(await beginWorkflowAction(authorization.authorizationId))) throw Object.assign(new Error('External action execution could not be claimed safely'), { retryable: false });
  await emitEvent('mcp.tool.called', `Calling ${actionName}`, { authorizationId: authorization.authorizationId, toolId: tool.id });
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
      workflowActionAuthorizationId: authorization.authorizationId,
    });
    await completeWorkflowAction(authorization.authorizationId, executed.result);
    await emitEvent('mcp.tool.completed', `${actionName} completed`, { authorizationId: authorization.authorizationId, toolCallId: executed.callId, toolId: tool.id });
    setNodeOutput(executed.result);
    return { output: executed.result, result: executed.result };
  } catch (error) {
    await failWorkflowAction(authorization.authorizationId, error);
    throw error;
  }
}
