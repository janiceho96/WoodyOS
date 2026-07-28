import { query } from '../../db/client.js';
import { evaluateCondition, valueAtPath, type WorkflowNode } from '../definition.js';
import type { WorkflowAdapterContext, WorkflowCursor } from './types.js';
import { cancellationError } from '../../runtime/cancellation.js';
import { assertFencedMutation } from '../../runtime/leases.js';
import { appendQualityHistoryEntry } from '../../quality/history.js';
import { getOutputDocumentVersion } from '../../outputs/service.js';
import { runtimeError } from '../../runtime/errors.js';
import { canonicalJson } from '../../runtime/manifest.js';
import type { AgentNodeExecutionIdentity } from './types.js';

type QualitySummary = {
  entryId: string;
  iteration: number;
  automatedRevision: number;
  manualRevision: number;
  candidate: unknown;
  verdict: Record<string, unknown>;
  revisionAgentNodeId: string;
};

type QualityMaterialization = {
  entryIds: string[];
  current: QualitySummary;
};

function recordQualityMaterialization(
  state: Record<string, unknown>,
  loopNodeId: string,
  summary: QualitySummary,
) {
  const historyRoot = state.qualityHistory
    && typeof state.qualityHistory === 'object'
    && !Array.isArray(state.qualityHistory)
    ? state.qualityHistory as Record<string, unknown>
    : {};
  const previous = historyRoot[loopNodeId]
    && typeof historyRoot[loopNodeId] === 'object'
    && !Array.isArray(historyRoot[loopNodeId])
    ? historyRoot[loopNodeId] as Partial<QualityMaterialization>
    : {};
  const entryIds = Array.isArray(previous.entryIds)
    ? previous.entryIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (!entryIds.includes(summary.entryId)) entryIds.push(summary.entryId);
  historyRoot[loopNodeId] = { entryIds, current: summary };
  state.qualityHistory = historyRoot;
}

function identityFor(
  state: Record<string, unknown>,
  nodeId: string,
): AgentNodeExecutionIdentity | null {
  const identities = state.agentExecutionIdentities
    && typeof state.agentExecutionIdentities === 'object'
    && !Array.isArray(state.agentExecutionIdentities)
    ? state.agentExecutionIdentities as Record<string, unknown>
    : {};
  const identity = identities[nodeId];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const candidate = identity as Partial<AgentNodeExecutionIdentity>;
  return typeof candidate.taskId === 'string'
    && typeof candidate.agentVersionId === 'string'
    && typeof candidate.outputDocumentVersionId === 'string'
    && typeof candidate.modelIdentity === 'string'
    ? candidate as AgentNodeExecutionIdentity
    : null;
}

function graderResultFor(identity: AgentNodeExecutionIdentity) {
  const output = identity.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const result = (output as Record<string, unknown>).data;
  return result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
}

function requiresDurableQualityHistory(context: WorkflowAdapterContext) {
  const { execution, run } = context;
  return execution.mode === 'production'
    && run.run_mode === 'production'
    && run.execution_manifest?.compatibility === 'exact';
}

function hasStoredAgentExecutionIdentities(state: Record<string, unknown>) {
  return Boolean(
    state.agentExecutionIdentities
    && typeof state.agentExecutionIdentities === 'object'
    && !Array.isArray(state.agentExecutionIdentities),
  );
}

