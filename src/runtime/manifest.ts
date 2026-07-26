import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { db } from '../db/client.js';
import { decryptJson } from '../lib/crypto.js';
import type { AgentVersionSnapshot } from '../agents/versions.js';
import type { WorkflowDefinition } from '../workflows/definition.js';
import { workflowNodeDefinition } from '../workflows/registry.js';
import type { StoredConfig } from '../tools/runtime.js';

export interface ExecutionManifest {
  manifestVersion: 1;
  createdAt: string;
  compatibility: 'exact' | 'legacy_partial';
  workflow?: { id: string; versionId: string; version: number; definitionHash: string };
  agents: Record<string, { versionId: string; version: number; snapshotHash: string }>;
  prompts: Record<string, { versionId: string; contentHash: string }>;
  models: Record<string, { provider: string; model: string; parametersHash: string }>;
  apiTools: Record<string, { toolId: string; schemaHash: string; permissionHash: string }>;
  mcpActions: Record<string, { connectionId: string; toolId: string; schemaHash: string; permissionHash: string }>;
  policy: { version: string };
  adapters: Record<string, string>;
  outputContracts: Record<string, string>;
  artifactTemplates: Record<string, string>;
  runtime: { version: string; stateSchemaVersion: 1 };
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

type AgentVersionRow = {
  id: string;
  agent_id: string;
  version: number;
  snapshot: AgentVersionSnapshot;
};

type ToolManifestRow = {
  id: string;
  kind: string;
  config: StoredConfig;
  permissions: string[];
};

type McpManifestRow = {
  id: string;
  agent_id: string;
  connection_id: string;
  remote_name: string;
  input_schema: unknown;
  transport: string;
  endpoint_url: string;
  connection_permission: string;
  tool_permission: string;
};

const sensitiveKey = /token|password|secret|authorization|(^|[-_])auth($|[-_])|api[-_]?key|cookie|credential|private[-_]?key|session|encrypted/i;
const RUNTIME_VERSION = process.env.RUNTIME_VERSION ?? '0.1.0';

function manifestError(code: string, details: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), {
    code,
    category: 'validation',
    retryable: false,
    statusCode: 409,
    details,
  });
}

export function canonicalJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item as Record<string, unknown>)
          .sort()
          .map((key) => [key, canonicalize((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(canonicalize(value));
}

export function canonicalJsonHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function forbiddenSensitiveField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenSensitiveField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, item]) => sensitiveKey.test(key) || forbiddenSensitiveField(item));
}

function exactManifestShape(value: Record<string, unknown>) {
  const recordFields = ['agents', 'prompts', 'models', 'apiTools', 'mcpActions', 'adapters', 'outputContracts', 'artifactTemplates'];
  return typeof value.createdAt === 'string'
    && recordFields.every((field) => value[field] && typeof value[field] === 'object' && !Array.isArray(value[field]))
    && value.policy && typeof value.policy === 'object'
    && value.runtime && typeof value.runtime === 'object';
}

export function validateManifestCompatibility(manifest: unknown): { ok: boolean; reasons: string[] } {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, reasons: ['Execution manifest is missing'] };
  }
  const value = manifest as Record<string, unknown>;
  const reasons: string[] = [];
  if (value.manifestVersion !== 1) reasons.push(`Unsupported manifest version ${String(value.manifestVersion)}`);
  if (value.compatibility === 'legacy_partial') reasons.push('Execution manifest is a legacy partial snapshot');
  else if (value.compatibility !== 'exact') reasons.push('Execution manifest compatibility is invalid');
  if (value.compatibility === 'exact' && !exactManifestShape(value)) reasons.push('Execution manifest is incomplete');
  const runtime = value.runtime && typeof value.runtime === 'object' && !Array.isArray(value.runtime)
    ? value.runtime as Record<string, unknown>
    : null;
  if (value.compatibility === 'exact' && runtime && runtime.stateSchemaVersion !== 1) {
    reasons.push(`Unsupported runtime state schema ${String(runtime.stateSchemaVersion)}`);
  }
  if (forbiddenSensitiveField(value)) reasons.push('Execution manifest contains forbidden sensitive fields');
  return { ok: reasons.length === 0, reasons };
}

