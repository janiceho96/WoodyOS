import 'dotenv/config';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { lookup } from 'node:dns/promises';
import { query } from './db/client.js';
import { ARTIFACT_QUEUE, TASK_QUEUE, WORKFLOW_QUEUE, KNOWLEDGE_QUEUE, enqueueWorkflowRun } from './queue/task-queue.js';
import { definitionFor, invokeTool, type ToolRecord } from './tools/runtime.js';
import { embeddingFor } from './lib/embeddings.js';
import { configuredAiProvider } from './lib/ai-provider.js';
import { assertWorkspaceAiBudgetAvailable, estimatedWorkspaceAiCost, recordAiUsage } from './lib/ai-usage.js';
import { isPublicIp } from './lib/network.js';
import { resolveAgentRuntimePolicy, retrieveAgentKnowledge } from './lib/agent-runtime.js';
import {
  anthropicMcpDefinition,
  authorizedMcpTools,
  executeAuthorizedMcpTool,
  mcpRequiresConfirmation,
  mcpToolRuntimeName,
  openAiMcpDefinition,
  safeArgumentsSummary,
  type AuthorizedMcpTool,
} from './mcp/runtime.js';
import { loadMcpCheckpoint, pauseForMcpConfirmation, type McpCheckpointState } from './mcp/checkpoints.js';
import { startMcpMaintenance } from './mcp/maintenance.js';
import { generateArtifact, releaseTaskArtifacts } from './artifacts/service.js';
import { executeWorkflowStep } from './workflows/runtime.js';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
const aiProvider = configuredAiProvider();
const provider = aiProvider.provider;
const anthropic = aiProvider.anthropic;
const openAiCompatible = aiProvider.openAiCompatible;

if (!anthropic && !openAiCompatible && process.env.NODE_ENV === 'production') {
  throw new Error('Configure ANTHROPIC_API_KEY or LLM_PROVIDER=openai-compatible with LLM_API_KEY and LLM_BASE_URL before starting the production worker');
}

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
};
type WorkflowNode = { id: string; type: 'trigger' | 'agent' | 'action' | 'condition' | 'approval' | 'loop' | 'output'; config: Record<string, unknown> };
type WorkflowDefinition = { nodes: WorkflowNode[]; edges: Array<{ source: string; target: string; condition?: string }> };

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

async function taskEvent(workspaceId: string, taskId: string, type: string, message: string, payload: Record<string, unknown> = {}) {
  await query('INSERT INTO task_events(workspace_id,task_id,event_type,message,payload) VALUES($1,$2,$3,$4,$5)', [workspaceId, taskId, type, message, JSON.stringify(payload)]);
}
async function workflowEvent(workspaceId: string, runId: string, nodeId: string | null, type: string, message: string, payload: Record<string, unknown> = {}) {
  await query('INSERT INTO workflow_run_events(workspace_id,workflow_run_id,node_id,event_type,message,payload) VALUES($1,$2,$3,$4,$5,$6)', [workspaceId, runId, nodeId, type, message, JSON.stringify(payload)]);
}

