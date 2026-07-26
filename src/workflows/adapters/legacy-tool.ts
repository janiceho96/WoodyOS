import { query } from '../../db/client.js';
import { invokeTool, toolRequiresApproval, type ToolRecord } from '../../tools/runtime.js';
import { retryPolicy } from '../definition.js';
import type { WorkflowAdapterContext } from './types.js';
import { assertWorkflowRunManifestDependencies } from '../../runtime/manifest.js';
import { childTraceContext } from '../../runtime/trace.js';
import { uncertainActionOutcome } from '../../runtime/errors.js';

export async function executeLegacyToolNode(context: WorkflowAdapterContext) {
  const { execution, run, node, cursor, iterationKey, emitEvent, resolve, setNodeOutput } = context;
  await assertWorkflowRunManifestDependencies(run);
  const toolId = node.config.toolId;
  if (typeof toolId !== 'string') throw new Error(`Action node ${node.id} has no toolId`);
  const tool = (await query<ToolRecord>('SELECT id,name,kind,config,permissions FROM tools WHERE id=$1 AND workspace_id=$2 AND enabled=true', [toolId, run.workspace_id])).rows[0];
  if (!tool) throw new Error(`Action node ${node.id} references an unavailable tool`);
  if (toolRequiresApproval(tool)) {
    const nonRetryable = (message: string) => Object.assign(new Error(message), { retryable: false });
    if (retryPolicy(node).maxAttempts > 1) throw nonRetryable(`Write-capable action ${node.id} cannot use automatic retries`);
    const previous = run.definition_snapshot.nodes.find((candidate) => candidate.id === cursor.previousNodeId);
    if (!previous || previous.type !== 'approval') throw nonRetryable(`Write-capable action ${node.id} requires a directly preceding approval node`);
    const approved = (await query<{ approved: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM workflow_run_node_states
       WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND status='completed') approved`,
      [run.id, previous.id, iterationKey],
    )).rows[0]?.approved;
    if (!approved) throw nonRetryable(`Write-capable action ${node.id} has no completed approval for this loop iteration`);
  }
  const configuredInput = node.config.input && typeof node.config.input === 'object' && !Array.isArray(node.config.input) ? node.config.input : run.state;
  const input = resolve(configuredInput) as Record<string, unknown>;
  const actionTrace = childTraceContext(execution.trace);
  await emitEvent('tool.called', `Calling ${tool.name}`, { toolId: tool.id, iterationKey, attempt: cursor.attempt }, actionTrace);
  let output: unknown;
  try {
    output = await invokeTool(tool, input);
  } catch (error) {
    if (toolRequiresApproval(tool)) throw uncertainActionOutcome(error);
    throw error;
  }
  await emitEvent('tool.completed', `${tool.name} completed`, { toolId: tool.id, iterationKey, attempt: cursor.attempt }, actionTrace);
  setNodeOutput(output);
  return { output, result: output };
}
