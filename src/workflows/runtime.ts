import { query } from '../db/client.js';
import { enqueueWorkflowRun } from '../queue/task-queue.js';
import { artifactFormatSchema, type ArtifactFormat } from '../artifacts/types.js';
import { requestWorkflowArtifacts } from '../artifacts/service.js';
import { retryPolicy, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from './definition.js';
import { executeRegisteredWorkflowNode } from './adapters/index.js';
import { resolveWorkflowTemplates } from './adapters/templates.js';
import type { AgentTaskExecutor, WorkflowCursor, WorkflowRunRecord } from './adapters/types.js';
import { workflowNodeDefinition } from './registry.js';
import { redactRuntimeMessage, redactRuntimeValue, serializeRuntimeError } from '../runtime/errors.js';
import {
  authoritativeTraceContext,
  childTraceContext,
  type TraceContext,
} from '../runtime/trace.js';
import { assertManifestCompatible } from '../runtime/manifest.js';

export type { AgentTaskExecutor } from './adapters/types.js';
export { loopResult } from './adapters/logic.js';

async function workflowEvent(
  run: WorkflowRunRecord,
  nodeId: string | null,
  type: string,
  message: string,
  payload: Record<string, unknown> = {},
  parentTrace: TraceContext = authoritativeTraceContext(run),
) {
  const trace = childTraceContext(parentTrace);
  await query(
    `INSERT INTO workflow_run_events(
       workspace_id,workflow_run_id,node_id,event_type,message,payload,trace_id,span_id,parent_span_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      run.workspace_id,
      run.id,
      nodeId,
      type,
      redactRuntimeMessage(message),
      JSON.stringify(redactRuntimeValue(payload)),
      trace.traceId,
      trace.spanId,
      trace.parentSpanId,
    ],
  );
}

function iterationKey(cursor: WorkflowCursor) {
  const entries = Object.entries(cursor.loops).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([id, value]) => `${id}:${value.iteration}`).join('|') : 'root';
}

function json(value: unknown) {
  return JSON.stringify(value === undefined ? null : value);
}

function workflowFailure(error: unknown, state: Record<string, unknown>) {
  const serialized = serializeRuntimeError(error);
  return {
    serialized,
    output: json({ error: serialized, state }),
    error: json(serialized),
  };
}

async function startNode(run: WorkflowRunRecord, node: WorkflowNode, cursor: WorkflowCursor, trace: TraceContext) {
  const key = iterationKey(cursor);
  await query(
    `INSERT INTO workflow_run_node_states(
       workspace_id,workflow_run_id,node_id,iteration_key,attempt,status,input,trace_id,span_id,parent_span_id
     ) VALUES($1,$2,$3,$4,$5,'running',$6,$7,$8,$9)
     ON CONFLICT(workflow_run_id,node_id,iteration_key,attempt)
     DO UPDATE SET status='running',input=EXCLUDED.input,error=NULL,
       trace_id=EXCLUDED.trace_id,span_id=EXCLUDED.span_id,parent_span_id=EXCLUDED.parent_span_id,updated_at=now()`,
    [
      run.workspace_id,
      run.id,
      node.id,
      key,
      cursor.attempt,
      json(run.state),
      trace.traceId,
      trace.spanId,
      trace.parentSpanId,
    ],
  );
  await workflowEvent(run, node.id, cursor.attempt > 1 ? 'node.retry_started' : 'node.started', `${node.type} node ${cursor.attempt > 1 ? `retry ${cursor.attempt}` : 'started'}`, { iterationKey: key, attempt: cursor.attempt }, trace);
}

async function completeNode(run: WorkflowRunRecord, node: WorkflowNode, cursor: WorkflowCursor, output: unknown, trace: TraceContext) {
  const key = iterationKey(cursor);
  await query(
    `UPDATE workflow_run_node_states SET status='completed',output=$1,completed_at=now(),updated_at=now()
      WHERE workflow_run_id=$2 AND node_id=$3 AND iteration_key=$4 AND attempt=$5`,
    [json(output), run.id, node.id, key, cursor.attempt],
  );
  await workflowEvent(run, node.id, 'node.completed', `${node.type} node completed`, { iterationKey: key, attempt: cursor.attempt }, trace);
}

async function waitNode(run: WorkflowRunRecord, node: WorkflowNode, cursor: WorkflowCursor, message: string, trace: TraceContext) {
  const key = iterationKey(cursor);
  await query(
    `UPDATE workflow_run_node_states SET status='waiting',updated_at=now()
      WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND attempt=$4`,
    [run.id, node.id, key, cursor.attempt],
  );
  await query("UPDATE workflow_runs SET status='awaiting_approval',updated_at=now() WHERE id=$1", [run.id]);
  await workflowEvent(run, node.id, 'node.waiting', message, { iterationKey: key, attempt: cursor.attempt }, trace);
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

async function failOrRetry(run: WorkflowRunRecord, node: WorkflowNode, cursor: WorkflowCursor, error: unknown, trace: TraceContext) {
  const serialized = serializeRuntimeError(error);
  const message = serialized.message;
  const key = iterationKey(cursor);
  await query(
    `UPDATE workflow_run_node_states SET status='failed',error=$1,completed_at=now(),updated_at=now()
      WHERE workflow_run_id=$2 AND node_id=$3 AND iteration_key=$4 AND attempt=$5`,
    [json(serialized), run.id, node.id, key, cursor.attempt],
  );
  await workflowEvent(run, node.id, 'node.failed', message, { iterationKey: key, attempt: cursor.attempt, error: serialized }, trace);
  const policy = retryPolicy(node);
  const retryable = !(error && typeof error === 'object' && 'retryable' in error && (error as { retryable?: unknown }).retryable === false);
  if (retryable && workflowNodeDefinition(node.type)?.retryable && cursor.attempt < policy.maxAttempts) {
    const nextAttempt = cursor.attempt + 1;
    const delay = retryDelay(node, cursor.attempt);
    const nextCursor = { ...cursor, attempt: nextAttempt };
    const nextStep = run.step_count + 1;
    await query("UPDATE workflow_runs SET status='queued',cursor=$1,step_count=$2,updated_at=now() WHERE id=$3", [json(nextCursor), nextStep, run.id]);
    await workflowEvent(run, node.id, 'node.retry_scheduled', `Retry ${nextAttempt} scheduled`, { iterationKey: key, attempt: nextAttempt, delayMs: delay }, trace);
    await enqueueWorkflowRun(run.id, `${run.id}:step:${nextStep}:${node.id}:${key}:${nextAttempt}`, delay, run.trace_id);
    return true;
  }
  await query(
    "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3",
    [json({ error: serialized, state: run.state }), json(serialized), run.id],
  );
  await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
  await workflowEvent(run, null, 'workflow.failed', message, { nodeId: node.id, iterationKey: key, attempt: cursor.attempt, error: serialized }, trace);
  return false;
}

export async function executeWorkflowStep(workflowRunId: string, executeAgentTask: AgentTaskExecutor) {
  const run = (await query<WorkflowRunRecord>(
    `UPDATE workflow_runs r SET status='running',started_at=COALESCE(started_at,now()),updated_at=now()
      FROM workflows w WHERE r.id=$1 AND r.workflow_id=w.id AND r.status='queued'
      RETURNING r.*,w.name,w.created_by`,
    [workflowRunId],
  )).rows[0];
  if (!run) return null;
  if (run.step_count > 10_000) {
    const failure = workflowFailure('Workflow exceeded the 10000-step safety limit', run.state);
    await query("UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3", [failure.output, failure.error, run.id]);
    await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
    return null;
  }
  const cursor = run.cursor;
  if (!cursor?.nodeId) {
    const failure = workflowFailure('Workflow cursor is missing', run.state);
    await query("UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3", [failure.output, failure.error, run.id]);
    await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
    await workflowEvent(run, null, 'workflow.failed', 'Workflow cursor is missing');
    return null;
  }
  cursor.loops ??= {};
  cursor.attempt ??= 1;
  const node = run.definition_snapshot.nodes.find((candidate) => candidate.id === cursor.nodeId);
  if (!node) {
    const message = `Workflow cursor references missing node ${cursor.nodeId}`;
    const failure = workflowFailure(message, run.state);
    await query("UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3", [failure.output, failure.error, run.id]);
    await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
    await workflowEvent(run, null, 'workflow.failed', message);
    return null;
  }
  const runTrace = authoritativeTraceContext(run);
  const nodeTrace = childTraceContext(runTrace);
  try {
    if (run.step_count === 0) await workflowEvent(run, null, 'workflow.started', `${run.name} started`);
    await startNode(run, node, cursor, nodeTrace);
    const key = iterationKey(cursor);
    const execution = await executeRegisteredWorkflowNode({
      execution: {
        trace: nodeTrace,
        signal: new AbortController().signal,
        ...(run.run_mode === 'production'
          ? { mode: 'production' as const, manifest: assertManifestCompatible(run.execution_manifest) }
          : { mode: 'test' as const, manifest: null }),
      },
      run,
      node,
      cursor,
      iterationKey: key,
      executeAgentTask,
      emitEvent: (type, message, payload = {}, trace = nodeTrace) => workflowEvent(run, node.id, type, message, payload, trace),
      resolve: (value) => resolveWorkflowTemplates(value, run.state),
      setNodeOutput: (value) => {
        run.state[node.id] = value;
        const nodeState = run.state.nodes && typeof run.state.nodes === 'object' && !Array.isArray(run.state.nodes)
          ? run.state.nodes as Record<string, unknown>
          : {};
        nodeState[node.id] = value;
        run.state.nodes = nodeState;
      },
    });
    if (execution.waiting) {
      await waitNode(run, node, cursor, execution.waitingMessage ?? 'Human confirmation is required', nodeTrace);
      return { waiting: true };
    }
    await completeNode(run, node, cursor, execution.output, nodeTrace);
    if (run.test_target_node_id === node.id) {
      const testOutput = execution.output ?? run.state[node.id] ?? null;
      await query("UPDATE workflow_runs SET status='completed',output=$1,state=$2,cursor=NULL,step_count=step_count+1,completed_at=now(),updated_at=now() WHERE id=$3", [json(testOutput), json(run.state), run.id]);
      await workflowEvent(run, null, 'workflow.node_test_completed', `${node.type} node test completed`, { nodeId: node.id, steps: run.step_count + 1 });
      return { completed: true, output: testOutput };
    }
    if (execution.finished || node.type === 'output') {
      if (run.test_target_node_id) {
        const message = `Test path completed before reaching node ${run.test_target_node_id}`;
        const failure = workflowFailure(message, run.state);
        await query("UPDATE workflow_runs SET status='failed',output=$1,error=$2,state=$3,cursor=NULL,step_count=step_count+1,completed_at=now(),updated_at=now() WHERE id=$4", [failure.output, failure.error, json(run.state), run.id]);
        await workflowEvent(run, null, 'workflow.node_test_target_not_reached', message, { nodeId: run.test_target_node_id });
        return { failed: true };
      }
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
      await enqueueWorkflowRun(run.id, `${run.id}:step:${nextStep}:${edge.target}:${iterationKey(nextCursor)}`, 0, run.trace_id);
    } catch (queueError) {
      const message = `Workflow queue unavailable before node ${edge.target}: ${queueError instanceof Error ? queueError.message : 'unknown queue error'}`.slice(0, 2000);
      const failure = workflowFailure(message, run.state);
      await query("UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3", [failure.output, failure.error, run.id]);
      await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id]);
      await workflowEvent(run, null, 'workflow.queue_failed', message, { nextNodeId: edge.target });
      return { failed: true };
    }
    return { queued: true, nextNodeId: edge.target };
  } catch (error) {
    await failOrRetry(run, node, cursor, error, nodeTrace);
    return { failed: true };
  }
}