export async function executeAgentTask(taskId: string) {
  const task = (await query<Task>(
    `UPDATE tasks SET status='running',started_at=COALESCE(started_at,now()),updated_at=now()
     WHERE id=$1 AND status='queued' RETURNING *`,
    [taskId],
  )).rows[0];
  if (!task) return null;
  const agent = (await query<Agent>('SELECT name,role,goal,instructions,model,model_config,capabilities,memory_config,tool_ids FROM agents WHERE id=$1', [task.agent_id])).rows[0];
  if (!agent) throw new Error('Agent is missing');
  const checkpoint = await loadMcpCheckpoint(task.workspace_id, task.id);
  await taskEvent(task.workspace_id, task.id, checkpoint ? 'task.resumed' : 'task.started', checkpoint ? `${agent.name} resumed after MCP confirmation` : `${agent.name} started execution`);
  try {
    await assertWorkspaceAiBudgetAvailable(task.workspace_id);
    if (!anthropic && !openAiCompatible) throw Object.assign(new Error('No configured LLM provider is available'), { code: 'AI_NOT_CONFIGURED' });
    await taskEvent(task.workspace_id, task.id, 'model.requested', `Sending task to ${agent.model}`);
    const toolIds = Array.isArray(agent.tool_ids) ? agent.tool_ids.filter((id): id is string => typeof id === 'string') : [];
    const assignedTools = toolIds.length ? (await query<ToolRecord>('SELECT id,name,kind,config,permissions FROM tools WHERE workspace_id=$1 AND enabled=true AND id = ANY($2::uuid[])', [task.workspace_id, toolIds])).rows : [];
    const runtimePolicy = resolveAgentRuntimePolicy(agent, assignedTools);
    const configuredTools = runtimePolicy.tools;
    const configuredMcpTools = await authorizedMcpTools(task.workspace_id, task.agent_id);
    if (runtimePolicy.deniedTools.length) {
      await taskEvent(task.workspace_id, task.id, 'capability.enforced', 'Some assigned tools were unavailable under the agent capability policy', {
        deniedToolIds: runtimePolicy.deniedTools.map((tool) => tool.id),
      });
    }
    const toolByName = new Map(configuredTools.map((tool) => [`tool_${tool.id.replaceAll('-', '_')}`, tool]));
    const mcpToolByName = new Map(configuredMcpTools.map((tool) => [mcpToolRuntimeName(tool.id), tool]));
    const mcpToolById = new Map(configuredMcpTools.map((tool) => [tool.id, tool]));
    const started = Date.now();
    let inputTokens = checkpoint?.state.inputTokens ?? 0;
    let outputTokens = checkpoint?.state.outputTokens ?? 0;
    let finalText = checkpoint?.state.finalText ?? '';
    let toolCallCount = checkpoint?.state.toolCallCount ?? 0;
    const requestText = `${task.title}\n${JSON.stringify(task.input)}`;
    const [knowledge, requestedArtifacts] = await Promise.all([
      runtimePolicy.knowledgeEnabled ? retrieveAgentKnowledge(task.workspace_id, requestText) : Promise.resolve(''),
      query<{ format: string }>('SELECT format FROM artifacts WHERE task_id=$1 OR ($2::uuid IS NOT NULL AND workflow_run_id=$2) ORDER BY format', [task.id, task.workflow_run_id]),
    ]);
    const artifactInstruction = requestedArtifacts.rows.length
      ? `The server will convert your canonical Markdown result into: ${requestedArtifacts.rows.map((item) => item.format.toUpperCase()).join(', ')}. Do not emit base64 or pretend to create files. Use clear headings and concise sections; use Markdown tables for spreadsheet-ready data and slide-sized sections for presentation-ready content.`
      : '';
    const system = checkpoint?.state.system ?? [
      `You are ${agent.name}, ${agent.role}. Your goal: ${agent.goal}.`,
      agent.instructions,
      artifactInstruction,
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
        const tool = mcpToolById.get(pending.toolId);
        let content: string;
        let isError = false;
        if (checkpoint.status === 'rejected') {
          content = 'The user rejected this external action. Do not retry it unless the user explicitly requests a new action.';
          isError = true;
        } else if (!tool) {
          content = 'MCP access was revoked before the approved action executed.';
          isError = true;
          await query("UPDATE mcp_tool_calls SET status='failed',error_code='MCP_ACCESS_REVOKED',error_message=$1,completed_at=now() WHERE id=$2", [content, checkpoint.callId]);
        } else {
          const executed = await executeAuthorizedMcpTool({
            tool,
            arguments_: pending.arguments,
            agentId: task.agent_id,
            taskId: task.id,
            workflowRunId: task.workflow_run_id,
            toolCallId: checkpoint.callId,
          });
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
        }).withResponse();
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
          if (mcpTool) {
            const arguments_ = use.input as Record<string, unknown>;
            await taskEvent(task.workspace_id, task.id, 'mcp.tool.requested', `Requesting ${mcpTool.title ?? mcpTool.remote_name}`, { toolId: mcpTool.id, input: safeArgumentsSummary(arguments_) });
            if (mcpRequiresConfirmation(mcpTool)) {
              const state: McpCheckpointState = {
                provider: 'anthropic',
                system,
                messages,
                finalText,
                inputTokens,
                outputTokens,
                toolCallCount,
                nextTurn: turn + 1,
                pending: { toolId: mcpTool.id, providerCallId: use.id, arguments: arguments_ },
              };
              const callId = await pauseForMcpConfirmation({
                workspaceId: task.workspace_id,
                taskId: task.id,
                workflowRunId: task.workflow_run_id,
                agentId: task.agent_id,
                requestedBy: task.requested_by,
                tool: mcpTool,
                state,
              });
              await taskEvent(task.workspace_id, task.id, 'mcp.confirmation.requested', 'Human confirmation is required before this external action', { toolCallId: callId, toolId: mcpTool.id, riskLevel: mcpTool.risk_level });
              return { awaitingApproval: true, toolCallId: callId };
            }
            try {
              const executed = await executeAuthorizedMcpTool({ tool: mcpTool, arguments_, agentId: task.agent_id, taskId: task.id, workflowRunId: task.workflow_run_id });
              results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(executed.result).slice(0, 50_000) });
              await taskEvent(task.workspace_id, task.id, 'mcp.tool.completed', `${mcpTool.title ?? mcpTool.remote_name} completed`, { toolCallId: executed.callId, toolId: mcpTool.id });
            } catch (error) {
              const message = error instanceof Error ? error.message : 'MCP tool invocation failed';
              results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: message });
              await taskEvent(task.workspace_id, task.id, 'mcp.tool.failed', message, { toolId: mcpTool.id });
            }
            continue;
          }
          await taskEvent(task.workspace_id, task.id, 'tool.called', `Calling ${tool!.name}`, { toolId: tool!.id, input: use.input });
          try {
            const result = await invokeTool(tool!, use.input as Record<string, unknown>);
            await taskEvent(task.workspace_id, task.id, 'tool.completed', `${tool!.name} completed`, { toolId: tool!.id });
            results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result).slice(0, 50_000) });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Tool invocation failed';
            await taskEvent(task.workspace_id, task.id, 'tool.failed', `${tool!.name} failed`, { toolId: tool!.id, error: message });
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: message });
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
        const tool = mcpToolById.get(pending.toolId);
        let content: string;
        if (checkpoint.status === 'rejected') {
          content = 'The user rejected this external action. Do not retry it unless the user explicitly requests a new action.';
        } else if (!tool) {
          content = 'MCP access was revoked before the approved action executed.';
          await query("UPDATE mcp_tool_calls SET status='failed',error_code='MCP_ACCESS_REVOKED',error_message=$1,completed_at=now() WHERE id=$2", [content, checkpoint.callId]);
        } else {
          const executed = await executeAuthorizedMcpTool({ tool, arguments_: pending.arguments, agentId: task.agent_id, taskId: task.id, workflowRunId: task.workflow_run_id, toolCallId: checkpoint.callId });
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
        }).withResponse();
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
          if (mcpTool) {
            await taskEvent(task.workspace_id, task.id, 'mcp.tool.requested', `Requesting ${mcpTool.title ?? mcpTool.remote_name}`, { toolId: mcpTool.id, input: safeArgumentsSummary(input) });
            if (mcpRequiresConfirmation(mcpTool)) {
              const state: McpCheckpointState = {
                provider: 'openai-compatible',
                system,
                messages,
                finalText,
                inputTokens,
                outputTokens,
                toolCallCount,
                nextTurn: turn + 1,
                pending: { toolId: mcpTool.id, providerCallId: use.id, arguments: input },
              };
              const callId = await pauseForMcpConfirmation({ workspaceId: task.workspace_id, taskId: task.id, workflowRunId: task.workflow_run_id, agentId: task.agent_id, requestedBy: task.requested_by, tool: mcpTool, state });
              await taskEvent(task.workspace_id, task.id, 'mcp.confirmation.requested', 'Human confirmation is required before this external action', { toolCallId: callId, toolId: mcpTool.id, riskLevel: mcpTool.risk_level });
              return { awaitingApproval: true, toolCallId: callId };
            }
            try {
              const executed = await executeAuthorizedMcpTool({ tool: mcpTool, arguments_: input, agentId: task.agent_id, taskId: task.id, workflowRunId: task.workflow_run_id });
              results.push({ role: 'tool', tool_call_id: use.id, content: JSON.stringify(executed.result).slice(0, 50_000) });
              await taskEvent(task.workspace_id, task.id, 'mcp.tool.completed', `${mcpTool.title ?? mcpTool.remote_name} completed`, { toolCallId: executed.callId, toolId: mcpTool.id });
            } catch (error) {
              const detail = error instanceof Error ? error.message : 'MCP tool invocation failed';
              results.push({ role: 'tool', tool_call_id: use.id, content: detail });
              await taskEvent(task.workspace_id, task.id, 'mcp.tool.failed', detail, { toolId: mcpTool.id });
            }
            continue;
          }
          await taskEvent(task.workspace_id, task.id, 'tool.called', `Calling ${tool!.name}`, { toolId: tool!.id, input });
          try {
            const result = await invokeTool(tool!, input);
            await taskEvent(task.workspace_id, task.id, 'tool.completed', `${tool!.name} completed`, { toolId: tool!.id });
            results.push({ role: 'tool', tool_call_id: use.id, content: JSON.stringify(result).slice(0, 50_000) });
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'Tool invocation failed';
            await taskEvent(task.workspace_id, task.id, 'tool.failed', `${tool!.name} failed`, { toolId: tool!.id, error: detail });
            results.push({ role: 'tool', tool_call_id: use.id, content: detail });
          }
        }
        messages.push(...results);
      }
    }
    const text = finalText.trim();
    const durationMs = Date.now() - started;
    const output = { text, toolCallCount };
    const estimatedCostUsd = await estimatedWorkspaceAiCost(task.workspace_id, agent.model, inputTokens, outputTokens);
    await query("UPDATE tasks SET status='completed',output=$1,token_input=$2,token_output=$3,estimated_cost_usd=$4,duration_ms=$5,completed_at=now(),updated_at=now() WHERE id=$6", [JSON.stringify(output), inputTokens, outputTokens, estimatedCostUsd, durationMs, task.id]);
    await query('DELETE FROM task_runtime_checkpoints WHERE task_id=$1', [task.id]);
    await taskEvent(task.workspace_id, task.id, 'task.completed', 'Agent completed task', { durationMs, inputTokens, outputTokens, estimatedCostUsd, toolCallCount });
    try {
      const releasedArtifacts = await releaseTaskArtifacts(task.id);
      if (releasedArtifacts.length) await taskEvent(task.workspace_id, task.id, 'artifacts.queued', `${releasedArtifacts.length} artifact${releasedArtifacts.length === 1 ? '' : 's'} queued`, { artifactIds: releasedArtifacts.map((artifact) => artifact.id) });
    } catch (artifactError) {
      await taskEvent(task.workspace_id, task.id, 'artifacts.queue_failed', 'Agent output completed, but downloadable files could not be queued', { error: artifactError instanceof Error ? artifactError.message : 'Artifact queue unavailable' });
    }
    if (checkpoint && task.workflow_run_id && task.workflow_node_id) {
      try {
        await query("UPDATE workflow_runs SET status='queued',updated_at=now() WHERE id=$1 AND status='awaiting_approval'", [task.workflow_run_id]);
        await enqueueWorkflowRun(task.workflow_run_id, `${task.workflow_run_id}:${task.id}:mcp-resume`);
      } catch (resumeError) {
        await query("UPDATE workflow_runs SET status='failed',output=$1,completed_at=now(),updated_at=now() WHERE id=$2 AND status='queued'", [JSON.stringify({ error: 'Workflow could not resume after tool approval' }), task.workflow_run_id]);
        await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [task.workflow_run_id]);
        await taskEvent(task.workspace_id, task.id, 'workflow.resume_failed', 'Task completed, but its workflow could not resume', { error: resumeError instanceof Error ? resumeError.message : 'Workflow queue unavailable' });
      }
    }
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown worker error';
    await query("UPDATE tasks SET status='failed',error=$1,completed_at=now(),updated_at=now() WHERE id=$2", [JSON.stringify({ message }), task.id]);
    await query("UPDATE artifacts SET status='failed',error_message='Source task failed',updated_at=now() WHERE task_id=$1 AND status='pending'", [task.id]);
    await taskEvent(task.workspace_id, task.id, 'task.failed', message);
    throw error;
  }
}

new Worker<{ taskId: string }>(TASK_QUEUE, (job) => executeAgentTask(job.data.taskId), { connection, concurrency: 5 });

new Worker<{ artifactId: string }>(ARTIFACT_QUEUE, async (job) => {
  await generateArtifact(job.data.artifactId);
}, { connection, concurrency: 2 });

new Worker<{ documentId: string }>(KNOWLEDGE_QUEUE, async (job) => {
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

new Worker<{ workflowRunId: string }>(WORKFLOW_QUEUE, (job) => executeWorkflowStep(job.data.workflowRunId, executeAgentTask), { connection, concurrency: 2 });

startMcpMaintenance();
console.log('Woody task, workflow, artifact, knowledge, and MCP maintenance workers started');
