import { query } from '../../db/client.js';
import type { WorkflowAdapterContext } from './types.js';
import { resolveNodeInput } from './templates.js';

function json(value: unknown) {
  return JSON.stringify(value === undefined ? null : value);
}

export async function executeAgentNode(context: WorkflowAdapterContext) {
  const { run, node, cursor, iterationKey, executeAgentTask, setNodeOutput } = context;
  const agentId = node.config.agentId;
  if (typeof agentId !== 'string') throw new Error(`Agent node ${node.id} has no agentId`);
  let task = (await query<{ id: string; status: string; output: unknown; error: unknown }>(
    `SELECT id,status,output,error FROM tasks
     WHERE workflow_run_id=$1 AND workflow_node_id=$2 AND workflow_iteration_key=$3 AND workflow_attempt=$4`,
    [run.id, node.id, iterationKey, cursor.attempt],
  )).rows[0];
  if (!task) {
    const inputMapping = node.config.inputMapping && typeof node.config.inputMapping === 'object' && !Array.isArray(node.config.inputMapping)
      ? node.config.inputMapping as Record<string, unknown>
      : undefined;
    const mappedInput = resolveNodeInput(inputMapping, run.state);
    const agentInput = {
      ...mappedInput,
      workflow: { name: run.name, runId: run.id, nodeId: node.id, iterationKey, attempt: cursor.attempt, responsibility: node.config.responsibility ?? null, expectedOutput: node.config.expectedOutput ?? null, outputContract: node.config.outputContract ?? 'text' },
    };
    task = (await query<{ id: string; status: string; output: unknown; error: unknown }>(
      `INSERT INTO tasks(workspace_id,agent_id,workflow_run_id,workflow_node_id,workflow_iteration_key,workflow_attempt,title,input,requested_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,status,output,error`,
      [run.workspace_id, agentId, run.id, node.id, iterationKey, cursor.attempt, String(node.config.title ?? `Workflow ${run.name}`), json(agentInput), run.created_by],
    )).rows[0];
  }
  if (task.status === 'failed') throw new Error(typeof task.error === 'object' && task.error && 'message' in task.error ? String((task.error as { message: unknown }).message) : `Agent node ${node.id} failed`);
  let output = task.status === 'completed' ? task.output : await executeAgentTask(task.id);
  if (output && typeof output === 'object' && 'awaitingApproval' in output) return { waiting: true, waitingMessage: 'Agent tool confirmation is required', output };
  if (output === null) {
    task = (await query<{ id: string; status: string; output: unknown; error: unknown }>('SELECT id,status,output,error FROM tasks WHERE id=$1', [task.id])).rows[0];
    if (task?.status === 'completed') output = task.output as Record<string, unknown>;
    else if (task?.status === 'awaiting_approval') return { waiting: true, waitingMessage: 'Agent tool confirmation is required', output: null };
    else throw new Error(`Agent node ${node.id} did not produce an output`);
  }
  setNodeOutput(output);
  return { output, result: output };
}
