import { query } from '../db/client.js';
import { enqueueWorkflowRun } from '../queue/task-queue.js';
import { invokeTool, toolRequiresApproval, type ToolRecord } from '../tools/runtime.js';
import { artifactFormatSchema, type ArtifactFormat } from '../artifacts/types.js';
import { requestWorkflowArtifacts } from '../artifacts/service.js';
import { evaluateCondition, retryPolicy, valueAtPath, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from './definition.js';

type LoopCursor = { iteration: number };
type WorkflowCursor = { nodeId: string; loops: Record<string, LoopCursor>; attempt: number; previousNodeId?: string };
type WorkflowRun = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  input: Record<string, unknown>;
  definition_snapshot: WorkflowDefinition;
  state: Record<string, unknown>;
  cursor: WorkflowCursor | null;
  step_count: number;
  name: string;
  created_by: string;
};

type AgentTaskResult = null | Record<string, unknown>;
export type AgentTaskExecutor = (taskId: string) => Promise<AgentTaskResult>;

async function workflowEvent(run: WorkflowRun, nodeId: string | null, type: string, message: string, payload: Record<string, unknown> = {}) {
  await query('INSERT INTO workflow_run_events(workspace_id,workflow_run_id,node_id,event_type,message,payload) VALUES($1,$2,$3,$4,$5,$6)', [run.workspace_id, run.id, nodeId, type, message, JSON.stringify(payload)]);
}

function iterationKey(cursor: WorkflowCursor) {
  const entries = Object.entries(cursor.loops).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([id, value]) => `${id}:${value.iteration}`).join('|') : 'root';
}

function json(value: unknown) {
  return JSON.stringify(value === undefined ? null : value);
}

function resolveTemplates(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([^{}]+?)\s*}}$/);
    if (exact) return valueAtPath(state, exact[1]);
    return value.replace(/\{\{\s*([^{}]+?)\s*}}/g, (_, path: string) => {
      const resolved = valueAtPath(state, path);
      return resolved === undefined || resolved === null ? '' : typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, state));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveTemplates(item, state)]));
  return value;
}

async function startNode(run: WorkflowRun, node: WorkflowNode, cursor: WorkflowCursor) {
  const key = iterationKey(cursor);
  await query(
    `INSERT INTO workflow_run_node_states(workspace_id,workflow_run_id,node_id,iteration_key,attempt,status,input)
     VALUES($1,$2,$3,$4,$5,'running',$6)
     ON CONFLICT(workflow_run_id,node_id,iteration_key,attempt)
     DO UPDATE SET status='running',input=EXCLUDED.input,error=NULL,updated_at=now()`,
    [run.workspace_id, run.id, node.id, key, cursor.attempt, json(run.state)],
  );
  await workflowEvent(run, node.id, cursor.attempt > 1 ? 'node.retry_started' : 'node.started', `${node.type} node ${cursor.attempt > 1 ? `retry ${cursor.attempt}` : 'started'}`, { iterationKey: key, attempt: cursor.attempt });
}

async function completeNode(run: WorkflowRun, node: WorkflowNode, cursor: WorkflowCursor, output: unknown) {
  const key = iterationKey(cursor);
  await query(
    `UPDATE workflow_run_node_states SET status='completed',output=$1,completed_at=now(),updated_at=now()
      WHERE workflow_run_id=$2 AND node_id=$3 AND iteration_key=$4 AND attempt=$5`,
    [json(output), run.id, node.id, key, cursor.attempt],
  );
  await workflowEvent(run, node.id, 'node.completed', `${node.type} node completed`, { iterationKey: key, attempt: cursor.attempt });
}

async function waitNode(run: WorkflowRun, node: WorkflowNode, cursor: WorkflowCursor, message: string) {
  const key = iterationKey(cursor);
  await query(
    `UPDATE workflow_run_node_states SET status='waiting',updated_at=now()
      WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND attempt=$4`,
    [run.id, node.id, key, cursor.attempt],
  );
  await query("UPDATE workflow_runs SET status='awaiting_approval',updated_at=now() WHERE id=$1", [run.id]);
  await workflowEvent(run, node.id, 'node.waiting', message, { iterationKey: key, attempt: cursor.attempt });
}

function outgoing(definition: WorkflowDefinition, nodeId: string) {
  return definition.edges.filter((edge) => edge.source === nodeId);
}

function edgeFor(node: WorkflowNode, edges: WorkflowEdge[], result: unknown) {
  if (node.type === 'condition') return edges.find((edge) => edge.condition === String(Boolean(result)));
  if (node.type === 'loop') return edges.find((edge) => edge.condition === result);
  return edges[0];
}