async function publishedAgentVersions(
  client: Queryable,
  workspaceId: string,
  agentIds: string[],
) {
  const uniqueIds = [...new Set(agentIds)];
  if (!uniqueIds.length) return new Map<string, AgentVersionRow>();
  const result = await client.query<AgentVersionRow>(
    `SELECT version.id,version.agent_id,version.version,version.snapshot
       FROM agents agent
       JOIN agent_versions version
         ON version.id=agent.published_version_id
        AND version.agent_id=agent.id
        AND version.workspace_id=agent.workspace_id
      WHERE agent.workspace_id=$1 AND agent.status='active' AND agent.id=ANY($2::uuid[])`,
    [workspaceId, uniqueIds],
  );
  const versions = new Map(result.rows.map((row) => [row.agent_id, row]));
  const missing = uniqueIds.filter((id) => !versions.has(id));
  if (missing.length) throw manifestError('AGENT_VERSION_REQUIRED', { agentIds: missing });
  return versions;
}

function publicToolSchema(config: StoredConfig) {
  const decrypted = decryptJson(config);
  const inputSchema = decrypted.inputSchema && typeof decrypted.inputSchema === 'object'
    ? decrypted.inputSchema
    : { type: 'object', properties: {}, additionalProperties: true };
  return {
    inputSchema,
    endpoint: typeof decrypted.endpoint === 'string' ? decrypted.endpoint : null,
    method: typeof decrypted.method === 'string' ? decrypted.method.toUpperCase() : undefined,
    readOnly: decrypted.readOnly === true,
  };
}

async function apiToolManifest(
  client: Queryable,
  workspaceId: string,
  toolIds: string[],
) {
  const uniqueIds = [...new Set(toolIds)];
  if (!uniqueIds.length) return {};
  const result = await client.query<ToolManifestRow>(
    `SELECT id,kind,config,permissions FROM tools
      WHERE workspace_id=$1 AND enabled=true AND id=ANY($2::uuid[])`,
    [workspaceId, uniqueIds],
  );
  const rows = new Map(result.rows.map((row) => [row.id, row]));
  const missing = uniqueIds.filter((id) => !rows.has(id));
  if (missing.length) throw manifestError('API_TOOL_UNAVAILABLE', { toolIds: missing });
  return Object.fromEntries(uniqueIds.map((id) => {
    const tool = rows.get(id)!;
    return [id, {
      toolId: id,
      schemaHash: canonicalJsonHash(publicToolSchema(tool.config)),
      permissionHash: canonicalJsonHash({ kind: tool.kind, permissions: tool.permissions }),
    }];
  }));
}

