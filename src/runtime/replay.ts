import { query } from '../db/client.js';
import { redactRuntimeMessage, redactRuntimeValue, serializeRuntimeError } from './errors.js';

export type ReplayRole = 'owner' | 'admin' | 'member';

export type ReplayEvent = {
  sequence: number;
  timestamp: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: string;
  title: string;
  durationMs: number | null;
  costUsd: number | null;
  status: string;
  summary: Record<string, unknown>;
};

export type WorkflowReplay = {
  run: {
    id: string;
    traceId: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    modelVersions: Array<{ agentId: string; versionId: string; version: number; provider: string; model: string }>;
  };
  events: ReplayEvent[];
};

type ReplaySource = Omit<ReplayEvent, 'sequence'> & { sourceRank: number; recordId: string; sourceSequence: number };

const replaySummaryKeys = new Set([
  'nodeId', 'node_id', 'iterationKey', 'iteration_key', 'attempt', 'status', 'code', 'category', 'retryable',
  'artifactId', 'artifact_id', 'format', 'filename', 'count', 'reason', 'operation', 'adapter', 'riskLevel', 'risk_level',
  'qualityScore', 'quality_score', 'passed', 'exitReason', 'exit_reason', 'version', 'versionNumber', 'version_number',
]);

function timestamp(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || (typeof value !== 'number' && typeof value !== 'string')) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bounded(value: unknown): unknown {
  if (typeof value === 'string') return redactRuntimeMessage(value).slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function publicSummary(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const summary: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!replaySummaryKeys.has(key)) continue;
    const safe = bounded(redactRuntimeValue(raw));
    if (safe !== undefined) summary[key] = safe;
    if (Object.keys(summary).length >= 12) break;
  }
  return summary;
}

function event(input: Omit<ReplaySource, 'sourceRank' | 'recordId' | 'sourceSequence'> & Pick<ReplaySource, 'sourceRank' | 'recordId' | 'sourceSequence'>): ReplaySource {
  return input;
}

function errorCandidate(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = 'error' in value ? (value as { error: unknown }).error : value;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  return typeof record.code === 'string'
    && typeof record.category === 'string'
    && typeof record.retryable === 'boolean'
    && typeof record.message === 'string'
    ? candidate
    : null;
}

function recoveryGuidance(category: string, retryable: boolean) {
  if (category === 'rate_limited') return 'Wait for provider capacity before starting a new run.';
  if (category === 'authentication') return 'Review the connection credentials and permissions before starting a new run.';
  if (category === 'policy_denied') return 'Review the required approval or workspace policy before starting a new run.';
  if (category === 'validation') return 'Correct the workflow input or configuration before starting a new run.';
  if (retryable) return 'Review the transient failure, then start a new run when the dependency is available.';
  return 'Review the structured error and configuration before starting a new run.';
}

function replayErrorMessage(candidate: unknown, redacted: string) {
  const message = (candidate as { message?: unknown }).message;
  if (typeof message !== 'string') return redacted.slice(0, 500);
  return /token|password|secret|authorization|api[-_]?key|cookie|credential|private[-_]?key|session/i.test(message)
    ? '[REDACTED]'
    : redacted.slice(0, 500);
}

function safeError(value: unknown) {
  const candidate = errorCandidate(value);
  if (!candidate) return {};
  const error = serializeRuntimeError(candidate);
  return {
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    message: replayErrorMessage(candidate, error.message),
    recoveryGuidance: recoveryGuidance(error.category, error.retryable),
  };
}

function privilegedTargetSummary(role: ReplayRole, value: unknown) {
  if (role === 'member' || typeof value !== 'string') return {};
  return { target: redactRuntimeMessage(value).slice(0, 500) };
}

function identity(value: unknown) {
  return typeof value === 'string' ? redactRuntimeMessage(value).slice(0, 160) : undefined;
}

