import 'dotenv/config';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { lookup } from 'node:dns/promises';
import { query } from './db/client.js';
import {
  ARTIFACT_QUEUE,
  TASK_QUEUE,
  WORKFLOW_QUEUE,
  KNOWLEDGE_QUEUE,
  FILE_QUEUE,
  enqueueWorkflowRun,
  type ArtifactJobData,
  type FileJobData,
  type KnowledgeJobData,
  type TaskJobData,
  type WorkflowJobData,
} from './queue/task-queue.js';
import { definitionFor, invokeTool, toolRiskLevel, type ToolRecord } from './tools/runtime.js';
import { embeddingFor } from './lib/embeddings.js';
import { assertConfiguredAiProvider, configuredAiProviderForWorkspace } from './lib/ai-provider.js';
import { assertWorkspaceAiBudgetAvailable, estimatedWorkspaceAiCost, recordAiUsage } from './lib/ai-usage.js';
import { isPublicIp } from './lib/network.js';
import { agentRuntimeSourceFromSnapshot, resolveAgentRuntimePolicy, retrieveAgentKnowledge } from './lib/agent-runtime.js';
import {
  anthropicMcpDefinition,
  authorizedMcpTools,
  executeAuthorizedMcpTool,
  mcpToolRuntimeName,
  assertMcpPermission,
  openAiMcpDefinition,
  type AuthorizedMcpTool,
} from './mcp/runtime.js';
import { loadTaskActionCheckpoint, pauseForActionConfirmation, type TaskActionCheckpointState } from './mcp/checkpoints.js';
import { startMcpMaintenance } from './mcp/maintenance.js';
import { generateArtifact, releaseTaskArtifacts } from './artifacts/service.js';
import { executeWorkflowStep } from './workflows/runtime.js';
import { authorizeAction, beginAction, completeAction, failAction } from './policy/action-gateway.js';
import { limitedActionResult, safeActionSummary } from './lib/action-safety.js';
import { processFile, purgeExpiredFiles } from './files/service.js';
import { retrieveTaskAttachmentContext } from './files/context.js';
import { outputContractFromTaskInput, outputContractInstruction, parseAgentOutput } from './workflows/output-contracts.js';
import {
  assertManifestCompatible,
  assertTaskManifestDependencies,
  assertWorkflowRunManifestDependencies,
  validateManifestCompatibility,
  type ExecutionManifest,
} from './runtime/manifest.js';
import type { AgentVersionSnapshot } from './agents/versions.js';
import type { WorkflowDefinition } from './workflows/definition.js';
import {
  preserveActionFailure,
  redactRuntimeMessage,
  redactRuntimeValue,
  serializeRuntimeError,
  uncertainActionOutcome,
} from './runtime/errors.js';
import {
  authoritativeQueuedTraceContext,
  authoritativeTraceContext,
  childTraceContext,
  type TraceContext,
} from './runtime/trace.js';
import {
  cancellationError,
  combineAbortSignals,
  createCancellationContext,
  finalizeCancellation,
} from './runtime/cancellation.js';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
type Agent = {
  name: string;
  role: string;
  goal: string;
  instructions: string;
  model: string;
  model_config: unknown;
  capabilities: unknown;
  memory_config: unknown;
  tool_ids: unknown;
};
type Task = {
  id: string;
  workspace_id: string;
  title: string;
  input: Record<string, unknown>;
  agent_id: string;
  requested_by: string;
  workflow_run_id: string | null;
  workflow_node_id: string | null;
  agent_version_id: string | null;
  execution_manifest: ExecutionManifest | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  created_at: string;
};

async function finalizeIfCancellationRequested(subject: {
  kind: 'task' | 'workflow_run';
  id: string;
}) {
  const table = subject.kind === 'task' ? 'tasks' : 'workflow_runs';
  const status = (await query<{ status: string }>(
    `SELECT status FROM ${table} WHERE id=$1`,
    [subject.id],
  )).rows[0]?.status;
  if (!['cancel_requested', 'cancelling', 'cancelled', 'cancelled_with_side_effects'].includes(status ?? '')) {
    return false;
  }
  await finalizeCancellation(subject);
  return true;
}
function openAiToolDefinitions(tools: ToolRecord[]): ChatCompletionTool[] {
  return tools.map((tool) => {
    const definition = definitionFor(tool);
    return {
      type: 'function',
      function: { name: definition.name, description: definition.description, parameters: definition.input_schema as Record<string, unknown> },
    } as ChatCompletionTool;
  });
}

function splitIntoChunks(content: string, chunkSize = 1200, overlap = 200) {
  const clean = content.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: string[] = [];
  for (let start = 0; start < clean.length; start += chunkSize - overlap) {
    const slice = clean.slice(start, start + chunkSize);
    const boundary = slice.lastIndexOf('\n');
    const end = boundary > chunkSize * 0.5 ? start + boundary : start + slice.length;
    chunks.push(clean.slice(start, end));
    if (end >= clean.length) break;
  }
  return chunks.filter(Boolean);
}

async function assertPublicHttpsUrl(raw: string) {
  const address = new URL(raw);
  if (address.protocol !== 'https:' || !address.hostname) throw new Error('Only HTTPS URL ingestion is allowed');
  const resolved = await lookup(address.hostname, { all: true, verbatim: true });
  for (const candidate of resolved) {
    if (!isPublicIp(candidate.address)) throw new Error('Non-public URLs cannot be ingested');
  }
  return address;
}