async function mcpActionManifest(
  client: Queryable,
  workspaceId: string,
  agentIds: string[],
  requiredToolIds: string[] = [],
) {
  const uniqueAgentIds = [...new Set(agentIds)];
  if (!uniqueAgentIds.length) {
    if (requiredToolIds.length) throw manifestError('MCP_ACTION_UNAVAILABLE', { toolIds: requiredToolIds });
    return {};
  }
  const result = await client.query<McpManifestRow>(
    `SELECT tool.id,connection_access.agent_id,connection.id connection_id,tool.remote_name,
            tool.input_schema,connection.transport,connection.endpoint_url,
            connection_access.permission_level connection_permission,
            tool_access.permission_level tool_permission
       FROM mcp_connection_tools tool
       JOIN mcp_connections connection ON connection.id=tool.connection_id
       JOIN mcp_agent_access connection_access
         ON connection_access.connection_id=connection.id
        AND connection_access.agent_id=ANY($2::uuid[])
        AND connection_access.enabled=true
       JOIN mcp_agent_tool_access tool_access
         ON tool_access.mcp_tool_id=tool.id
        AND tool_access.agent_id=connection_access.agent_id
        AND tool_access.enabled=true
      WHERE connection.workspace_id=$1
        AND connection.deleted_at IS NULL
        AND connection.enabled=true
        AND connection.health_status='healthy'
        AND tool.enabled=true`,
    [workspaceId, uniqueAgentIds],
  );
  const byId = new Map<string, McpManifestRow[]>();
  for (const row of result.rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  const missing = [...new Set(requiredToolIds)].filter((id) => !byId.has(id));
  if (missing.length) throw manifestError('MCP_ACTION_UNAVAILABLE', { toolIds: missing });
  return Object.fromEntries([...byId.entries()].map(([id, rows]) => {
    const row = rows[0];
    return [id, {
      connectionId: row.connection_id,
      toolId: id,
      schemaHash: canonicalJsonHash({
        inputSchema: row.input_schema,
        remoteName: row.remote_name,
        transport: row.transport,
        endpoint: row.endpoint_url,
      }),
      permissionHash: canonicalJsonHash(rows
        .map((permission) => ({
          agentId: permission.agent_id,
          connection: permission.connection_permission,
          tool: permission.tool_permission,
        }))
        .sort((left, right) => left.agentId.localeCompare(right.agentId))),
    }];
  }));
}

async function promptManifest(client: Queryable, workspaceId: string, versionIds: string[]) {
  const uniqueIds = [...new Set(versionIds)];
  if (!uniqueIds.length) return {};
  const rows = await client.query<{ id: string; content: string; variables: unknown }>(
    `SELECT version.id,version.content,version.variables
       FROM prompt_versions version
       JOIN prompt_templates template ON template.id=version.template_id
      WHERE template.workspace_id=$1 AND version.id=ANY($2::uuid[])`,
    [workspaceId, uniqueIds],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const missing = uniqueIds.filter((id) => !byId.has(id));
  if (missing.length) throw manifestError('PROMPT_VERSION_UNAVAILABLE', { versionIds: missing });
  return Object.fromEntries(uniqueIds.map((id) => [id, {
    versionId: id,
    contentHash: canonicalJsonHash({ content: byId.get(id)!.content, variables: byId.get(id)!.variables }),
  }]));
}

async function artifactTemplateManifest(client: Queryable, workspaceId: string, templateIds: string[]) {
  const uniqueIds = [...new Set(templateIds)];
  if (!uniqueIds.length) return {};
  const rows = await client.query<{ id: string; format: string; design_markdown: string; theme: unknown }>(
    `SELECT id,format,design_markdown,theme FROM artifact_templates
      WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,
    [workspaceId, uniqueIds],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const missing = uniqueIds.filter((id) => !byId.has(id));
  if (missing.length) throw manifestError('ARTIFACT_TEMPLATE_UNAVAILABLE', { templateIds: missing });
  return Object.fromEntries(uniqueIds.map((id) => {
    const row = byId.get(id)!;
    return [id, canonicalJsonHash({ format: row.format, designMarkdown: row.design_markdown, theme: row.theme })];
  }));
}

function agentEntries(versions: Map<string, AgentVersionRow>) {
  return Object.fromEntries([...versions.entries()].map(([agentId, row]) => [agentId, {
    versionId: row.id,
    version: row.version,
    snapshotHash: canonicalJsonHash(row.snapshot),
  }]));
}

function modelEntries(versions: Map<string, AgentVersionRow>, provider: string) {
  return Object.fromEntries([...versions.entries()].map(([agentId, row]) => [agentId, {
    provider,
    model: row.snapshot.model,
    parametersHash: canonicalJsonHash(row.snapshot.modelConfig),
  }]));
}

async function modelProvider(client: Queryable, workspaceId: string) {
  const configured = (await client.query<{ provider: string }>(
    'SELECT provider FROM workspace_ai_provider_configs WHERE workspace_id=$1',
    [workspaceId],
  )).rows[0]?.provider;
  return configured ?? process.env.LLM_PROVIDER ?? 'anthropic';
}

export async function buildTaskManifest(
  input: { workspaceId: string; agentId: string },
  client: Queryable = db,
): Promise<ExecutionManifest> {
  const versions = await publishedAgentVersions(client, input.workspaceId, [input.agentId]);
  const version = versions.get(input.agentId)!;
  const [apiTools, mcpActions, provider] = await Promise.all([
    apiToolManifest(client, input.workspaceId, version.snapshot.apiToolIds),
    mcpActionManifest(client, input.workspaceId, [input.agentId]),
    modelProvider(client, input.workspaceId),
  ]);
  return {
    manifestVersion: 1,
    createdAt: new Date().toISOString(),
    compatibility: 'exact',
    agents: agentEntries(versions),
    prompts: {},
    models: modelEntries(versions, provider),
    apiTools,
    mcpActions,
    policy: { version: '1' },
    adapters: { agent: '1', api: '1', mcp: '1' },
    outputContracts: { task: canonicalJsonHash('text') },
    artifactTemplates: {},
    runtime: { version: RUNTIME_VERSION, stateSchemaVersion: 1 },
  };
}

export async function buildWorkflowManifest(
  input: {
    workspaceId: string;
    workflowVersionId: string;
    definition: WorkflowDefinition;
  },
  client: Queryable = db,
): Promise<ExecutionManifest> {
  const workflowVersion = (await client.query<{
    id: string;
    workflow_id: string;
    version: number;
    definition: WorkflowDefinition;
  }>(
    `SELECT id,workflow_id,version,definition FROM workflow_versions
      WHERE id=$1 AND workspace_id=$2`,
    [input.workflowVersionId, input.workspaceId],
  )).rows[0];
  if (!workflowVersion) throw manifestError('WORKFLOW_VERSION_REQUIRED');
  if (canonicalJsonHash(workflowVersion.definition) !== canonicalJsonHash(input.definition)) {
    throw manifestError('WORKFLOW_VERSION_DEFINITION_MISMATCH');
  }

  const agentIds = input.definition.nodes
    .filter((node) => node.type === 'agent' || node.type === 'mcp_action')
    .map((node) => node.config.agentId)
    .filter((id): id is string => typeof id === 'string');
  const versions = await publishedAgentVersions(client, input.workspaceId, agentIds);
  const explicitToolIds = input.definition.nodes
    .filter((node) => node.type === 'action' || node.type === 'api_action')
    .map((node) => node.config.toolId)
    .filter((id): id is string => typeof id === 'string');
  const agentToolIds = [...versions.values()].flatMap((version) => version.snapshot.apiToolIds);
  const requiredMcpToolIds = input.definition.nodes
    .filter((node) => node.type === 'mcp_action')
    .map((node) => node.config.mcpToolId)
    .filter((id): id is string => typeof id === 'string');
  const promptVersionIds = input.definition.nodes
    .map((node) => node.config.promptVersionId)
    .filter((id): id is string => typeof id === 'string');
  const artifactTemplateIds = input.definition.nodes
    .map((node) => node.config.artifactTemplateId)
    .filter((id): id is string => typeof id === 'string');
  const [apiTools, mcpActions, prompts, artifactTemplates, provider] = await Promise.all([
    apiToolManifest(client, input.workspaceId, [...explicitToolIds, ...agentToolIds]),
    mcpActionManifest(client, input.workspaceId, agentIds, requiredMcpToolIds),
    promptManifest(client, input.workspaceId, promptVersionIds),
    artifactTemplateManifest(client, input.workspaceId, artifactTemplateIds),
    modelProvider(client, input.workspaceId),
  ]);
  const adapters = Object.fromEntries(input.definition.nodes.map((node) => [
    node.id,
    `${workflowNodeDefinition(node.type)?.adapter ?? 'unavailable'}:1`,
  ]));
  const outputContracts = Object.fromEntries(input.definition.nodes
    .filter((node) => node.type === 'agent' || node.type === 'output')
    .map((node) => [node.id, canonicalJsonHash(
      node.type === 'agent'
        ? String(node.config.outputContract ?? 'text')
        : { artifactFormats: node.config.artifactFormats ?? [], fromNodeId: node.config.fromNodeId ?? null },
    )]));

  return {
    manifestVersion: 1,
    createdAt: new Date().toISOString(),
    compatibility: 'exact',
    workflow: {
      id: workflowVersion.workflow_id,
      versionId: workflowVersion.id,
      version: workflowVersion.version,
      definitionHash: canonicalJsonHash(workflowVersion.definition),
    },
    agents: agentEntries(versions),
    prompts,
    models: modelEntries(versions, provider),
    apiTools,
    mcpActions,
    policy: { version: '1' },
    adapters,
    outputContracts,
    artifactTemplates,
    runtime: { version: RUNTIME_VERSION, stateSchemaVersion: 1 },
  };
}

export function assertManifestCompatible(manifest: unknown) {
  const compatibility = validateManifestCompatibility(manifest);
  if (!compatibility.ok) {
    throw manifestError('RUN_MANIFEST_INCOMPATIBLE', { reasons: compatibility.reasons });
  }
  return manifest as ExecutionManifest;
}