function qualityProvenance(row: Record<string, unknown>) {
  const summary: Record<string, unknown> = {
    outputDocumentVersionId: identity(row.output_document_version_id),
    outputDocumentId: identity(row.output_document_id),
    outputVersionNumber: finiteNumber(row.version_number),
    candidateTaskId: identity(row.candidate_task_id),
    candidateAgentId: identity(row.candidate_agent_id),
    candidateAgentVersionId: identity(row.candidate_agent_version_id),
    graderTaskId: identity(row.grader_task_id),
    graderAgentId: identity(row.grader_agent_id),
    graderAgentVersionId: identity(row.grader_agent_version_id),
    graderAgentVersion: finiteNumber(row.grader_agent_version),
    graderModelIdentity: identity(row.model_identity),
    passed: typeof row.result === 'object' && row.result !== null && !Array.isArray(row.result) && typeof (row.result as Record<string, unknown>).passed === 'boolean' ? (row.result as Record<string, unknown>).passed : undefined,
    qualityScore: typeof row.result === 'object' && row.result !== null && !Array.isArray(row.result) ? finiteNumber((row.result as Record<string, unknown>).score) : null,
    exitReason: identity(row.exit_reason),
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined && value !== null));
}

function manifestVersions(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const manifest = value as { agents?: Record<string, { versionId?: unknown; version?: unknown }>; models?: Record<string, { provider?: unknown; model?: unknown }> };
  return Object.entries(manifest.agents ?? {})
    .map(([agentId, agent]) => {
      const model = manifest.models?.[agentId];
      return {
        agentId,
        versionId: typeof agent.versionId === 'string' ? agent.versionId : '',
        version: finiteNumber(agent.version) ?? 0,
        provider: typeof model?.provider === 'string' ? model.provider.slice(0, 160) : 'unknown',
        model: typeof model?.model === 'string' ? model.model.slice(0, 160) : 'unknown',
      };
    })
    .filter((item) => item.versionId)
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
}

/**
 * Reads a workflow run's persisted trace history. This function intentionally has no
 * adapter, queue, audit, artifact-generation, or mutation dependency.
 */