async function taskEvent(
  workspaceId: string,
  taskId: string,
  type: string,
  message: string,
  payload: Record<string, unknown> = {},
  parentTrace?: TraceContext,
) {
  const authoritative = parentTrace ?? authoritativeTraceContext((await query<{
    trace_id: string;
    span_id: string;
    parent_span_id: string | null;
  }>('SELECT trace_id,span_id,parent_span_id FROM tasks WHERE id=$1 AND workspace_id=$2', [taskId, workspaceId])).rows[0] ?? {});
  const trace = childTraceContext(authoritative);
  await query(
    `INSERT INTO task_events(
       workspace_id,task_id,event_type,message,payload,trace_id,span_id,parent_span_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      workspaceId,
      taskId,
      type,
      redactRuntimeMessage(message),
      JSON.stringify(redactRuntimeValue(payload)),
      trace.traceId,
      trace.spanId,
      trace.parentSpanId,
    ],
  );
}
type TaskToolAction =
  | { adapter: 'api'; tool: ToolRecord }
  | { adapter: 'mcp'; tool: AuthorizedMcpTool };

function actionName(action: TaskToolAction) {
  return action.adapter === 'api' ? action.tool.name : action.tool.title ?? action.tool.remote_name;
}

async function assertTaskExecutionDependencies(task: Task) {
  if (task.workflow_run_id) {
    const run = (await query<{
      workspace_id: string;
      workflow_version_id: string | null;
      definition_snapshot: WorkflowDefinition;
      execution_manifest: ExecutionManifest | null;
      run_mode: 'test' | 'production';
    }>(
      `SELECT workspace_id,workflow_version_id,definition_snapshot,execution_manifest,run_mode
         FROM workflow_runs WHERE id=$1 AND workspace_id=$2`,
      [task.workflow_run_id, task.workspace_id],
    )).rows[0];
    if (!run) {
      throw Object.assign(new Error('Workflow run dependency is unavailable'), {
        code: 'RUN_MANIFEST_INCOMPATIBLE',
        retryable: false,
      });
    }
    await assertWorkflowRunManifestDependencies(run);
    return { testRun: run.run_mode === 'test' };
  }
  await assertTaskManifestDependencies({
    workspaceId: task.workspace_id,
    agentId: task.agent_id,
    manifest: task.execution_manifest,
  });
  return { testRun: false };
}

async function authorizeTaskToolAction(
  task: Task,
  providerCallId: string,
  action: TaskToolAction,
  arguments_: Record<string, unknown>,
  parentTrace: TraceContext,
) {
  await assertTaskExecutionDependencies(task);
  if (action.adapter === 'mcp') assertMcpPermission(action.tool);
  const trace = childTraceContext(parentTrace);
  const authorization = await authorizeAction({
    workspaceId: task.workspace_id,
    subject: { type: 'task', taskId: task.id, agentId: task.agent_id },
    actionKey: providerCallId,
    adapter: action.adapter,
    resourceId: action.tool.id,
    operation: action.adapter === 'api' ? action.tool.name : action.tool.remote_name,
    riskLevel: action.adapter === 'api' ? toolRiskLevel(action.tool) : action.tool.risk_level,
    arguments: arguments_,
    requestedBy: task.requested_by,
    targetSummary: action.adapter === 'api' ? action.tool.name : `${actionName(action)} via ${action.tool.connection_name}`,
    trace,
  });
  return { ...authorization, trace };
}

export async function executeTaskToolAction(input: {
  task: Task;
  action: TaskToolAction;
  arguments_: Record<string, unknown>;
  authorizationId: string;
  mcpToolCallId?: string | null;
  trace: TraceContext;
  signal?: AbortSignal;
}) {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  await assertTaskExecutionDependencies(input.task);
  if (!(await beginAction(input.authorizationId))) throw new Error('External action execution could not be claimed safely');
  try {
    if (input.action.adapter === 'mcp') {
      const executed = await executeAuthorizedMcpTool({
        tool: input.action.tool,
        arguments_: input.arguments_,
        agentId: input.task.agent_id,
        taskId: input.task.id,
        workflowRunId: input.task.workflow_run_id,
        actionAuthorizationId: input.authorizationId,
        toolCallId: input.mcpToolCallId ?? undefined,
        trace: childTraceContext(input.trace),
        signal,
      });
      await completeAction(input.authorizationId, executed.result);
      return { result: executed.result, toolCallId: executed.callId };
    }
    const result = limitedActionResult(await invokeTool(input.action.tool, input.arguments_, false, signal));
    await completeAction(input.authorizationId, result);
    return { result, toolCallId: null };
  } catch (error) {
    const risk = input.action.adapter === 'api'
      ? toolRiskLevel(input.action.tool)
      : input.action.tool.risk_level;
    const failure = risk === 'read' ? error : uncertainActionOutcome(error);
    throw await preserveActionFailure(
      failure,
      () => failAction(input.authorizationId, failure),
    );
  }
}

async function runtimeAgentForTask(task: Task): Promise<{ agent: Agent; exactManifest: boolean }> {
  const dependencyState = await assertTaskExecutionDependencies(task);
  if (dependencyState.testRun) {
    const agent = (await query<Agent>(
      'SELECT name,role,goal,instructions,model,model_config,capabilities,memory_config,tool_ids FROM agents WHERE id=$1 AND workspace_id=$2',
      [task.agent_id, task.workspace_id],
    )).rows[0];
    if (agent) return { agent, exactManifest: false };
    throw new Error('Agent is missing');
  }
  const compatibility = validateManifestCompatibility(task.execution_manifest);
  if (compatibility.ok) {
    const manifest = assertManifestCompatible(task.execution_manifest);
    const expectedVersionId = manifest.agents[task.agent_id]?.versionId;
    if (!expectedVersionId || expectedVersionId !== task.agent_version_id) {
      throw Object.assign(new Error('Task agent version does not match its execution manifest'), {
        code: 'RUN_MANIFEST_INCOMPATIBLE',
        retryable: false,
      });
    }
    const version = (await query<{ snapshot: AgentVersionSnapshot }>(
      `SELECT snapshot FROM agent_versions
        WHERE id=$1 AND agent_id=$2 AND workspace_id=$3`,
      [expectedVersionId, task.agent_id, task.workspace_id],
    )).rows[0];
    if (!version) {
      throw Object.assign(new Error('Published task agent version is missing'), {
        code: 'RUN_MANIFEST_INCOMPATIBLE',
        retryable: false,
      });
    }
    return { agent: agentRuntimeSourceFromSnapshot(version.snapshot), exactManifest: true };
  }
  assertManifestCompatible(task.execution_manifest);
  throw new Error('Agent is missing');
}

export async function executeAgentTask(
  taskId: string,
  queuedTraceId?: string,
  callerSignal?: AbortSignal,
) {
  const queuedTask = (await query<Pick<Task, 'trace_id' | 'span_id' | 'parent_span_id' | 'created_at'> & {
    runtime_trust_migration_applied_at: string | null;
    status: 'queued' | 'cancel_requested';
  }>(
    `SELECT trace_id,span_id,parent_span_id,created_at,status,
            (SELECT applied_at FROM schema_migrations WHERE name='031_runtime_trust.sql')
              runtime_trust_migration_applied_at
       FROM tasks WHERE id=$1 AND status IN ('queued','cancel_requested')`,
    [taskId],
  )).rows[0];
  if (!queuedTask) return null;
  authoritativeQueuedTraceContext(
    queuedTask,
    queuedTraceId,
    queuedTask.runtime_trust_migration_applied_at,
  );
  const cancellation = await createCancellationContext({ kind: 'task', id: taskId });
  const signal = combineAbortSignals([callerSignal, cancellation.signal]);
  try {
    if (signal.aborted || queuedTask.status === 'cancel_requested') {
      await finalizeCancellation({ kind: 'task', id: taskId });
      return null;
    }
    const task = (await query<Task>(
      `UPDATE tasks SET status='running',started_at=COALESCE(started_at,now()),updated_at=now()
       WHERE id=$1 AND status='queued' RETURNING *`,
      [taskId],
    )).rows[0];
    if (!task) {
      if (signal.aborted) await finalizeCancellation({ kind: 'task', id: taskId });
      else await finalizeIfCancellationRequested({ kind: 'task', id: taskId });
      return null;
    }
    const taskTrace = authoritativeTraceContext(task, queuedTraceId);
    try {
    const { agent, exactManifest } = await runtimeAgentForTask(task);
    const checkpoint = await loadTaskActionCheckpoint(task.workspace_id, task.id);
    await taskEvent(task.workspace_id, task.id, checkpoint ? 'task.resumed' : 'task.started', checkpoint ? `${agent.name} resumed after action confirmation` : `${agent.name} started execution`, {}, taskTrace);
    await assertWorkspaceAiBudgetAvailable(task.workspace_id);
    const runtime = assertConfiguredAiProvider(await configuredAiProviderForWorkspace(task.workspace_id));
    const { provider, anthropic, openAiCompatible } = runtime;
    if (checkpoint && checkpoint.state.provider !== provider) throw Object.assign(new Error('The workspace AI provider changed while this task was waiting for confirmation. Start a new run so Woody can build a compatible request.'), { code: 'AI_PROVIDER_CHANGED_DURING_RUN' });
    const modelTrace = childTraceContext(taskTrace);
    await taskEvent(task.workspace_id, task.id, 'model.requested', `Sending task to ${agent.model}`, {}, modelTrace);
    const toolIds = Array.isArray(agent.tool_ids) ? agent.tool_ids.filter((id): id is string => typeof id === 'string') : [];
    const assignedTools = toolIds.length ? (await query<ToolRecord>('SELECT id,name,kind,config,permissions FROM tools WHERE workspace_id=$1 AND enabled=true AND id = ANY($2::uuid[])', [task.workspace_id, toolIds])).rows : [];
    const runtimePolicy = resolveAgentRuntimePolicy(agent, assignedTools);
    const configuredTools = exactManifest
      ? runtimePolicy.tools.filter((tool) => Boolean(task.execution_manifest?.apiTools[tool.id]))
      : runtimePolicy.tools;
    const authorizedMcp = await authorizedMcpTools(task.workspace_id, task.agent_id);
    const configuredMcpTools = exactManifest
      ? authorizedMcp.filter((tool) => Boolean(task.execution_manifest?.mcpActions[tool.id]))
      : authorizedMcp;
    if (runtimePolicy.deniedTools.length) {
      await taskEvent(task.workspace_id, task.id, 'capability.enforced', 'Some assigned tools were unavailable under the agent capability policy', {
        deniedToolIds: runtimePolicy.deniedTools.map((tool) => tool.id),
      });
    }
    const toolByName = new Map(configuredTools.map((tool) => [`tool_${tool.id.replaceAll('-', '_')}`, tool]));
    const toolById = new Map(configuredTools.map((tool) => [tool.id, tool]));
    const mcpToolByName = new Map(configuredMcpTools.map((tool) => [mcpToolRuntimeName(tool.id), tool]));
    const mcpToolById = new Map(configuredMcpTools.map((tool) => [tool.id, tool]));
    const started = Date.now();
    let inputTokens = checkpoint?.state.inputTokens ?? 0;
    let outputTokens = checkpoint?.state.outputTokens ?? 0;
    let finalText = checkpoint?.state.finalText ?? '';
    let toolCallCount = checkpoint?.state.toolCallCount ?? 0;
    const requestText = `${task.title}\n${JSON.stringify(task.input)}`;
    const [knowledge, attachments, requestedArtifacts] = await Promise.all([
      runtimePolicy.knowledgeEnabled
        ? retrieveAgentKnowledge(task.workspace_id, requestText, 4, childTraceContext(taskTrace), signal)
        : Promise.resolve(''),
      retrieveTaskAttachmentContext(task.id, requestText, signal),
      query<{ format: string }>('SELECT format FROM artifacts WHERE task_id=$1 OR ($2::uuid IS NOT NULL AND workflow_run_id=$2) ORDER BY format', [task.id, task.workflow_run_id]),
    ]);
    const artifactInstruction = requestedArtifacts.rows.length
      ? `The server will convert your canonical Markdown result into: ${requestedArtifacts.rows.map((item) => item.format.toUpperCase()).join(', ')}. Do not emit base64 or pretend to create files. Use clear headings and concise sections; use Markdown tables for spreadsheet-ready data and slide-sized sections for presentation-ready content.`
      : '';
    const outputContract = outputContractFromTaskInput(task.input);
    if (attachments.citations.length) {
      await taskEvent(task.workspace_id, task.id, 'attachments.retrieved', `${attachments.citations.length} relevant attachment passage${attachments.citations.length === 1 ? '' : 's'} selected`, {
        citations: attachments.citations.map(({ content: _content, ...citation }) => citation),
      });
    }
    const system = checkpoint?.state.system ?? [
      `You are ${agent.name}, ${agent.role}. Your goal: ${agent.goal}.`,
      agent.instructions,
      outputContractInstruction(outputContract),
      artifactInstruction,
      attachments.text,
      knowledge ? `Use the following workspace knowledge when it is relevant. Do not invent facts beyond it:\n\n${knowledge}` : '',
    ].filter(Boolean).join('\n\n');
    if (anthropic) {
      const toolDefinitions: Tool[] = [...configuredTools.map(definitionFor), ...configuredMcpTools.map(anthropicMcpDefinition)];
      const messages: MessageParam[] = checkpoint?.state.provider === 'anthropic'
        ? checkpoint.state.messages as MessageParam[]
        : [{ role: 'user', content: `${task.title}\n\nInput:\n${JSON.stringify(task.input)}` }];
      let firstTurn = checkpoint?.state.provider === 'anthropic' ? checkpoint.state.nextTurn : 0;
      if (checkpoint?.state.provider === 'anthropic') {
        const pending = checkpoint.state.pending;
        const adapter = pending.adapter ?? 'mcp';
        const action: TaskToolAction | null = adapter === 'api'
          ? (toolById.get(pending.toolId) ? { adapter: 'api', tool: toolById.get(pending.toolId)! } : null)
          : (mcpToolById.get(pending.toolId) ? { adapter: 'mcp', tool: mcpToolById.get(pending.toolId)! } : null);
        let content: string;
        let isError = false;
        if (checkpoint.status === 'rejected') {
          content = 'The user rejected this external action. Do not retry it unless the user explicitly requests a new action.';
          isError = true;
        } else if (!action) {
          content = 'Tool access was revoked before the approved action executed.';
          isError = true;
          if (checkpoint.callId) await query("UPDATE mcp_tool_calls SET status='failed',error_code='MCP_ACCESS_REVOKED',error_message=$1,completed_at=now() WHERE id=$2", [content, checkpoint.callId]);
        } else {
          const authorization = await authorizeTaskToolAction(task, pending.providerCallId, action, pending.arguments, modelTrace);
          if (authorization.status !== 'allowed') throw new Error(authorization.status === 'denied' ? authorization.reason : 'Approved action is no longer executable');
          const executed = await executeTaskToolAction({ task, action, arguments_: pending.arguments, authorizationId: authorization.authorizationId, mcpToolCallId: checkpoint.callId, trace: authorization.trace, signal });
          content = JSON.stringify(executed.result).slice(0, 50_000);
        }
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: pending.providerCallId, content, is_error: isError }] });
      }
      for (let turn = firstTurn; turn < 8; turn++) {
        const result = await anthropic.messages.create({
          model: agent.model,
          max_tokens: runtimePolicy.modelConfig.maxTokens,
          temperature: runtimePolicy.modelConfig.temperature,
          top_p: runtimePolicy.modelConfig.topP,
          system,
          messages,
          tools: toolDefinitions.length ? toolDefinitions : undefined,
          tool_choice: toolDefinitions.length ? { type: 'auto', disable_parallel_tool_use: true } : undefined,
        }, { signal }).withResponse();
        const response = result.data;
        await recordAiUsage({
          workspaceId: task.workspace_id,
          taskId: task.id,
          workflowRunId: task.workflow_run_id,
          source: 'task',
          provider,
          model: agent.model,
          requestId: result.request_id,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          headers: result.response.headers,
        });
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
        finalText += response.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        const toolUses = response.content.filter((block) => block.type === 'tool_use').slice(0, 1);
        if (!toolUses.length) break;
        messages.push({ role: 'assistant', content: response.content });
        const results: Array<{ type: 'tool_result'; tool_use_id: string; is_error?: boolean; content: string }> = [];
        for (const use of toolUses) {
          const tool = toolByName.get(use.name);
          const mcpTool = mcpToolByName.get(use.name);
          if (!tool && !mcpTool) {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'This tool is not authorized for the current agent.' });
            continue;
          }
          toolCallCount++;
          const action: TaskToolAction = mcpTool ? { adapter: 'mcp', tool: mcpTool } : { adapter: 'api', tool: tool! };
          const arguments_ = use.input as Record<string, unknown>;
          try {
            const authorization = await authorizeTaskToolAction(task, use.id, action, arguments_, modelTrace);
            await taskEvent(task.workspace_id, task.id, 'action.requested', `Requesting ${actionName(action)}`, {
              authorizationId: authorization.authorizationId,
              adapter: action.adapter,
              toolId: action.tool.id,
              input: safeActionSummary(arguments_),
            }, authorization.trace);
            if (authorization.status === 'awaiting_confirmation') {
              const state: TaskActionCheckpointState = {
                provider: 'anthropic', system, messages, finalText, inputTokens, outputTokens, toolCallCount, nextTurn: turn + 1,
                pending: { adapter: action.adapter, toolId: action.tool.id, providerCallId: use.id, arguments: arguments_, authorizationId: authorization.authorizationId },
              };
              const paused = await pauseForActionConfirmation({
                workspaceId: task.workspace_id,
                taskId: task.id,
                workflowRunId: task.workflow_run_id,
                agentId: task.agent_id,
                requestedBy: task.requested_by,
                authorizationId: authorization.authorizationId,
                state,
                mcpTool: action.adapter === 'mcp' ? action.tool : undefined,
                trace: childTraceContext(authorization.trace),
              });
              await taskEvent(task.workspace_id, task.id, 'action.confirmation.requested', 'Human confirmation is required before this action', {
                authorizationId: authorization.authorizationId,
                toolCallId: paused.toolCallId,
                toolId: action.tool.id,
                riskLevel: action.adapter === 'api' ? toolRiskLevel(action.tool) : action.tool.risk_level,
              }, authorization.trace);
              return { awaitingApproval: true, authorizationId: authorization.authorizationId };
            }
            if (authorization.status === 'denied') throw new Error(authorization.reason);
            const executed = authorization.status === 'completed'
              ? { result: authorization.result, toolCallId: null }
              : await executeTaskToolAction({ task, action, arguments_, authorizationId: authorization.authorizationId, trace: authorization.trace, signal });
            await taskEvent(task.workspace_id, task.id, 'action.completed', `${actionName(action)} completed`, { authorizationId: authorization.authorizationId, toolCallId: executed.toolCallId, adapter: action.adapter, toolId: action.tool.id }, authorization.trace);
            results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(executed.result).slice(0, 50_000) });
          } catch (error) {
            const serialized = serializeRuntimeError(error);
            if (signal.aborted || serialized.category === 'cancelled') throw cancellationError(error);
            await taskEvent(task.workspace_id, task.id, 'action.failed', `${actionName(action)} failed`, {
              adapter: action.adapter,
              toolId: action.tool.id,
              error: serialized,
            });
            results.push({
              type: 'tool_result',
              tool_use_id: use.id,
              is_error: true,
              content: serialized.message,
            });
          }
        }
        messages.push({ role: 'user', content: results });
      }
    } else if (openAiCompatible) {
      const messages: ChatCompletionMessageParam[] = checkpoint?.state.provider === 'openai-compatible'
        ? checkpoint.state.messages as ChatCompletionMessageParam[]
        : [{ role: 'system', content: system }, { role: 'user', content: `${task.title}\n\nInput:\n${JSON.stringify(task.input)}` }];
      const toolDefinitions = [...openAiToolDefinitions(configuredTools), ...configuredMcpTools.map(openAiMcpDefinition)];
      let firstTurn = checkpoint?.state.provider === 'openai-compatible' ? checkpoint.state.nextTurn : 0;
      if (checkpoint?.state.provider === 'openai-compatible') {
        const pending = checkpoint.state.pending;
        const adapter = pending.adapter ?? 'mcp';
        const action: TaskToolAction | null = adapter === 'api'
          ? (toolById.get(pending.toolId) ? { adapter: 'api', tool: toolById.get(pending.toolId)! } : null)
          : (mcpToolById.get(pending.toolId) ? { adapter: 'mcp', tool: mcpToolById.get(pending.toolId)! } : null);
        let content: string;
        if (checkpoint.status === 'rejected') {
          content = 'The user rejected this external action. Do not retry it unless the user explicitly requests a new action.';
        } else if (!action) {
          content = 'Tool access was revoked before the approved action executed.';
          if (checkpoint.callId) await query("UPDATE mcp_tool_calls SET status='failed',error_code='MCP_ACCESS_REVOKED',error_message=$1,completed_at=now() WHERE id=$2", [content, checkpoint.callId]);
        } else {
          const authorization = await authorizeTaskToolAction(task, pending.providerCallId, action, pending.arguments, modelTrace);
          if (authorization.status !== 'allowed') throw new Error(authorization.status === 'denied' ? authorization.reason : 'Approved action is no longer executable');
          const executed = await executeTaskToolAction({ task, action, arguments_: pending.arguments, authorizationId: authorization.authorizationId, mcpToolCallId: checkpoint.callId, trace: authorization.trace, signal });
          content = JSON.stringify(executed.result).slice(0, 50_000);
        }
        messages.push({ role: 'tool', tool_call_id: pending.providerCallId, content });
      }
      for (let turn = firstTurn; turn < 8; turn++) {
        const result = await openAiCompatible.chat.completions.create({
          model: agent.model,
          max_tokens: runtimePolicy.modelConfig.maxTokens,
          temperature: runtimePolicy.modelConfig.temperature,
          top_p: runtimePolicy.modelConfig.topP,
          messages,
          tools: toolDefinitions.length ? toolDefinitions : undefined,
          parallel_tool_calls: toolDefinitions.length ? false : undefined,
          response_format: outputContract === 'grader' ? { type: 'json_object' } : undefined,
        }, { signal }).withResponse();
        const response = result.data;
        await recordAiUsage({
          workspaceId: task.workspace_id,
          taskId: task.id,
          workflowRunId: task.workflow_run_id,
          source: 'task',
          provider,
          model: agent.model,
          requestId: result.request_id,
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          headers: result.response.headers,
        });
        inputTokens += response.usage?.prompt_tokens ?? 0;
        outputTokens += response.usage?.completion_tokens ?? 0;
        const message = response.choices[0]?.message;
        if (!message) throw new Error('LLM response did not include a message');
        finalText += message.content ?? '';
        const toolUses = message.tool_calls?.filter((use) => use.type === 'function').slice(0, 1) ?? [];
        if (!toolUses.length) break;
        messages.push({ role: 'assistant', content: message.content, tool_calls: message.tool_calls });
        const results: Array<{ role: 'tool'; tool_call_id: string; content: string }> = [];
        for (const use of toolUses) {
          const tool = toolByName.get(use.function.name);
          const mcpTool = mcpToolByName.get(use.function.name);
          if (!tool && !mcpTool) {
            results.push({ role: 'tool', tool_call_id: use.id, content: 'This tool is not authorized for the current agent.' });
            continue;
          }
          let input: Record<string, unknown>;
          try {
            const parsed = JSON.parse(use.function.arguments);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Tool arguments must be an object');
            input = parsed as Record<string, unknown>;
          } catch (error) {
            results.push({ role: 'tool', tool_call_id: use.id, content: `Invalid tool arguments: ${error instanceof Error ? error.message : 'invalid JSON'}` });
            continue;
          }
          toolCallCount++;
          const action: TaskToolAction = mcpTool ? { adapter: 'mcp', tool: mcpTool } : { adapter: 'api', tool: tool! };
          try {
            const authorization = await authorizeTaskToolAction(task, use.id, action, input, modelTrace);
            await taskEvent(task.workspace_id, task.id, 'action.requested', `Requesting ${actionName(action)}`, {
              authorizationId: authorization.authorizationId,
              adapter: action.adapter,
              toolId: action.tool.id,
              input: safeActionSummary(input),
            }, authorization.trace);
            if (authorization.status === 'awaiting_confirmation') {
              const state: TaskActionCheckpointState = {
                provider: 'openai-compatible', system, messages, finalText, inputTokens, outputTokens, toolCallCount, nextTurn: turn + 1,
                pending: { adapter: action.adapter, toolId: action.tool.id, providerCallId: use.id, arguments: input, authorizationId: authorization.authorizationId },
              };
              const paused = await pauseForActionConfirmation({
                workspaceId: task.workspace_id,
                taskId: task.id,
                workflowRunId: task.workflow_run_id,
                agentId: task.agent_id,
                requestedBy: task.requested_by,
                authorizationId: authorization.authorizationId,
                state,
                mcpTool: action.adapter === 'mcp' ? action.tool : undefined,
                trace: childTraceContext(authorization.trace),
              });
              await taskEvent(task.workspace_id, task.id, 'action.confirmation.requested', 'Human confirmation is required before this action', {
                authorizationId: authorization.authorizationId,
                toolCallId: paused.toolCallId,
                toolId: action.tool.id,
                riskLevel: action.adapter === 'api' ? toolRiskLevel(action.tool) : action.tool.risk_level,
              }, authorization.trace);
              return { awaitingApproval: true, authorizationId: authorization.authorizationId };
            }
            if (authorization.status === 'denied') throw new Error(authorization.reason);
            const executed = authorization.status === 'completed'
              ? { result: authorization.result, toolCallId: null }
              : await executeTaskToolAction({ task, action, arguments_: input, authorizationId: authorization.authorizationId, trace: authorization.trace, signal });
            await taskEvent(task.workspace_id, task.id, 'action.completed', `${actionName(action)} completed`, { authorizationId: authorization.authorizationId, toolCallId: executed.toolCallId, adapter: action.adapter, toolId: action.tool.id }, authorization.trace);
            results.push({ role: 'tool', tool_call_id: use.id, content: JSON.stringify(executed.result).slice(0, 50_000) });
          } catch (error) {
            const serialized = serializeRuntimeError(error);
            if (signal.aborted || serialized.category === 'cancelled') throw cancellationError(error);
            await taskEvent(task.workspace_id, task.id, 'action.failed', `${actionName(action)} failed`, {
              adapter: action.adapter,
              toolId: action.tool.id,
              error: serialized,
            });
            results.push({ role: 'tool', tool_call_id: use.id, content: serialized.message });
          }
        }
        messages.push(...results);
      }
    }
    const text = finalText.trim();
    const durationMs = Date.now() - started;
    const output = parseAgentOutput(text, outputContract, toolCallCount);
    const estimatedCostUsd = await estimatedWorkspaceAiCost(task.workspace_id, agent.model, inputTokens, outputTokens);
    signal.throwIfAborted();
    const completed = await query(
      `UPDATE tasks SET status='completed',output=$1,token_input=$2,token_output=$3,
              estimated_cost_usd=$4,duration_ms=$5,completed_at=now(),updated_at=now()
        WHERE id=$6 AND status='running' RETURNING id`,
      [JSON.stringify(output), inputTokens, outputTokens, estimatedCostUsd, durationMs, task.id],
    );
    if (!completed.rowCount) throw cancellationError();
    await query('DELETE FROM task_runtime_checkpoints WHERE task_id=$1', [task.id]);
    await taskEvent(task.workspace_id, task.id, 'task.completed', 'Agent completed task', { durationMs, inputTokens, outputTokens, estimatedCostUsd, toolCallCount });
    try {
      const releasedArtifacts = await releaseTaskArtifacts(task.id, signal);
      if (releasedArtifacts.length) await taskEvent(task.workspace_id, task.id, 'artifacts.queued', `${releasedArtifacts.length} artifact${releasedArtifacts.length === 1 ? '' : 's'} queued`, { artifactIds: releasedArtifacts.map((artifact) => artifact.id) });
    } catch (artifactError) {
      await taskEvent(task.workspace_id, task.id, 'artifacts.queue_failed', 'Agent output completed, but downloadable files could not be queued', { error: artifactError instanceof Error ? artifactError.message : 'Artifact queue unavailable' });
    }
    if (checkpoint && task.workflow_run_id && task.workflow_node_id) {
      try {
        await query("UPDATE workflow_runs SET status='queued',updated_at=now() WHERE id=$1 AND status='awaiting_approval'", [task.workflow_run_id]);
        await enqueueWorkflowRun(task.workflow_run_id, `${task.workflow_run_id}:${task.id}:mcp-resume`, 0, task.trace_id);
      } catch (resumeError) {
        const serialized = serializeRuntimeError(resumeError);
        const failedRun = await query(
          "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3 AND status='queued' RETURNING id",
          [JSON.stringify({ error: serialized }), JSON.stringify(serialized), task.workflow_run_id],
        );
        if (!failedRun.rowCount) {
          await finalizeIfCancellationRequested({ kind: 'workflow_run', id: task.workflow_run_id });
        } else {
          await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [task.workflow_run_id]);
          await taskEvent(task.workspace_id, task.id, 'workflow.resume_failed', 'Task completed, but its workflow could not resume', { error: resumeError instanceof Error ? resumeError.message : 'Workflow queue unavailable' });
        }
      }
    }
    return output;
  } catch (error) {
    const serialized = serializeRuntimeError(error);
    if (signal.aborted || serialized.category === 'cancelled') {
      const cancellationFailure = serialized.category === 'cancelled' ? error : cancellationError(error);
      const cancellationSerialized = serializeRuntimeError(cancellationFailure);
      await taskEvent(task.workspace_id, task.id, 'task.cancelling', cancellationSerialized.message, {
        error: cancellationSerialized,
      }, taskTrace);
      await finalizeCancellation({ kind: 'task', id: task.id });
      return null;
    }
    const failedTask = await query(
      "UPDATE tasks SET status='failed',error=$1,completed_at=now(),updated_at=now() WHERE id=$2 AND status='running' RETURNING id",
      [JSON.stringify(serialized), task.id],
    );
    if (!failedTask.rowCount && await finalizeIfCancellationRequested({ kind: 'task', id: task.id })) return null;
    if (!failedTask.rowCount) throw error;
    await query("UPDATE artifacts SET status='failed',error_message='Source task failed',updated_at=now() WHERE task_id=$1 AND status='pending'", [task.id]);
    await taskEvent(task.workspace_id, task.id, 'task.failed', serialized.message, { error: serialized }, taskTrace);
    throw error;
    }
  } finally {
    cancellation.stop();
  }
}

new Worker<TaskJobData>(TASK_QUEUE, (job) => executeAgentTask(job.data.taskId, job.data.traceId), { connection, concurrency: 5 });

new Worker<ArtifactJobData>(ARTIFACT_QUEUE, async (job) => {
  await generateArtifact(job.data.artifactId, job.data.trace);
}, { connection, concurrency: 2 });

new Worker<FileJobData>(FILE_QUEUE, async (job) => {
  await processFile(job.data.fileId, job.data.trace);
}, { connection, concurrency: 2 });

new Worker<KnowledgeJobData>(KNOWLEDGE_QUEUE, async (job) => {
  const document = (await query<{ id: string; workspace_id: string; source_type: string; source_uri: string | null; content: string | null }>("SELECT id,workspace_id,source_type,source_uri,content FROM knowledge_documents WHERE id=$1 AND status='queued'", [job.data.documentId])).rows[0];
  if (!document) return;
  await query("UPDATE knowledge_documents SET status='processing',updated_at=now() WHERE id=$1", [document.id]);
  try {
    let content = document.content;
    if (!content && document.source_type === 'url' && document.source_uri) {
      const address = await assertPublicHttpsUrl(document.source_uri);
      const response = await fetch(address, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'AI-Nexus-Knowledge-Ingest/1.0' } });
      if (!response.ok) throw new Error(`Source URL returned ${response.status}`);
      content = (await response.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ').replace(/\s+/g, ' ').trim();
    }
    if (!content) throw new Error('No extractable text was supplied; upload extracted text or configure the document extraction service');
    const chunks = splitIntoChunks(content);
    if (!chunks.length) throw new Error('Document contains no indexable text');
    await query('DELETE FROM knowledge_chunks WHERE document_id=$1', [document.id]);
    for (const [ordinal, chunk] of chunks.entries()) {
      const embedding = await embeddingFor(chunk);
      const vector = embedding ? `[${embedding.join(',')}]` : null;
      await query('INSERT INTO knowledge_chunks(workspace_id,document_id,ordinal,content,embedding) VALUES($1,$2,$3,$4,$5::vector)', [document.workspace_id, document.id, ordinal, chunk, vector]);
    }
    await query("UPDATE knowledge_documents SET status='ready',content=$1,updated_at=now() WHERE id=$2", [content, document.id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Knowledge ingestion failed';
    await query("UPDATE knowledge_documents SET status='failed',metadata=metadata || jsonb_build_object('error',$1),updated_at=now() WHERE id=$2", [message, document.id]);
    throw error;
  }
}, { connection, concurrency: 2 });

new Worker<WorkflowJobData>(WORKFLOW_QUEUE, async (job) => {
  const run = (await query<{
    workspace_id: string;
    workflow_version_id: string | null;
    definition_snapshot: WorkflowDefinition;
    run_mode: 'test' | 'production';
    execution_manifest: ExecutionManifest | null;
    trace_id: string;
    span_id: string;
    parent_span_id: string | null;
    created_at: string;
    runtime_trust_migration_applied_at: string | null;
    status: 'queued' | 'cancel_requested';
  }>(
    `SELECT workspace_id,workflow_version_id,definition_snapshot,run_mode,execution_manifest,
            trace_id,span_id,parent_span_id,created_at,status,
            (SELECT applied_at FROM schema_migrations WHERE name='031_runtime_trust.sql')
              runtime_trust_migration_applied_at
       FROM workflow_runs WHERE id=$1 AND status IN ('queued','cancel_requested')`,
    [job.data.workflowRunId],
  )).rows[0];
  if (!run) return null;
  authoritativeQueuedTraceContext(
    run,
    job.data.traceId,
    run.runtime_trust_migration_applied_at,
  );
  const cancellation = await createCancellationContext({
    kind: 'workflow_run',
    id: job.data.workflowRunId,
  });
  try {
    if (cancellation.signal.aborted || run.status === 'cancel_requested') {
      await finalizeCancellation({ kind: 'workflow_run', id: job.data.workflowRunId });
      return null;
    }
    if (run.run_mode === 'production') {
      try {
        await assertWorkflowRunManifestDependencies(run);
      } catch (error) {
        const serialized = serializeRuntimeError(error);
        const failedRun = await query(
          `UPDATE workflow_runs
              SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now()
            WHERE id=$3 AND status IN ('queued','awaiting_approval')
            RETURNING id`,
          [JSON.stringify({ error: serialized }), JSON.stringify(serialized), job.data.workflowRunId],
        );
        if (!failedRun.rowCount && await finalizeIfCancellationRequested({
          kind: 'workflow_run',
          id: job.data.workflowRunId,
        })) return null;
        await query(
          "UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'",
          [job.data.workflowRunId],
        );
        throw error;
      }
    }
    const result = await executeWorkflowStep(
      job.data.workflowRunId,
      executeAgentTask,
      cancellation.signal,
    );
    if (cancellation.signal.aborted) {
      await finalizeCancellation({ kind: 'workflow_run', id: job.data.workflowRunId });
      return null;
    }
    if (await finalizeIfCancellationRequested({
      kind: 'workflow_run',
      id: job.data.workflowRunId,
    })) return null;
    return result;
  } catch (error) {
    const serialized = serializeRuntimeError(error);
    if (cancellation.signal.aborted || serialized.category === 'cancelled') {
      await finalizeCancellation({ kind: 'workflow_run', id: job.data.workflowRunId });
      return null;
    }
    if (await finalizeIfCancellationRequested({
      kind: 'workflow_run',
      id: job.data.workflowRunId,
    })) return null;
    throw error;
  } finally {
    cancellation.stop();
  }
}, { connection, concurrency: 2 });

startMcpMaintenance();
const fileCleanup = setInterval(() => { void purgeExpiredFiles(); }, 60 * 60 * 1_000);
fileCleanup.unref();
console.log('Woody task, workflow, file, artifact, knowledge, and MCP maintenance workers started');