function artifactFormats(node: WorkflowNode): ArtifactFormat[] {
  const raw = Array.isArray(node.config.artifactFormats) ? node.config.artifactFormats : [];
  return [...new Set(raw.map((item) => artifactFormatSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data))];
}

function retryDelay(node: WorkflowNode, attempt: number) {
  const policy = retryPolicy(node);
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * Math.pow(policy.multiplier, Math.max(0, attempt - 1)));
}

async function failOrRetry(run: WorkflowRun, node: WorkflowNode, cursor: WorkflowCursor, error: unknown) {
  const message = (error instanceof Error ? error.message : 'Workflow node failed').slice(0, 2000);
  const key = iterationKey(cursor);
  await query(
    `UPDATE workflow_run_node_states SET status='failed',error=$1,completed_at=now(),updated_at=now()
      WHERE workflow_run_id=$2 AND node_id=$3 AND iteration_key=$4 AND attempt=$5`,
    [json({ message }), run.id, node.id, key, cursor.attempt],
  );
  await workflowEvent(run, node.id, 'node.failed', message, { iterationKey: key, attempt: cursor.attempt });
  const policy = retryPolicy(node);
  const retryable = !(error && typeof error === 'object' && 'retryable' in error && (error as { retryable?: unknown }).retryable === false);
  if (retryable && ['agent', 'action'].includes(node.type) && cursor.attempt < policy.maxAttempts) {
    const nextAttempt = cursor.attempt + 1;
    const delay = retryDelay(node, cursor.attempt);
    const nextCursor = { ...cursor, attempt: nextAttempt };
    const nextStep = run.step_count + 1;
    await query("UPDATE workflow_runs SET status='queued',cursor=$1,step_count=$2,updated_at=now() WHERE id=$3", [json(nextCursor), nextStep, run.id]);
    await workflowEvent(run, node.id, 'node.retry_scheduled', `Retry ${nextAttempt} scheduled`, { iterationKey: key, attempt: nextAttempt, delayMs: delay });
    await enqueueWorkflowRun(run.id, `${run.id}:step:${nextStep}:${node.id}:${key}:${nextAttempt}`, delay);
    return true;
  }
  await query("UPDATE workflow_runs SET status='failed',output=$1,completed_at=now(),updated_at=now() WHERE id=$2", [json({ error: message, state: run.state }), run.id]);
  await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
  await workflowEvent(run, null, 'workflow.failed', message, { nodeId: node.id, iterationKey: key, attempt: cursor.attempt });
  return false;
}

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