export async function getWorkflowReplay(input: { workspaceId: string; runId: string; role: ReplayRole }): Promise<WorkflowReplay | null> {
  const runResult = await query<{
    id: string; workspace_id: string; trace_id: string | null; span_id: string | null; parent_span_id: string | null; status: string; created_at: Date | string; completed_at: Date | string | null; execution_manifest: unknown;
  }>(`SELECT id,workspace_id,trace_id,span_id,parent_span_id,status,created_at,completed_at,execution_manifest
       FROM workflow_runs WHERE id=$1 AND workspace_id=$2`, [input.runId, input.workspaceId]);
  const run = runResult.rows[0];
  if (!run?.trace_id) return null;
  const rootSpanId = run.span_id ?? run.trace_id;

  const params = [input.runId, input.workspaceId, run.trace_id];
  const [workflowEvents, nodeStates, taskEvents, actionAuthorizations, quality, taskUsage, artifacts] = await Promise.all([
    query<any>(`SELECT id,created_at,trace_id,span_id,parent_span_id,event_type,message,payload
                 FROM workflow_run_events
                 WHERE workflow_run_id=$1 AND workspace_id=$2 AND trace_id=$3
                 ORDER BY created_at,id`, params),
    query<any>(`SELECT id,started_at,completed_at,trace_id,span_id,parent_span_id,node_id,iteration_key,attempt,status,error
                 FROM workflow_run_node_states
                 WHERE workflow_run_id=$1 AND workspace_id=$2 AND trace_id=$3
                 ORDER BY started_at,id`, params),
    query<any>(`SELECT event.id,event.created_at,event.trace_id,event.span_id,event.parent_span_id,event.event_type,event.message,event.payload,task.title
                 FROM task_events event JOIN tasks task ON task.id=event.task_id AND task.workspace_id=event.workspace_id
                 WHERE task.workflow_run_id=$1 AND event.workspace_id=$2 AND event.trace_id=$3
                 ORDER BY event.created_at,event.id`, params),
    query<any>(`SELECT authorization.id,authorization.requested_at,authorization.resolved_at,authorization.trace_id,authorization.span_id,authorization.parent_span_id,
                        authorization.subject_type,authorization.task_id,authorization.workflow_run_id,authorization.node_id,authorization.iteration_key,authorization.attempt,
                        authorization.adapter,authorization.operation,authorization.risk_level,authorization.target_summary,authorization.status,authorization.error_message,authorization.runtime_error
                 FROM action_authorizations authorization
                 LEFT JOIN tasks child_task ON child_task.id=authorization.task_id AND child_task.workspace_id=authorization.workspace_id
                 WHERE authorization.workspace_id=$2 AND authorization.trace_id=$3
                   AND (
                     (authorization.subject_type='workflow_run' AND authorization.workflow_run_id=$1)
                     OR (authorization.subject_type='task' AND authorization.task_id=child_task.id AND child_task.workflow_run_id=$1 AND child_task.trace_id=$3)
                   )
                 ORDER BY authorization.requested_at,authorization.id`, params),
    query<any>(`SELECT quality.id,quality.sequence,quality.created_at,quality.trace_id,
                        quality.output_document_version_id,output_document.id output_document_id,output_version.version_number,
                        quality.candidate_task_id,candidate.agent_id candidate_agent_id,candidate.agent_version_id candidate_agent_version_id,
                        quality.grader_task_id,grader.agent_id grader_agent_id,quality.grader_agent_version_id,grader_version.version grader_agent_version,
                        quality.model_identity,quality.result,quality.exit_reason
                 FROM quality_history_entries quality
                 JOIN output_document_versions output_version ON output_version.id=quality.output_document_version_id AND output_version.workspace_id=quality.workspace_id
                 JOIN output_documents output_document ON output_document.id=output_version.document_id AND output_document.workspace_id=quality.workspace_id
                 JOIN tasks candidate ON candidate.id=quality.candidate_task_id AND candidate.workspace_id=quality.workspace_id AND candidate.workflow_run_id=quality.workflow_run_id
                 JOIN tasks grader ON grader.id=quality.grader_task_id AND grader.workspace_id=quality.workspace_id AND grader.workflow_run_id=quality.workflow_run_id
                 JOIN agent_versions grader_version ON grader_version.id=quality.grader_agent_version_id AND grader_version.workspace_id=quality.workspace_id AND grader_version.agent_id=grader.agent_id
                 WHERE quality.workflow_run_id=$1 AND quality.workspace_id=$2 AND quality.trace_id=$3
                 ORDER BY quality.created_at,quality.id`, params),
    query<any>(`SELECT id,created_at,completed_at,trace_id,span_id,parent_span_id,title,status,agent_id,agent_version_id,token_input,token_output,estimated_cost_usd,duration_ms,error
                 FROM tasks
                 WHERE workflow_run_id=$1 AND workspace_id=$2 AND trace_id=$3
                 ORDER BY created_at,id`, params),
    query<any>(`SELECT id,created_at,completed_at,workflow_run_id,task_id,format,filename,status,size_bytes,error_message
                 FROM artifacts
                 WHERE workspace_id=$2 AND (workflow_run_id=$1 OR task_id IN (
                   SELECT id FROM tasks WHERE workflow_run_id=$1 AND workspace_id=$2 AND trace_id=$3
                 ))
                 ORDER BY created_at,id`, params),
  ]);

  const sources: ReplaySource[] = [
    ...workflowEvents.rows.map((row) => event({ sourceRank: 1, recordId: row.id, sourceSequence: 0, timestamp: timestamp(row.created_at), traceId: run.trace_id!, spanId: String(row.span_id ?? rootSpanId), parentSpanId: row.parent_span_id ?? run.parent_span_id ?? null, kind: 'workflow_event', title: redactRuntimeMessage(String(row.event_type).replaceAll('.', ' ')).slice(0, 240), durationMs: null, costUsd: null, status: String(row.event_type), summary: publicSummary(row.payload) })),
    ...nodeStates.rows.map((row) => event({ sourceRank: 2, recordId: row.id, sourceSequence: Number(row.attempt ?? 0), timestamp: timestamp(row.started_at), traceId: run.trace_id!, spanId: String(row.span_id ?? rootSpanId), parentSpanId: row.parent_span_id ?? run.parent_span_id ?? null, kind: 'node_state', title: `Node ${String(row.node_id).slice(0, 160)}`, durationMs: row.completed_at ? Math.max(0, new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()) : null, costUsd: null, status: String(row.status), summary: { ...publicSummary({ iteration_key: row.iteration_key, attempt: row.attempt }), ...safeError(row.error) } })),
    ...taskEvents.rows.map((row) => event({ sourceRank: 3, recordId: row.id, sourceSequence: 0, timestamp: timestamp(row.created_at), traceId: run.trace_id!, spanId: String(row.span_id ?? rootSpanId), parentSpanId: row.parent_span_id ?? run.parent_span_id ?? null, kind: 'task_event', title: redactRuntimeMessage(String(row.event_type).replaceAll('.', ' ')).slice(0, 240), durationMs: null, costUsd: null, status: String(row.event_type), summary: { ...publicSummary(row.payload), ...safeError(row.payload) } })),
    ...actionAuthorizations.rows.map((row) => event({ sourceRank: 4, recordId: row.id, sourceSequence: Number(row.attempt ?? 0), timestamp: timestamp(row.requested_at), traceId: run.trace_id!, spanId: String(row.span_id ?? rootSpanId), parentSpanId: row.parent_span_id ?? run.parent_span_id ?? null, kind: 'action_authorization', title: `Action ${String(row.operation).slice(0, 160)}`, durationMs: row.resolved_at ? Math.max(0, new Date(row.resolved_at).getTime() - new Date(row.requested_at).getTime()) : null, costUsd: null, status: String(row.status), summary: { ...publicSummary({ node_id: row.node_id, iteration_key: row.iteration_key, attempt: row.attempt, adapter: row.adapter, operation: row.operation, risk_level: row.risk_level }), ...privilegedTargetSummary(input.role, row.target_summary), ...safeError(row.runtime_error ?? row.error_message) } })),
    ...quality.rows.map((row) => event({ sourceRank: 5, recordId: row.id, sourceSequence: Number(row.sequence ?? 0), timestamp: timestamp(row.created_at), traceId: run.trace_id!, spanId: rootSpanId, parentSpanId: run.parent_span_id ?? null, kind: 'quality_history', title: `Quality attempt ${Number(row.sequence)}`, durationMs: null, costUsd: null, status: typeof row.result?.passed === 'boolean' ? (row.result.passed ? 'passed' : 'failed') : 'recorded', summary: qualityProvenance(row) })),
    ...taskUsage.rows.map((row) => event({ sourceRank: 6, recordId: row.id, sourceSequence: 0, timestamp: timestamp(row.completed_at ?? row.created_at), traceId: run.trace_id!, spanId: String(row.span_id ?? rootSpanId), parentSpanId: row.parent_span_id ?? run.parent_span_id ?? null, kind: 'task_usage', title: `Agent task ${redactRuntimeMessage(String(row.title)).slice(0, 160)}`, durationMs: finiteNumber(row.duration_ms), costUsd: finiteNumber(row.estimated_cost_usd), status: String(row.status), summary: { ...publicSummary({ version: row.agent_version_id, input_tokens: row.token_input, output_tokens: row.token_output }), ...safeError(row.error) } })),
    ...artifacts.rows.map((row) => event({ sourceRank: 7, recordId: row.id, sourceSequence: 0, timestamp: timestamp(row.completed_at ?? row.created_at), traceId: run.trace_id!, spanId: rootSpanId, parentSpanId: run.parent_span_id ?? null, kind: 'artifact', title: `Artifact ${String(row.format).slice(0, 40).toUpperCase()}`, durationMs: row.completed_at ? Math.max(0, new Date(row.completed_at).getTime() - new Date(row.created_at).getTime()) : null, costUsd: null, status: String(row.status), summary: publicSummary({ artifact_id: row.id, format: row.format, filename: row.filename, size_bytes: row.size_bytes, code: row.error_message ? 'ARTIFACT_ERROR' : undefined }) })),
  ];

  const events = sources
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)
      || left.sourceRank - right.sourceRank
      || left.recordId.localeCompare(right.recordId)
      || left.sourceSequence - right.sourceSequence)
    .map(({ sourceRank: _sourceRank, recordId: _recordId, sourceSequence: _sourceSequence, ...value }, index) => ({ ...value, sequence: index + 1 }));

  return {
    run: { id: run.id, traceId: run.trace_id, status: run.status, createdAt: timestamp(run.created_at), completedAt: run.completed_at ? timestamp(run.completed_at) : null, modelVersions: manifestVersions(run.execution_manifest) },
    events,
  };
}
