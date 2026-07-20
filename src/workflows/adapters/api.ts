import { query } from '../../db/client.js';
import { authorizeWorkflowAction, beginWorkflowAction, completeWorkflowAction, failWorkflowAction } from '../../policy/action-gateway.js';
import { invokeTool, toolRiskLevel, type ToolRecord } from '../../tools/runtime.js';
import type { WorkflowAdapterContext } from './types.js';
import { limitedActionResult } from '../../lib/action-safety.js';

export async function executeApiActionNode(context: WorkflowAdapterContext) {
  const { run, node, cursor, iterationKey, emitEvent, resolve, setNodeOutput } = context;
  const toolId = node.config.toolId;
  if (typeof toolId !== 'string') throw new Error(`API action ${node.id} has no toolId`);
  const tool = (await query<ToolRecord>(
    "SELECT id,name,kind,config,permissions FROM tools WHERE id=$1 AND workspace_id=$2 AND enabled=true AND kind <> 'mcp'",
    [toolId, run.workspace_id],
  )).rows[0];
  if (!tool) throw Object.assign(new Error(`API action ${node.id} references an unavailable tool`), { retryable: false });
  const configuredInput = node.config.input && typeof node.config.input === 'object' && !Array.isArray(node.config.input) ? node.config.input : run.state;
  const arguments_ = resolve(configuredInput) as Record<string, unknown>;
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
    arguments: arguments_,
    requestedBy: run.created_by,
    targetSummary: tool.name,
  });
  if (authorization.status === 'awaiting_confirmation') {
    await emitEvent('action.confirmation_requested', `Confirmation is required before ${tool.name}`, { authorizationId: authorization.authorizationId, toolId: tool.id });
    return { waiting: true, waitingMessage: `Confirm ${tool.name} before Woody continues`, output: null };
  }
  if (authorization.status === 'denied') throw Object.assign(new Error(authorization.reason), { retryable: false });
  if (authorization.status === 'completed') {
    setNodeOutput(authorization.result);
    return { output: authorization.result, result: authorization.result };
  }
  if (!(await beginWorkflowAction(authorization.authorizationId))) throw Object.assign(new Error('External action execution could not be claimed safely'), { retryable: false });
  await emitEvent('api.called', `Calling ${tool.name}`, { authorizationId: authorization.authorizationId, toolId: tool.id });
  try {
    const output = limitedActionResult(await invokeTool(tool, arguments_));
    await completeWorkflowAction(authorization.authorizationId, output);
    await emitEvent('api.completed', `${tool.name} completed`, { authorizationId: authorization.authorizationId, toolId: tool.id });
    setNodeOutput(output);
    return { output, result: output };
  } catch (error) {
    await failWorkflowAction(authorization.authorizationId, error);
    throw error;
  }
}