async function executeNode(run: WorkflowRun, node: WorkflowNode, cursor: WorkflowCursor, executeAgentTask: AgentTaskExecutor) {
  if (node.type === 'trigger') return { result: run.input, output: run.input };
  if (node.type === 'condition') {
    const result = evaluateCondition(node.config, run.state);
    run.state[node.id] = result;
    await workflowEvent(run, node.id, 'branch.evaluated', `Condition selected the ${result ? 'true' : 'false'} branch`, { result, path: node.config.path ?? node.config.key });
    return { result, output: result };
  }
  if (node.type === 'loop') {
    const result = loopResult(node, cursor, run.state);
    run.state[node.id] = result.output;
    await workflowEvent(run, node.id, result.branch === 'body' ? 'loop.iteration' : 'loop.completed', result.branch === 'body' ? `Loop iteration ${(result.output as { iteration: number }).iteration + 1} started` : 'Loop exit selected', result.output as Record<string, unknown>);
    return { result: result.branch, output: result.output };
  }
  if (node.type === 'approval') {
    const key = iterationKey(cursor);
    const approval = (await query<{ id: string; status: string }>('SELECT id,status FROM workflow_approvals WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND attempt=$4 ORDER BY requested_at DESC LIMIT 1', [run.id, node.id, key, cursor.attempt])).rows[0];
    if (!approval) {
      await query('INSERT INTO workflow_approvals(workspace_id,workflow_run_id,node_id,iteration_key,attempt) VALUES($1,$2,$3,$4,$5)', [run.workspace_id, run.id, node.id, key, cursor.attempt]);
      return { waiting: true, output: null };
    }
    if (approval.status === 'pending') return { waiting: true, output: null };
    if (approval.status === 'rejected') throw new Error(`Approval for ${node.id} was rejected`);
    const output = { approved: true, approvalId: approval.id };
    run.state[node.id] = output;
    return { output, result: output };
  }
  if (node.type === 'action') {
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
        `SELECT EXISTS(
           SELECT 1 FROM workflow_run_node_states
            WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND status='completed'
         ) approved`,
        [run.id, previous.id, iterationKey(cursor)],
      )).rows[0]?.approved;
      if (!approved) throw nonRetryable(`Write-capable action ${node.id} has no completed approval for this loop iteration`);
    }
    const configuredInput = node.config.input && typeof node.config.input === 'object' && !Array.isArray(node.config.input) ? node.config.input : run.state;
    await workflowEvent(run, node.id, 'tool.called', `Calling ${tool.name}`, { toolId: tool.id, iterationKey: iterationKey(cursor), attempt: cursor.attempt });
    const output = await invokeTool(tool, resolveTemplates(configuredInput, run.state) as Record<string, unknown>);
    await workflowEvent(run, node.id, 'tool.completed', `${tool.name} completed`, { toolId: tool.id, iterationKey: iterationKey(cursor), attempt: cursor.attempt });
    run.state[node.id] = output;
    return { output, result: output };
  }
  if (node.type === 'agent') {
    const agentId = node.config.agentId;
    if (typeof agentId !== 'string') throw new Error(`Agent node ${node.id} has no agentId`);
    const key = iterationKey(cursor);
    let task = (await query<{ id: string; status: string; output: unknown; error: unknown }>(
      `SELECT id,status,output,error FROM tasks
        WHERE workflow_run_id=$1 AND workflow_node_id=$2 AND workflow_iteration_key=$3 AND workflow_attempt=$4`,
      [run.id, node.id, key, cursor.attempt],
    )).rows[0];
    if (!task) {
      const agentInput = {
        ...run.state,
        workflow: { name: run.name, runId: run.id, nodeId: node.id, iterationKey: key, attempt: cursor.attempt, responsibility: node.config.responsibility ?? null, expectedOutput: node.config.expectedOutput ?? null },
      };
      task = (await query<{ id: string; status: string; output: unknown; error: unknown }>(
        `INSERT INTO tasks(workspace_id,agent_id,workflow_run_id,workflow_node_id,workflow_iteration_key,workflow_attempt,title,input,requested_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,status,output,error`,
        [run.workspace_id, agentId, run.id, node.id, key, cursor.attempt, String(node.config.title ?? `Workflow ${run.name}`), json(agentInput), run.created_by],
      )).rows[0];
    }
    if (task.status === 'failed') throw new Error(typeof task.error === 'object' && task.error && 'message' in task.error ? String((task.error as { message: unknown }).message) : `Agent node ${node.id} failed`);
    let output = task.status === 'completed' ? task.output : await executeAgentTask(task.id);
    if (output && typeof output === 'object' && 'awaitingApproval' in output) return { waiting: true, output };
    if (output === null) {
      task = (await query<{ id: string; status: string; output: unknown; error: unknown }>('SELECT id,status,output,error FROM tasks WHERE id=$1', [task.id])).rows[0];
      if (task?.status === 'completed') output = task.output as Record<string, unknown>;
      else if (task?.status === 'awaiting_approval') return { waiting: true, output: null };
      else throw new Error(`Agent node ${node.id} did not produce an output`);
    }
    run.state[node.id] = output;
    return { output, result: output };
  }
  if (node.config.output && typeof node.config.output === 'object' && !Array.isArray(node.config.output)) Object.assign(run.state, node.config.output as Record<string, unknown>);
  const fromNodeId = node.config.fromNodeId;
  const output = typeof fromNodeId === 'string' ? run.state[fromNodeId] : run.state;
  if (typeof fromNodeId === 'string' && !(fromNodeId in run.state)) throw new Error(`Output node ${node.id} references unavailable result ${fromNodeId}`);
  return { output, result: output, finished: true };
}

