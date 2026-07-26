import { query } from '../db/client.js';
import type { ToolRecord } from '../tools/runtime.js';
import { searchWorkspaceKnowledge } from '../knowledge/retrieval.js';

export type AgentModelConfig = {
  temperature: number;
  maxTokens: number;
  topP: number;
};

export type AgentCapabilities = {
  webBrowser: boolean;
  codeInterpreter: boolean;
  knowledgeBase: boolean;
};

export type AgentRuntimeSource = {
  model_config: unknown;
  capabilities: unknown;
  memory_config: unknown;
  tool_ids: unknown;
};

export type VersionedAgentRuntimeSource = AgentRuntimeSource & {
  name: string;
  role: string;
  goal: string;
  instructions: string;
  model: string;
};

export type AgentRuntimePolicy = {
  modelConfig: AgentModelConfig;
  capabilities: AgentCapabilities;
  knowledgeEnabled: boolean;
  tools: ToolRecord[];
  deniedTools: ToolRecord[];
};

const DEFAULT_MODEL_CONFIG: AgentModelConfig = {
  temperature: 0.2,
  maxTokens: 4096,
  topP: 1,
};

const DEFAULT_CAPABILITIES: AgentCapabilities = {
  webBrowser: false,
  codeInterpreter: false,
  knowledgeBase: true,
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeModelConfig(value: unknown): AgentModelConfig {
  const config = objectValue(value);
  return {
    temperature: finiteNumber(config.temperature, DEFAULT_MODEL_CONFIG.temperature, 0, 2),
    maxTokens: Math.round(finiteNumber(config.maxTokens, DEFAULT_MODEL_CONFIG.maxTokens, 128, 128_000)),
    topP: finiteNumber(config.topP, DEFAULT_MODEL_CONFIG.topP, 0, 1),
  };
}

export function normalizeCapabilities(value: unknown): AgentCapabilities {
  const capabilities = objectValue(value);
  return {
    webBrowser: booleanValue(capabilities.webBrowser, DEFAULT_CAPABILITIES.webBrowser),
    codeInterpreter: booleanValue(capabilities.codeInterpreter, DEFAULT_CAPABILITIES.codeInterpreter),
    knowledgeBase: booleanValue(capabilities.knowledgeBase, DEFAULT_CAPABILITIES.knowledgeBase),
  };
}

export function agentRuntimeSourceFromSnapshot(snapshot: {
  name: string;
  role: string;
  goal: string;
  instructions: string;
  model: string;
  modelConfig: AgentModelConfig;
  capabilities: AgentCapabilities;
  apiToolIds: string[];
  memoryConfig: Record<string, unknown>;
}): VersionedAgentRuntimeSource {
  return {
    name: snapshot.name,
    role: snapshot.role,
    goal: snapshot.goal,
    instructions: snapshot.instructions,
    model: snapshot.model,
    model_config: snapshot.modelConfig,
    capabilities: snapshot.capabilities,
    memory_config: snapshot.memoryConfig,
    tool_ids: snapshot.apiToolIds,
  };
}

function requiredCapability(tool: ToolRecord): keyof AgentCapabilities | null {
  const signals = `${tool.name} ${tool.permissions.join(' ')}`.toLowerCase();
  if (/(^|[\s._:-])(knowledge|rag)([\s._:-]|$)/.test(signals)) return 'knowledgeBase';
  if (/(^|[\s._:-])(code|shell|exec|interpreter|terminal)([\s._:-]|$)/.test(signals)) return 'codeInterpreter';
  if (/(^|[\s._:-])(web|browser|internet)([\s._:-]|$)/.test(signals)) return 'webBrowser';
  return null;
}

export function resolveAgentRuntimePolicy(agent: AgentRuntimeSource, configuredTools: ToolRecord[]): AgentRuntimePolicy {
  const capabilities = normalizeCapabilities(agent.capabilities);
  const memoryConfig = objectValue(agent.memory_config);
  const allowedToolIds = new Set(
    Array.isArray(agent.tool_ids)
      ? agent.tool_ids.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const selectedTools = configuredTools.filter((tool) => allowedToolIds.has(tool.id));
  const tools: ToolRecord[] = [];
  const deniedTools: ToolRecord[] = [];

  for (const tool of selectedTools) {
    const capability = requiredCapability(tool);
    if (capability && !capabilities[capability]) deniedTools.push(tool);
    else tools.push(tool);
  }

  return {
    modelConfig: normalizeModelConfig(agent.model_config),
    capabilities,
    knowledgeEnabled: capabilities.knowledgeBase && booleanValue(memoryConfig.knowledgeBase, true),
    tools,
    deniedTools,
  };
}

export async function retrieveAgentKnowledge(workspaceId: string, requestText: string, limit = 4) {
  const results = await searchWorkspaceKnowledge(workspaceId, requestText, Math.min(8, Math.max(1, limit)));
  if (!results.length) return '';
  return results
    .map((row, index) => `[Knowledge ${index + 1}: ${row.documentName}]\n${row.content}`)
    .join('\n\n');
}
