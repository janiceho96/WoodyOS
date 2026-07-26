import { query } from '../db/client.js';
import { enqueueWorkflowRun } from '../queue/task-queue.js';
import { artifactFormatSchema, type ArtifactFormat } from '../artifacts/types.js';
import { requestWorkflowArtifacts } from '../artifacts/service.js';
import { retryPolicy, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from './definition.js';
import { executeRegisteredWorkflowNode } from './adapters/index.js';
import { resolveWorkflowTemplates } from './adapters/templates.js';
import type { AgentTaskExecutor, WorkflowCursor, WorkflowRunRecord } from './adapters/types.js';
import { workflowNodeDefinition } from './registry.js';
import {
  redactRuntimeMessage,
  redactRuntimeValue,
  retryDecision,
  serializeRuntimeError,
} from '../runtime/errors.js';
import {
  authoritativeTraceContext,
  childTraceContext,
  type TraceContext,
} from '../runtime/trace.js';
import { assertManifestCompatible } from '../runtime/manifest.js';
import { cancellationError } from '../runtime/cancellation.js';
import { isLeaseFailure } from '../runtime/leases.js';
import {
  assertFencedMutation,
  type ExecutionLeaseContext,
} from '../runtime/leases.js';

export type { AgentTaskExecutor } from './adapters/types.js';
export { loopResult } from './adapters/logic.js';

async function workflowEvent(
  run: WorkflowRunRecord,
  nodeId: string | null,
  type: string,
  message: string,
  payload: Record<string, unknown> = {},
  parentTrace: TraceContext = authoritativeTraceContext(run),
  lease?: ExecutionLeaseContext,
) {
  const trace = childTraceContext(parentTrace);
  const inserted = await query(
    `INSERT INTO workflow_run_events(
       workspace_id,workflow_run_id,node_id,event_type,message,payload,trace_id,span_id,parent_span_id
     )
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
     WHERE (
       $10::text IS NULL
       OR EXISTS(
         SELECT 1 FROM execution_leases
         WHERE subject_type='workflow_run' AND subject_id=$2
           AND owner_id=$10 AND expires_at>now()
       )
     )
     RETURNING id`,
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
      lease?.ownerId ?? null,
    ],
  );
  await assertFencedMutation(inserted.rowCount, lease);
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

async function transitionActiveRun(
  sql: string,
  values: unknown[],
  lease?: ExecutionLeaseContext,
) {
  const ownerParameter = values.length + 1;
  const subjectParameter = values.length + 2;
  const fencedSql = lease
    ? sql.replace(
      /\s+RETURNING id$/,
      ` AND EXISTS(
          SELECT 1 FROM execution_leases
          WHERE subject_type='workflow_run' AND subject_id=$${subjectParameter}
            AND owner_id=$${ownerParameter} AND expires_at>now()
        )
        RETURNING id`,
    )
    : sql;
  const transition = await query(
    fencedSql,
    lease ? [...values, lease.ownerId, lease.subject.id] : values,
  );
  await assertFencedMutation(transition.rowCount, lease, cancellationError);
}

async function mutateWorkflowArtifacts(
  sql: string,
  values: unknown[],
  lease?: ExecutionLeaseContext,
) {
  if (!lease) return query(sql, values);
  const ownerParameter = values.length + 1;
  const subjectParameter = values.length + 2;
  return query(
    `${sql}
      AND EXISTS(
        SELECT 1 FROM execution_leases
        WHERE subject_type='workflow_run' AND subject_id=$${subjectParameter}
          AND owner_id=$${ownerParameter} AND expires_at>now()
      )`,
    [...values, lease.ownerId, lease.subject.id],
  );
}

async function startNode(run: WorkflowRunRecord, node: WorkflowNode, cursor: WorkflowCursor, trace: TraceContext, lease?: ExecutionLeaseContext) {
  const key = iterationKey(cursor);
  const started = await query(
    `INSERT INTO workflow_run_node_states(
       workspace_id,workflow_run_id,node_id,iteration_key,attempt,status,input,trace_id,span_id,parent_span_id
     )
     SELECT $1,$2,$3,$4,$5,'running',$6,$7,$8,$9
     WHERE (
       $10::text IS NULL
       OR EXISTS(
         SELECT 1 FROM execution_leases
         WHERE subject_type='workflow_run' AND subject_id=$2
           AND owner_id=$10 AND expires_at>now()
       )
     )
     ON CONFLICT(workflow_run_id,node_id,iteration_key,attempt)
     DO UPDATE SET status='running',input=EXCLUDED.input,error=NULL,
       trace_id=EXCLUDED.trace_id,span_id=EXCLUDED.span_id,parent_span_id=EXCLUDED.parent_span_id,updated_at=now()
     WHERE (
       $10::text IS NULL
       OR EXISTS(
         SELECT 1 FROM execution_leases
         WHERE subject_type='workflow_run' AND subject_id=$2
           AND owner_id=$10 AND expires_at>now()
       )
     )
     RETURNING id`,
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
      lease?.ownerId ?? null,
    ],
  );
  await assertFencedMutation(started.rowCount, lease);
  await workflowEvent(run, node.id, cursor.attempt > 1 ? 'node.retry_started' : 'node.started', `${node.type} node ${cursor.attempt > 1 ? `retry ${cursor.attempt}` : 'started'}`, { iterationKey: key, attempt: cursor.attempt }, trace, lease);
}