async function persistPendingQualityIteration(context: WorkflowAdapterContext) {
  const { execution, run, node, cursor } = context;
  const quality = node.config.quality
    && typeof node.config.quality === 'object'
    && !Array.isArray(node.config.quality)
    ? node.config.quality as Record<string, unknown>
    : null;
  const loop = cursor.loops[node.id] ?? { iteration: 0 };
  if (
    !quality
    || loop.iteration <= 0
    || !requiresDurableQualityHistory(context)
    || !hasStoredAgentExecutionIdentities(run.state)
  ) return;
  const nodes = run.state.nodes && typeof run.state.nodes === 'object' && !Array.isArray(run.state.nodes)
    ? run.state.nodes as Record<string, unknown>
    : {};
  const graderNodeId = String(quality.graderNodeId ?? 'grader');
  const workerNodeId = String(quality.workerNodeId ?? 'worker');
  const revisionNodeId = String(quality.revisionNodeId ?? workerNodeId);
  const candidateNodeId = loop.iteration === 1 ? workerNodeId : revisionNodeId;
  const grader = nodes[graderNodeId] && typeof nodes[graderNodeId] === 'object' && !Array.isArray(nodes[graderNodeId])
    ? nodes[graderNodeId] as Record<string, unknown>
    : {};
  const verdict = grader.data && typeof grader.data === 'object' && !Array.isArray(grader.data)
    ? grader.data as Record<string, unknown>
    : null;
  if (!verdict) return;
  const candidateIdentity = identityFor(run.state, candidateNodeId);
  if (!candidateIdentity) {
    throw runtimeError('QUALITY_CANDIDATE_VERSION_REQUIRED', {
      category: 'validation',
      retryable: false,
      message: 'Quality candidates require a completed versioned text output',
      details: { nodeId: candidateNodeId, iteration: loop.iteration },
    });
  }
  const graderIdentity = identityFor(run.state, graderNodeId);
  if (!graderIdentity) {
    throw runtimeError('QUALITY_GRADER_IDENTITY_REQUIRED', {
      category: 'validation',
      retryable: false,
      message: 'Quality grades require an exact grader execution identity',
      details: { nodeId: graderNodeId, iteration: loop.iteration },
    });
  }
  const graderResult = graderResultFor(graderIdentity);
  if (!graderResult || canonicalJson(graderResult) !== canonicalJson(verdict)) {
    throw runtimeError('QUALITY_GRADER_RESULT_MISMATCH', {
      category: 'validation',
      retryable: false,
      message: 'Quality grader state does not match the completed grader task output',
      details: { nodeId: graderNodeId, iteration: loop.iteration },
    });
  }
  const outputVersion = await getOutputDocumentVersion(
    run.workspace_id,
    candidateIdentity.outputDocumentVersionId,
  );
  if (!outputVersion) {
    throw runtimeError('QUALITY_CANDIDATE_VERSION_REQUIRED', {
      category: 'validation',
      retryable: false,
      message: 'Quality candidate output version is missing',
      details: { nodeId: candidateNodeId, iteration: loop.iteration },
    });
  }
  const passingScore = Number(node.config.passingScore ?? 0);
  const passed = verdict.passed === true
    && typeof verdict.score === 'number'
    && verdict.score >= passingScore;
  const maxIterations = Number(node.config.maxIterations ?? 10);
  const atLimit = loop.iteration >= maxIterations;
  const exitReason = passed
    ? 'quality_passed'
    : atLimit
      ? String(node.config.onLimit ?? 'fail') === 'exit' ? 'limit_exit' : 'limit_fail'
      : null;
  const automatedRevision = Math.max(0, loop.iteration - 1);
  const manualRevision = Math.max(0, outputVersion.version_number - 1);
  const entry = await appendQualityHistoryEntry({
    workspaceId: run.workspace_id,
    workflowRunId: run.id,
    sequence: loop.iteration,
    automatedRevision,
    manualRevision,
    candidateTaskId: candidateIdentity.taskId,
    outputDocumentVersionId: outputVersion.id,
    candidateHash: outputVersion.content_hash,
    graderTaskId: graderIdentity.taskId,
    graderAgentVersionId: graderIdentity.agentVersionId,
    modelIdentity: graderIdentity.modelIdentity,
    result: graderResult,
    exitReason,
    traceId: run.trace_id,
    leaseOwnerId: execution.leaseOwnerId,
  });
  recordQualityMaterialization(run.state, node.id, {
    entryId: entry.id,
    iteration: loop.iteration,
    automatedRevision,
    manualRevision,
    candidate: nodes[candidateNodeId] ?? null,
    verdict,
    revisionAgentNodeId: candidateNodeId,
  });
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
  const quality = node.config.quality && typeof node.config.quality === 'object' && !Array.isArray(node.config.quality)
    ? node.config.quality as Record<string, unknown>
    : null;
  if (quality) {
    const nodes = state.nodes && typeof state.nodes === 'object' && !Array.isArray(state.nodes)
      ? state.nodes as Record<string, unknown>
      : {};
    const graderNodeId = String(quality.graderNodeId ?? 'grader');
    const workerNodeId = String(quality.workerNodeId ?? 'worker');
    const revisionNodeId = String(quality.revisionNodeId ?? workerNodeId);
    const grader = nodes[graderNodeId] && typeof nodes[graderNodeId] === 'object' && !Array.isArray(nodes[graderNodeId])
      ? nodes[graderNodeId] as Record<string, unknown>
      : {};
    const verdict = grader.data && typeof grader.data === 'object' && !Array.isArray(grader.data)
      ? grader.data as Record<string, unknown>
      : null;
    const historyRoot = state.qualityHistory && typeof state.qualityHistory === 'object' && !Array.isArray(state.qualityHistory)
      ? state.qualityHistory as Record<string, unknown>
      : {};
    const storedHistory = historyRoot[node.id];
    const materialized = storedHistory && typeof storedHistory === 'object' && !Array.isArray(storedHistory)
      ? storedHistory as Partial<QualityMaterialization>
      : null;
    const history = Array.isArray(storedHistory) ? storedHistory as Array<Record<string, unknown>> : [];
    const materializedCurrent = materialized?.current?.iteration === loop.iteration
      ? materialized.current
      : null;
    if (loop.iteration > 0 && verdict && !materializedCurrent && !history.some((entry) => entry.iteration === loop.iteration)) {
      const candidateNodeId = loop.iteration === 1 ? workerNodeId : revisionNodeId;
      history.push({ iteration: loop.iteration, candidate: nodes[candidateNodeId] ?? null, verdict, revisionAgentNodeId: candidateNodeId });
      historyRoot[node.id] = history;
      state.qualityHistory = historyRoot;
    }
    if (verdict) {
      const passingScore = Number(node.config.passingScore ?? 0);
      const passed = verdict.passed === true && typeof verdict.score === 'number' && verdict.score >= passingScore;
      const latest = materializedCurrent ?? history.at(-1);
      const historyOutput = materialized
        ? materialized.entryIds ?? []
        : history;
      if (passed) return { branch: 'done', output: { iterations: loop.iteration, reason: 'quality_passed', candidate: latest?.candidate ?? null, verdict, history: historyOutput } };
      if (loop.iteration >= maxIterations) {
        if (onLimit === 'exit') return { branch: 'done', output: { iterations: loop.iteration, reason: 'limit_exit', candidate: latest?.candidate ?? null, verdict, history: historyOutput, warning: 'Quality threshold was not reached before the revision limit.' } };
        throw new Error(`Loop ${node.id} reached its ${maxIterations} iteration safety limit`);
      }
      cursor.loops[node.id] = loop;
      return { branch: 'body', output: { iteration: loop.iteration, condition: true, verdict } };
    }
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
  const { execution, run, node, cursor, iterationKey, emitEvent, setNodeOutput } = context;
  if (node.type === 'trigger') return { result: run.input, output: run.input };
  if (node.type === 'condition') {
    const result = evaluateCondition(node.config, run.state);
    setNodeOutput(result);
    await emitEvent('branch.evaluated', `Condition selected the ${result ? 'true' : 'false'} branch`, { result, path: node.config.path ?? node.config.key });
    return { result, output: result };
  }
  if (node.type === 'loop') {
    await persistPendingQualityIteration(context);
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
    execution.signal.throwIfAborted();
    const inserted = await query(
      `INSERT INTO workflow_approvals(workspace_id,workflow_run_id,node_id,iteration_key,attempt)
       SELECT $1,$2,$3,$4,$5
       WHERE EXISTS(
         SELECT 1 FROM workflow_runs
         WHERE id=$2 AND workspace_id=$1
           AND status NOT IN ('cancel_requested','cancelling','cancelled','cancelled_with_side_effects')
           AND ($6::text IS NULL OR EXISTS(
             SELECT 1 FROM execution_leases
             WHERE subject_type='workflow_run' AND subject_id=$2
               AND owner_id=$6 AND expires_at > now()
           ))
       )
       RETURNING id`,
      [run.workspace_id, run.id, node.id, iterationKey, cursor.attempt, execution.leaseOwnerId ?? null],
    );
    await assertFencedMutation(
      inserted.rowCount,
      execution.leaseOwnerId
        ? {
          subject: { kind: 'workflow_run', id: run.id },
          ownerId: execution.leaseOwnerId,
        }
        : undefined,
      cancellationError,
    );
    return { waiting: true, waitingMessage: 'Human approval is required', output: null };
  }
  if (approval.status === 'pending') return { waiting: true, waitingMessage: 'Human approval is required', output: null };
  if (approval.status === 'rejected') throw Object.assign(new Error(`Approval for ${node.id} was rejected`), { retryable: false });
  const output = { approved: true, approvalId: approval.id };
  setNodeOutput(output);
  return { output, result: output };
}