export async function executeWorkflowStep(workflowRunId: string, executeAgentTask: AgentTaskExecutor) {
  const run = (await query<WorkflowRun>(
    `UPDATE workflow_runs r SET status='running',started_at=COALESCE(started_at,now()),updated_at=now()
      FROM workflows w WHERE r.id=$1 AND r.workflow_id=w.id AND r.status='queued'
      RETURNING r.*,w.name,w.created_by`,
    [workflowRunId],
  )).rows[0];
  if (!run) return null;
  if (run.step_count > 10_000) {
    await query("UPDATE workflow_runs SET status='failed',output=$1,completed_at=now(),updated_at=now() WHERE id=$2", [json({ error: 'Workflow exceeded the 10000-step safety limit', state: run.state }), run.id]);
    await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
    return null;
  }
  const cursor = run.cursor;
  if (!cursor?.nodeId) {
    await query("UPDATE workflow_runs SET status='failed',output=$1,completed_at=now(),updated_at=now() WHERE id=$2", [json({ error: 'Workflow cursor is missing', state: run.state }), run.id]);
    await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
    await workflowEvent(run, null, 'workflow.failed', 'Workflow cursor is missing');
    return null;
  }
  cursor.loops ??= {};
  cursor.attempt ??= 1;
  const node = run.definition_snapshot.nodes.find((candidate) => candidate.id === cursor.nodeId);
  if (!node) {
    const message = `Workflow cursor references missing node ${cursor.nodeId}`;
    await query("UPDATE workflow_runs SET status='failed',output=$1,completed_at=now(),updated_at=now() WHERE id=$2", [json({ error: message, state: run.state }), run.id]);
    await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
    await workflowEvent(run, null, 'workflow.failed', message);
    return null;
  }
  try {
    if (run.step_count === 0) await workflowEvent(run, null, 'workflow.started', `${run.name} started`);
    await startNode(run, node, cursor);
    const execution = await executeNode(run, node, cursor, executeAgentTask);
    if (execution.waiting) {
      await waitNode(run, node, cursor, node.type === 'approval' ? 'Human approval is required' : 'Agent tool confirmation is required');
      return { waiting: true };
    }
    await completeNode(run, node, cursor, execution.output);
    if (execution.finished || node.type === 'output') {
      const finalOutput = execution.output ?? run.state;
      await query("UPDATE workflow_runs SET status='completed',output=$1,state=$2,cursor=NULL,step_count=step_count+1,completed_at=now(),updated_at=now() WHERE id=$3", [json(finalOutput), json(run.state), run.id]);
      await workflowEvent(run, null, 'workflow.completed', `${run.name} completed`, { steps: run.step_count + 1 });
      const formats = artifactFormats(node);
      await query(
        "UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending' AND NOT(format=ANY($2::text[]))",
        [run.id, formats],
      );
      if (formats.length) {
        try { await requestWorkflowArtifacts({ workspaceId: run.workspace_id, createdBy: run.created_by, workflowRunId: run.id, title: run.name, formats, ready: true }); }
        catch (artifactError) { await workflowEvent(run, null, 'artifacts.queue_failed', 'Workflow completed, but downloadable files could not be queued', { error: artifactError instanceof Error ? artifactError.message : 'Artifact queue unavailable' }); }
      }
      return { completed: true, output: finalOutput };
    }
    const edge = edgeFor(node, outgoing(run.definition_snapshot, node.id), execution.result);
    if (!edge) throw new Error(`Node ${node.id} did not resolve an outgoing edge`);
    if (node.type === 'condition' || node.type === 'loop') await workflowEvent(run, node.id, 'branch.selected', `Selected ${edge.condition} → ${edge.target}`, { condition: edge.condition, target: edge.target });
    if (edge.condition === 'continue') {
      const loop = cursor.loops[edge.target];
      if (!loop) throw new Error(`Continue edge returned to inactive loop ${edge.target}`);
      cursor.loops[edge.target] = { iteration: loop.iteration + 1 };
    }
    if (node.type === 'loop' && execution.result === 'done') delete cursor.loops[node.id];
    const nextCursor: WorkflowCursor = { nodeId: edge.target, loops: cursor.loops, attempt: 1, previousNodeId: node.id };
    const nextStep = run.step_count + 1;
    await query("UPDATE workflow_runs SET status='queued',state=$1,cursor=$2,step_count=$3,updated_at=now() WHERE id=$4", [json(run.state), json(nextCursor), nextStep, run.id]);
    try {
      await enqueueWorkflowRun(run.id, `${run.id}:step:${nextStep}:${edge.target}:${iterationKey(nextCursor)}`);
    } catch (queueError) {
      const message = `Workflow queue unavailable before node ${edge.target}: ${queueError instanceof Error ? queueError.message : 'unknown queue error'}`.slice(0, 2000);
      await query("UPDATE workflow_runs SET status='failed',output=$1,completed_at=now(),updated_at=now() WHERE id=$2", [json({ error: message, state: run.state }), run.id]);
      await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
      await workflowEvent(run, null, 'workflow.queue_failed', message, { nextNodeId: edge.target });
      return { failed: true };
    }
    return { queued: true, nextNodeId: edge.target };
  } catch (error) {
    await failOrRetry(run, node, cursor, error);
    return { failed: true };
  }
}
