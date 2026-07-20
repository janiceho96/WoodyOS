import { query } from '../../db/client.js';
import { evaluateCondition, valueAtPath, type WorkflowNode } from '../definition.js';
import type { WorkflowAdapterContext, WorkflowCursor } from './types.js';

export function loopResult(node: WorkflowNode, cursor: WorkflowCursor, state: Record<string, unknown>) {
  const mode = String(node.config.mode ?? 'forEach');
  const maxIterations = Number(node.config.maxIterations ?? 10);
  const onLimit = String(node.config.onLimit ?? 'fail');
  const loop = cursor.loops[node.id] ?? { iteration: 0 };
  if (mode === 'forEach') {
    const collection = valueAtPath(state, String(node.config.collectionPath ?? ''));
    if (!Array.isArray(collection)) throw new Error(`Loop ${node.id} collection is not an array`);
    if (loop.iteration >= collection.length) return { branch: 'done', output: { iterations: loop.iteration, reason: 'collection_complete' } };
    if (loop.iteration >= maxIterations) {
      if (onLimit === 'exit') return { branch: 'done', output: { iterations: loop.iteration, reason: 'limit_exit' } };
      throw new Error(`Loop ${node.id} reached its ${maxIterations} iteration safety limit`);
    }
    const itemVariable = String(node.config.itemVariable ?? 'item');
    const indexVariable = String(node.config.indexVariable ?? 'index');
    state[itemVariable] = collection[loop.iteration];
    state[indexVariable] = loop.iteration;
    cursor.loops[node.id] = loop;
    return { branch: 'body', output: { iteration: loop.iteration, item: collection[loop.iteration] } };
  }
  const condition = node.config.condition;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error(`Loop ${node.id} has no valid while condition`);
  const shouldContinue = evaluateCondition(condition as Record<string, unknown>, state);
  if (!shouldContinue) return { branch: 'done', output: { iterations: loop.iteration, reason: 'condition_false' } };
  if (loop.iteration >= maxIterations) {
    if (onLimit === 'exit') return { branch: 'done', output: { iterations: loop.iteration, reason: 'limit_exit' } };
    throw new Error(`Loop ${node.id} reached its ${maxIterations} iteration safety limit`);
  }
  cursor.loops[node.id] = loop;
  return { branch: 'body', output: { iteration: loop.iteration, condition: true } };
}

export async function executeLogicNode(context: WorkflowAdapterContext) {
  const { run, node, cursor, iterationKey, emitEvent, setNodeOutput } = context;
  if (node.type === 'trigger') return { result: run.input, output: run.input };
  if (node.type === 'condition') {
    const result = evaluateCondition(node.config, run.state);
    setNodeOutput(result);
    await emitEvent('branch.evaluated', `Condition selected the ${result ? 'true' : 'false'} branch`, { result, path: node.config.path ?? node.config.key });
    return { result, output: result };
  }
  if (node.type === 'loop') {
    const result = loopResult(node, cursor, run.state);
    setNodeOutput(result.output);
    await emitEvent(result.branch === 'body' ? 'loop.iteration' : 'loop.completed', result.branch === 'body' ? `Loop iteration ${(result.output as { iteration: number }).iteration + 1} started` : 'Loop exit selected', result.output as Record<string, unknown>);
    return { result: result.branch, output: result.output };
  }
  if (node.type !== 'approval') throw new Error(`Logic adapter cannot execute ${node.type}`);
  const approval = (await query<{ id: string; status: string }>(
    'SELECT id,status FROM workflow_approvals WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND attempt=$4 ORDER BY requested_at DESC LIMIT 1',
    [run.id, node.id, iterationKey, cursor.attempt],
  )).rows[0];
  if (!approval) {
    await query('INSERT INTO workflow_approvals(workspace_id,workflow_run_id,node_id,iteration_key,attempt) VALUES($1,$2,$3,$4,$5)', [run.workspace_id, run.id, node.id, iterationKey, cursor.attempt]);
    return { waiting: true, waitingMessage: 'Human approval is required', output: null };
  }
  if (approval.status === 'pending') return { waiting: true, waitingMessage: 'Human approval is required', output: null };
  if (approval.status === 'rejected') throw Object.assign(new Error(`Approval for ${node.id} was rejected`), { retryable: false });
  const output = { approved: true, approvalId: approval.id };
  setNodeOutput(output);
  return { output, result: output };
}