async function completeNode(run: WorkflowRunRecord, node: WorkflowNode, cursor: WorkflowCursor, output: unknown, trace: TraceContext, lease?: ExecutionLeaseContext) {
  const key = iterationKey(cursor);
  const completed = await query(
    `UPDATE workflow_run_node_states SET status='completed',output=$1,completed_at=now(),updated_at=now()
      WHERE workflow_run_id=$2 AND node_id=$3 AND iteration_key=$4 AND attempt=$5
        AND ($6::text IS NULL OR EXISTS(
          SELECT 1 FROM execution_leases
          WHERE subject_type='workflow_run' AND subject_id=$2
            AND owner_id=$6 AND expires_at>now()
        ))
      RETURNING id`,
    [json(output), run.id, node.id, key, cursor.attempt, lease?.ownerId ?? null],
  );
  await assertFencedMutation(completed.rowCount, lease);
  await workflowEvent(run, node.id, 'node.completed', `${node.type} node completed`, { iterationKey: key, attempt: cursor.attempt }, trace, lease);
}

async function waitNode(run: WorkflowRunRecord, node: WorkflowNode, cursor: WorkflowCursor, message: string, trace: TraceContext, lease?: ExecutionLeaseContext) {
  const key = iterationKey(cursor);
  const nodeWaiting = await query(
    `UPDATE workflow_run_node_states SET status='waiting',updated_at=now()
      WHERE workflow_run_id=$1 AND node_id=$2 AND iteration_key=$3 AND attempt=$4
        AND ($5::text IS NULL OR EXISTS(
          SELECT 1 FROM execution_leases
          WHERE subject_type='workflow_run' AND subject_id=$1
            AND owner_id=$5 AND expires_at>now()
        ))
      RETURNING id`,
    [run.id, node.id, key, cursor.attempt, lease?.ownerId ?? null],
  );
  await assertFencedMutation(nodeWaiting.rowCount, lease);
  const waiting = await query(
    `UPDATE workflow_runs SET status='awaiting_approval',updated_at=now()
      WHERE id=$1
        AND status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
        AND ($2::text IS NULL OR EXISTS(
          SELECT 1 FROM execution_leases
          WHERE subject_type='workflow_run' AND subject_id=$1
            AND owner_id=$2 AND expires_at>now()
        ))
      RETURNING id`,
    [run.id, lease?.ownerId ?? null],
  );
  await assertFencedMutation(waiting.rowCount, lease, cancellationError);
  await workflowEvent(run, node.id, 'node.waiting', message, { iterationKey: key, attempt: cursor.attempt }, trace, lease);
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

async function failOrRetry(run: WorkflowRunRecord, node: WorkflowNode, cursor: WorkflowCursor, error: unknown, trace: TraceContext, lease?: ExecutionLeaseContext) {
  const serialized = serializeRuntimeError(error);
  const policy = retryPolicy(node);
  const decision = retryDecision(serialized, {
    attempt: cursor.attempt,
    nodeRetryable: Boolean(workflowNodeDefinition(node.type)?.retryable),
    policy,
  });
  const persistedError = { ...serialized, retryDecision: decision };
  const message = serialized.message;
  const key = iterationKey(cursor);
  const nodeFailed = await query(
    `UPDATE workflow_run_node_states SET status='failed',error=$1,completed_at=now(),updated_at=now()
      WHERE workflow_run_id=$2 AND node_id=$3 AND iteration_key=$4 AND attempt=$5
        AND ($6::text IS NULL OR EXISTS(
          SELECT 1 FROM execution_leases
          WHERE subject_type='workflow_run' AND subject_id=$2
            AND owner_id=$6 AND expires_at>now()
        ))
      RETURNING id`,
    [json(persistedError), run.id, node.id, key, cursor.attempt, lease?.ownerId ?? null],
  );
  await assertFencedMutation(nodeFailed.rowCount, lease);
  await workflowEvent(run, node.id, 'node.failed', message, {
    iterationKey: key,
    attempt: cursor.attempt,
    error: serialized,
    retryDecision: decision,
  }, trace, lease);
  if (decision.retry) {
    const nextAttempt = cursor.attempt + 1;
    const delay = decision.delayMs;
    const nextCursor = { ...cursor, attempt: nextAttempt };
    const nextStep = run.step_count + 1;
    await transitionActiveRun(
      "UPDATE workflow_runs SET status='queued',cursor=$1,step_count=$2,updated_at=now() WHERE id=$3 AND status='running' RETURNING id",
      [json(nextCursor), nextStep, run.id],
      lease,
    );
    await workflowEvent(run, node.id, 'node.retry_scheduled', `Retry ${nextAttempt} scheduled`, {
      iterationKey: key,
      attempt: nextAttempt,
      delayMs: delay,
      retryDecision: decision,
    }, trace, lease);
    await enqueueWorkflowRun(run.id, `${run.id}:step:${nextStep}:${node.id}:${key}:${nextAttempt}`, delay, run.trace_id);
    return true;
  }
  await transitionActiveRun(
    "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3 AND status='running' RETURNING id",
    [json({ error: persistedError, state: run.state }), json(persistedError), run.id],
    lease,
  );
  await mutateWorkflowArtifacts("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id], lease);
  await workflowEvent(run, null, 'workflow.failed', message, {
    nodeId: node.id,
    iterationKey: key,
    attempt: cursor.attempt,
    error: serialized,
    retryDecision: decision,
  }, trace, lease);
  return false;
}

export async function executeWorkflowStep(
  workflowRunId: string,
  executeAgentTask: AgentTaskExecutor,
  signal: AbortSignal = new AbortController().signal,
  leaseOwnerId?: string,
) {
  signal.throwIfAborted();
  const lease: ExecutionLeaseContext | undefined = leaseOwnerId
    ? { subject: { kind: 'workflow_run', id: workflowRunId }, ownerId: leaseOwnerId }
    : undefined;
  const runClaim = await query<WorkflowRunRecord>(
    `UPDATE workflow_runs r SET status='running',started_at=COALESCE(started_at,now()),updated_at=now()
      FROM workflows w WHERE r.id=$1 AND r.workflow_id=w.id AND r.status IN ('queued','running')
        AND ($2::text IS NULL OR EXISTS(
          SELECT 1 FROM execution_leases
          WHERE subject_type='workflow_run' AND subject_id=r.id
            AND owner_id=$2 AND expires_at>now()
        ))
      RETURNING r.*,w.name,w.created_by`,
    [workflowRunId, leaseOwnerId ?? null],
  );
  await assertFencedMutation(runClaim.rowCount, lease);
  const run = runClaim.rows[0];
  if (!run) return null;
  const emitWorkflowEvent = (
    nodeId: string | null,
    type: string,
    message: string,
    payload: Record<string, unknown> = {},
    parentTrace: TraceContext = authoritativeTraceContext(run),
  ) => workflowEvent(run, nodeId, type, message, payload, parentTrace, lease);
  if (run.step_count > 10_000) {
    const failure = workflowFailure('Workflow exceeded the 10000-step safety limit', run.state);
    await transitionActiveRun(
      "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3 AND status='running' RETURNING id",
      [failure.output, failure.error, run.id],
      lease,
    );
    await mutateWorkflowArtifacts("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id], lease);
    return null;
  }
  const cursor = run.cursor;
  if (!cursor?.nodeId) {
    const failure = workflowFailure('Workflow cursor is missing', run.state);
    await transitionActiveRun(
      "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3 AND status='running' RETURNING id",
      [failure.output, failure.error, run.id],
      lease,
    );
    await mutateWorkflowArtifacts("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id], lease);
    await emitWorkflowEvent(null, 'workflow.failed', 'Workflow cursor is missing');
    return null;
  }
  cursor.loops ??= {};
  cursor.attempt ??= 1;
  const node = run.definition_snapshot.nodes.find((candidate) => candidate.id === cursor.nodeId);
  if (!node) {
    const message = `Workflow cursor references missing node ${cursor.nodeId}`;
    const failure = workflowFailure(message, run.state);
    await transitionActiveRun(
      "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3 AND status='running' RETURNING id",
      [failure.output, failure.error, run.id],
      lease,
    );
    await mutateWorkflowArtifacts("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id], lease);
    await emitWorkflowEvent(null, 'workflow.failed', message);
    return null;
  }
  const runTrace = authoritativeTraceContext(run);
  const nodeTrace = childTraceContext(runTrace);
  try {
    signal.throwIfAborted();
    if (run.step_count === 0) await emitWorkflowEvent(null, 'workflow.started', `${run.name} started`);
    signal.throwIfAborted();
    await startNode(run, node, cursor, nodeTrace, lease);
    const key = iterationKey(cursor);
    const execution = await executeRegisteredWorkflowNode({
      execution: {
        trace: nodeTrace,
        signal,
        leaseOwnerId,
        ...(run.run_mode === 'production'
          ? { mode: 'production' as const, manifest: assertManifestCompatible(run.execution_manifest) }
          : { mode: 'test' as const, manifest: null }),
      },
      run,
      node,
      cursor,
      iterationKey: key,
      executeAgentTask,
      emitEvent: (type, message, payload = {}, trace = nodeTrace) => emitWorkflowEvent(node.id, type, message, payload, trace),
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
    signal.throwIfAborted();
    if (execution.waiting) {
      await waitNode(run, node, cursor, execution.waitingMessage ?? 'Human confirmation is required', nodeTrace, lease);
      return { waiting: true };
    }
    await completeNode(run, node, cursor, execution.output, nodeTrace, lease);
    if (run.test_target_node_id === node.id) {
      const testOutput = execution.output ?? run.state[node.id] ?? null;
      await transitionActiveRun(
        "UPDATE workflow_runs SET status='completed',output=$1,state=$2,cursor=NULL,step_count=step_count+1,completed_at=now(),updated_at=now() WHERE id=$3 AND status='running' RETURNING id",
        [json(testOutput), json(run.state), run.id],
        lease,
      );
      await emitWorkflowEvent(null, 'workflow.node_test_completed', `${node.type} node test completed`, { nodeId: node.id, steps: run.step_count + 1 });
      return { completed: true, output: testOutput };
    }
    if (execution.finished || node.type === 'output') {
      if (run.test_target_node_id) {
        const message = `Test path completed before reaching node ${run.test_target_node_id}`;
        const failure = workflowFailure(message, run.state);
        await transitionActiveRun(
          "UPDATE workflow_runs SET status='failed',output=$1,error=$2,state=$3,cursor=NULL,step_count=step_count+1,completed_at=now(),updated_at=now() WHERE id=$4 AND status='running' RETURNING id",
          [failure.output, failure.error, json(run.state), run.id],
          lease,
        );
        await emitWorkflowEvent(null, 'workflow.node_test_target_not_reached', message, { nodeId: run.test_target_node_id });
        return { failed: true };
      }
      const finalOutput = execution.output ?? run.state;
      await transitionActiveRun(
        "UPDATE workflow_runs SET status='completed',output=$1,state=$2,cursor=NULL,step_count=step_count+1,completed_at=now(),updated_at=now() WHERE id=$3 AND status='running' RETURNING id",
        [json(finalOutput), json(run.state), run.id],
        lease,
      );
      await emitWorkflowEvent(null, 'workflow.completed', `${run.name} completed`, { steps: run.step_count + 1 });
      const formats = artifactFormats(node);
      await mutateWorkflowArtifacts(
        "UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending' AND NOT(format=ANY($2::text[]))",
        [run.id, formats],
        lease,
      );
      if (formats.length) {
        try { await requestWorkflowArtifacts({ workspaceId: run.workspace_id, createdBy: run.created_by, workflowRunId: run.id, title: run.name, formats, ready: true, signal }); }
        catch (artifactError) { await emitWorkflowEvent(null, 'artifacts.queue_failed', 'Workflow completed, but downloadable files could not be queued', { error: artifactError instanceof Error ? artifactError.message : 'Artifact queue unavailable' }); }
      }
      return { completed: true, output: finalOutput };
    }
    const edge = edgeFor(node, outgoing(run.definition_snapshot, node.id), execution.result);
    if (!edge) throw new Error(`Node ${node.id} did not resolve an outgoing edge`);
    if (node.type === 'condition' || node.type === 'loop') await emitWorkflowEvent(node.id, 'branch.selected', `Selected ${edge.condition} → ${edge.target}`, { condition: edge.condition, target: edge.target });
    if (edge.condition === 'continue') {
      const loop = cursor.loops[edge.target];
      if (!loop) throw new Error(`Continue edge returned to inactive loop ${edge.target}`);
      cursor.loops[edge.target] = { iteration: loop.iteration + 1 };
    }
    if (node.type === 'loop' && execution.result === 'done') delete cursor.loops[node.id];
    const nextCursor: WorkflowCursor = { nodeId: edge.target, loops: cursor.loops, attempt: 1, previousNodeId: node.id };
    const nextStep = run.step_count + 1;
    await transitionActiveRun(
      "UPDATE workflow_runs SET status='queued',state=$1,cursor=$2,step_count=$3,updated_at=now() WHERE id=$4 AND status='running' RETURNING id",
      [json(run.state), json(nextCursor), nextStep, run.id],
      lease,
    );
    try {
      await enqueueWorkflowRun(run.id, `${run.id}:step:${nextStep}:${edge.target}:${iterationKey(nextCursor)}`, 0, run.trace_id);
    } catch (queueError) {
      const message = `Workflow queue unavailable before node ${edge.target}: ${queueError instanceof Error ? queueError.message : 'unknown queue error'}`.slice(0, 2000);
      const failure = workflowFailure(message, run.state);
      await transitionActiveRun(
        "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3 AND status='queued' RETURNING id",
        [failure.output, failure.error, run.id],
        lease,
      );
      await mutateWorkflowArtifacts("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.id], lease);
      await emitWorkflowEvent(null, 'workflow.queue_failed', message, { nextNodeId: edge.target });
      return { failed: true };
    }
    return { queued: true, nextNodeId: edge.target };
  } catch (error) {
    const serialized = serializeRuntimeError(error);
    if (isLeaseFailure(signal.reason) || isLeaseFailure(error)) throw signal.reason ?? error;
    if (signal.aborted || serialized.category === 'cancelled') {
      throw serialized.category === 'cancelled' ? error : cancellationError(error);
    }
    await failOrRetry(run, node, cursor, error, nodeTrace, lease);
    return { failed: true };
  }
}
