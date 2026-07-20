import { workflowNodeDefinition } from '../registry.js';
import { executeAgentNode } from './agent.js';
import { executeApiActionNode } from './api.js';
import { executeFileNode } from './file.js';
import { executeKnowledgeSearchNode } from './knowledge.js';
import { executeLegacyToolNode } from './legacy-tool.js';
import { executeLogicNode } from './logic.js';
import { executeMcpActionNode } from './mcp.js';
import type { WorkflowAdapterContext, WorkflowAdapterExecution, WorkflowNodeExecutor } from './types.js';

const executors = {
  logic: executeLogicNode,
  agent: executeAgentNode,
  legacy_tool: executeLegacyToolNode,
  api: executeApiActionNode,
  mcp: executeMcpActionNode,
  knowledge: executeKnowledgeSearchNode,
  file: executeFileNode,
} satisfies Record<string, WorkflowNodeExecutor>;

export async function executeRegisteredWorkflowNode(context: WorkflowAdapterContext): Promise<WorkflowAdapterExecution> {
  const definition = workflowNodeDefinition(context.node.type);
  if (!definition?.available) throw Object.assign(new Error(`Workflow node ${context.node.type} is not available`), { retryable: false });
  const executor = executors[definition.adapter];
  if (!executor) throw Object.assign(new Error(`Workflow adapter ${definition.adapter} is not installed`), { retryable: false });
  return executor(context);
}
