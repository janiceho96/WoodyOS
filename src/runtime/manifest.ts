import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { z } from 'zod';
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

export type WorkflowDependencySnapshot = Pick<
  ExecutionManifest,
  'agents' | 'prompts' | 'models' | 'apiTools' | 'mcpActions' | 'policy' | 'adapters' | 'outputContracts' | 'artifactTemplates' | 'runtime'
>;

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

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
  risk_level: string;
  connection_permission: string;
  tool_permission: string;
};

const sensitiveKey = /token|password|secret|authorization|(^|[-_])auth($|[-_])|api[-_]?key|cookie|credential|private[-_]?key|session|encrypted/i;
const RUNTIME_VERSION = process.env.RUNTIME_VERSION ?? '0.1.0';
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const uuidRecord = <T extends z.ZodTypeAny>(entry: T) => z.record(z.string().uuid(), entry);
const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const exactManifestSchema = z.object({
  manifestVersion: z.literal(1),
  createdAt: z.string().datetime(),
  compatibility: z.literal('exact'),
  workflow: z.object({
    id: z.string().uuid(),
    versionId: z.string().uuid(),
    version: z.number().int().positive(),
    definitionHash: sha256Schema,
  }).strict().optional(),
  agents: uuidRecord(z.object({
    versionId: z.string().uuid(),
    version: z.number().int().positive(),
    snapshotHash: sha256Schema,
  }).strict()),
  prompts: uuidRecord(z.object({
    versionId: z.string().uuid(),
    contentHash: sha256Schema,
  }).strict()),
  models: uuidRecord(z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    parametersHash: sha256Schema,
  }).strict()),
  apiTools: uuidRecord(z.object({
    toolId: z.string().uuid(),
    schemaHash: sha256Schema,
    permissionHash: sha256Schema,
  }).strict()),
  mcpActions: uuidRecord(z.object({
    connectionId: z.string().uuid(),
    toolId: z.string().uuid(),
    schemaHash: sha256Schema,
    permissionHash: sha256Schema,
  }).strict()),
  policy: z.object({ version: z.string().min(1) }).strict(),
  adapters: z.record(z.string().min(1), z.string().min(1)),
  outputContracts: z.record(z.string().min(1), sha256Schema),
  artifactTemplates: uuidRecord(sha256Schema),
  runtime: z.object({
    version: z.string().min(1),
    stateSchemaVersion: z.literal(1),
  }).strict(),
}).strict();

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

export function validateManifestCompatibility(manifest: unknown): { ok: boolean; reasons: string[] } {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, reasons: ['Execution manifest is missing'] };
  }
  const value = manifest as Record<string, unknown>;
  const reasons: string[] = [];
  if (value.manifestVersion !== 1) reasons.push(`Unsupported manifest version ${String(value.manifestVersion)}`);
  if (value.compatibility === 'legacy_partial') reasons.push('Execution manifest is a legacy partial snapshot');
  else if (value.compatibility !== 'exact') reasons.push('Execution manifest compatibility is invalid');
  const runtime = value.runtime && typeof value.runtime === 'object' && !Array.isArray(value.runtime)
    ? value.runtime as Record<string, unknown>
    : null;
  if (value.compatibility === 'exact' && runtime && runtime.stateSchemaVersion !== 1) {
    reasons.push(`Unsupported runtime state schema ${String(runtime.stateSchemaVersion)}`);
  }
  const containsSensitiveField = forbiddenSensitiveField(value);
  if (containsSensitiveField) reasons.push('Execution manifest contains forbidden sensitive fields');
  if (value.compatibility === 'exact' && reasons.length === 0 && !exactManifestSchema.safeParse(value).success) {
    reasons.push('Execution manifest is malformed');
  }
  return { ok: reasons.length === 0, reasons };
}

async function publishedAgentVersions(
  client: Queryable,
  workspaceId: string,
  agentIds: string[],
) {
  const uniqueIds = uniqueSorted(agentIds);
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
  const uniqueIds = uniqueSorted(toolIds);
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
      permissionHash: canonicalJsonHash({ kind: tool.kind, permissions: [...tool.permissions].sort() }),
    }];
  }));
}

async function mcpActionManifest(
  client: Queryable,
  workspaceId: string,
  agentIds: string[],
  requiredToolIds: string[] = [],
) {
  const uniqueAgentIds = uniqueSorted(agentIds);
  if (!uniqueAgentIds.length) {
    if (requiredToolIds.length) throw manifestError('MCP_ACTION_UNAVAILABLE', { toolIds: requiredToolIds });
    return {};
  }
  const result = await client.query<McpManifestRow>(
    `SELECT tool.id,connection_access.agent_id,connection.id connection_id,tool.remote_name,
            tool.input_schema,connection.transport,connection.endpoint_url,tool.risk_level,
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
  const missing = uniqueSorted(requiredToolIds).filter((id) => !byId.has(id));
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
        riskLevel: row.risk_level,
      }),
      permissionHash: canonicalJsonHash(rows
        .map((permission) => ({
          agentId: permission.agent_id,
          connection: permission.connection_permission,
          tool: permission.tool_permission,
        }))
        .sort((left, right) => left.agentId.localeCompare(right.agentId)
          || left.connection.localeCompare(right.connection)
          || left.tool.localeCompare(right.tool))),
    }];
  }));
}

async function promptManifest(client: Queryable, workspaceId: string, versionIds: string[]) {
  const uniqueIds = uniqueSorted(versionIds);
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
  const uniqueIds = uniqueSorted(templateIds);
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
  return Object.fromEntries([...versions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([agentId, row]) => [agentId, {
    versionId: row.id,
    version: row.version,
    snapshotHash: canonicalJsonHash(row.snapshot),
  }]));
}

type ModelProviderDescriptor = {
  provider: string;
  baseUrl: string | null;
  defaultModel: string;
};

function modelEntries(versions: Map<string, AgentVersionRow>, provider: ModelProviderDescriptor) {
  return Object.fromEntries([...versions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([agentId, row]) => [agentId, {
    provider: provider.provider,
    model: row.snapshot.model,
    parametersHash: canonicalJsonHash({
      modelConfig: row.snapshot.modelConfig,
      providerConfig: {
        baseUrl: provider.baseUrl,
        defaultModel: provider.defaultModel,
      },
    }),
  }]));
}

async function modelProvider(client: Queryable, workspaceId: string) {
  const configured = (await client.query<{
    provider: string;
    base_url: string | null;
    default_model: string;
  }>(
    'SELECT provider,base_url,default_model FROM workspace_ai_provider_configs WHERE workspace_id=$1',
    [workspaceId],
  )).rows[0];
  if (configured) return {
    provider: configured.provider,
    baseUrl: configured.base_url,
    defaultModel: configured.default_model,
  };
  const baseUrl = (process.env.LLM_BASE_URL ?? '')
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/$/, '');
  return {
    provider: process.env.LLM_PROVIDER ?? 'anthropic',
    baseUrl: baseUrl || null,
    defaultModel: process.env.LLM_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514',
  };
}

async function workflowDependencySnapshotForVersions(
  input: { workspaceId: string; definition: WorkflowDefinition },
  versions: Map<string, AgentVersionRow>,
  client: Queryable,
): Promise<WorkflowDependencySnapshot> {
  const agentIds = workflowAgentIds(input.definition);
  const [apiTools, mcpActions, prompts, artifactTemplates, provider] = await Promise.all([
    apiToolManifest(client, input.workspaceId, workflowApiToolIds(input.definition, versions)),
    mcpActionManifest(client, input.workspaceId, agentIds, workflowMcpToolIds(input.definition)),
    promptManifest(client, input.workspaceId, workflowPromptVersionIds(input.definition)),
    artifactTemplateManifest(client, input.workspaceId, workflowArtifactTemplateIds(input.definition)),
    modelProvider(client, input.workspaceId),
  ]);
  return {
    agents: agentEntries(versions),
    prompts,
    models: modelEntries(versions, provider),
    apiTools,
    mcpActions,
    policy: { version: '1' },
    adapters: workflowAdapters(input.definition),
    outputContracts: workflowOutputContracts(input.definition),
    artifactTemplates,
    runtime: { version: RUNTIME_VERSION, stateSchemaVersion: 1 },
  };
}

export async function buildWorkflowDependencySnapshot(
  input: { workspaceId: string; definition: WorkflowDefinition },
  client: Queryable = db,
): Promise<WorkflowDependencySnapshot> {
  const versions = await publishedAgentVersions(client, input.workspaceId, workflowAgentIds(input.definition));
  return workflowDependencySnapshotForVersions(input, versions, client);
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

  const dependencies = await buildWorkflowDependencySnapshot({
    workspaceId: input.workspaceId,
    definition: input.definition,
  }, client);

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
    ...dependencies,
  };
}

export function assertManifestCompatible(manifest: unknown) {
  const compatibility = validateManifestCompatibility(manifest);
  if (!compatibility.ok) {
    throw manifestError('RUN_MANIFEST_INCOMPATIBLE', { reasons: compatibility.reasons });
  }
  return manifest as ExecutionManifest;
}

export function assertManifestDependenciesMatch(stored: unknown, current: unknown) {
  const storedManifest = assertManifestCompatible(stored);
  const currentManifest = assertManifestCompatible(current);
  const { createdAt: _storedCreatedAt, ...storedDependencies } = storedManifest;
  const { createdAt: _currentCreatedAt, ...currentDependencies } = currentManifest;
  if (canonicalJsonHash(storedDependencies) !== canonicalJsonHash(currentDependencies)) {
    throw manifestError('RUN_MANIFEST_INCOMPATIBLE', {
      reasons: ['Execution dependencies changed after the run was created'],
    });
  }
}

function sameIds(actual: string[], expected: string[]) {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function fixedAgentVersions(
  client: Queryable,
  workspaceId: string,
  manifest: ExecutionManifest,
  expectedAgentIds: string[],
) {
  const manifestAgentIds = Object.keys(manifest.agents);
  if (!sameIds(manifestAgentIds, expectedAgentIds) || !sameIds(Object.keys(manifest.models), expectedAgentIds)) {
    throw manifestError('RUN_MANIFEST_INCOMPATIBLE', {
      reasons: ['Execution manifest agent or model bindings do not match the executable definition'],
    });
  }
  if (!expectedAgentIds.length) return new Map<string, AgentVersionRow>();
  const versionIds = expectedAgentIds.map((agentId) => manifest.agents[agentId].versionId);
  const rows = await client.query<AgentVersionRow>(
    `SELECT id,agent_id,version,snapshot FROM agent_versions
      WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,
    [workspaceId, versionIds],
  );
  const byAgentId = new Map(rows.rows.map((row) => [row.agent_id, row]));
  for (const agentId of expectedAgentIds) {
    const stored = manifest.agents[agentId];
    const current = byAgentId.get(agentId);
    if (!current
      || current.id !== stored.versionId
      || current.version !== stored.version
      || canonicalJsonHash(current.snapshot) !== stored.snapshotHash) {
      throw manifestError('RUN_MANIFEST_INCOMPATIBLE', {
        reasons: [`Published agent dependency ${agentId} changed or is unavailable`],
      });
    }
  }
  return byAgentId;
}

function workflowAgentIds(definition: WorkflowDefinition) {
  return uniqueSorted(definition.nodes
    .filter((node) => node.type === 'agent' || node.type === 'mcp_action')
    .map((node) => node.config.agentId)
    .filter((id): id is string => typeof id === 'string'));
}

function workflowApiToolIds(definition: WorkflowDefinition, versions: Map<string, AgentVersionRow>) {
  return [
    ...definition.nodes
      .filter((node) => node.type === 'action' || node.type === 'api_action')
      .map((node) => node.config.toolId)
      .filter((id): id is string => typeof id === 'string'),
    ...[...versions.values()].flatMap((version) => version.snapshot.apiToolIds),
  ];
}

function workflowMcpToolIds(definition: WorkflowDefinition) {
  return uniqueSorted(definition.nodes
    .filter((node) => node.type === 'mcp_action')
    .map((node) => node.config.mcpToolId)
    .filter((id): id is string => typeof id === 'string'));
}

function workflowPromptVersionIds(definition: WorkflowDefinition) {
  return uniqueSorted(definition.nodes
    .map((node) => node.config.promptVersionId)
    .filter((id): id is string => typeof id === 'string'));
}

function workflowArtifactTemplateIds(definition: WorkflowDefinition) {
  return uniqueSorted(definition.nodes
    .map((node) => node.config.artifactTemplateId)
    .filter((id): id is string => typeof id === 'string'));
}

function workflowAdapters(definition: WorkflowDefinition) {
  return Object.fromEntries(definition.nodes.map((node) => [
    node.id,
    `${workflowNodeDefinition(node.type)?.adapter ?? 'unavailable'}:1`,
  ]));
}

function workflowOutputContracts(definition: WorkflowDefinition) {
  return Object.fromEntries(definition.nodes
    .filter((node) => node.type === 'agent' || node.type === 'output')
    .map((node) => [node.id, canonicalJsonHash(
      node.type === 'agent'
        ? String(node.config.outputContract ?? 'text')
        : { artifactFormats: Array.isArray(node.config.artifactFormats) ? [...new Set(node.config.artifactFormats)].sort() : [], fromNodeId: node.config.fromNodeId ?? null },
    )]));
}

function asManifestIncompatible(error: unknown): never {
  if ((error as { code?: unknown })?.code === 'RUN_MANIFEST_INCOMPATIBLE') throw error;
  throw manifestError('RUN_MANIFEST_INCOMPATIBLE', {
    reasons: [error instanceof Error ? error.message : 'Execution dependency validation failed'],
  });
}

export async function assertTaskManifestDependencies(
  input: { workspaceId: string; agentId: string; manifest: unknown },
  client: Queryable = db,
) {
  const manifest = assertManifestCompatible(input.manifest);
  if (manifest.workflow || !sameIds(Object.keys(manifest.agents), [input.agentId])) {
    throw manifestError('RUN_MANIFEST_INCOMPATIBLE', {
      reasons: ['Standalone task manifest semantics are invalid'],
    });
  }
  try {
    const versions = await fixedAgentVersions(client, input.workspaceId, manifest, [input.agentId]);
    const version = versions.get(input.agentId)!;
    const [apiTools, mcpActions, provider] = await Promise.all([
      apiToolManifest(client, input.workspaceId, version.snapshot.apiToolIds),
      mcpActionManifest(client, input.workspaceId, [input.agentId]),
      modelProvider(client, input.workspaceId),
    ]);
    const current: ExecutionManifest = {
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
    assertManifestDependenciesMatch(manifest, current);
  } catch (error) {
    asManifestIncompatible(error);
  }
}

export async function assertWorkflowManifestDependencies(
  input: {
    workspaceId: string;
    workflowVersionId: string;
    definition: WorkflowDefinition;
    manifest: unknown;
  },
  client: Queryable = db,
) {
  const manifest = assertManifestCompatible(input.manifest);
  if (!manifest.workflow || manifest.workflow.versionId !== input.workflowVersionId) {
    throw manifestError('RUN_MANIFEST_INCOMPATIBLE', {
      reasons: ['Workflow manifest semantics are invalid'],
    });
  }
  try {
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
    if (!workflowVersion
      || workflowVersion.workflow_id !== manifest.workflow.id
      || workflowVersion.version !== manifest.workflow.version
      || canonicalJsonHash(workflowVersion.definition) !== manifest.workflow.definitionHash
      || canonicalJsonHash(workflowVersion.definition) !== canonicalJsonHash(input.definition)) {
      throw manifestError('RUN_MANIFEST_INCOMPATIBLE', {
        reasons: ['Published workflow dependency changed or is unavailable'],
      });
    }
    const agentIds = workflowAgentIds(input.definition);
    const versions = await fixedAgentVersions(client, input.workspaceId, manifest, agentIds);
    const dependencies = await workflowDependencySnapshotForVersions({
      workspaceId: input.workspaceId,
      definition: input.definition,
    }, versions, client);
    const current: ExecutionManifest = {
      manifestVersion: 1,
      createdAt: new Date().toISOString(),
      compatibility: 'exact',
      workflow: {
        id: workflowVersion.workflow_id,
        versionId: workflowVersion.id,
        version: workflowVersion.version,
        definitionHash: canonicalJsonHash(workflowVersion.definition),
      },
      ...dependencies,
    };
    assertManifestDependenciesMatch(manifest, current);
  } catch (error) {
    asManifestIncompatible(error);
  }
}

export async function assertWorkflowRunManifestDependencies(
  run: {
    workspace_id: string;
    workflow_version_id?: string | null;
    definition_snapshot: WorkflowDefinition;
    execution_manifest?: unknown;
    run_mode?: 'test' | 'production';
  },
  client: Queryable = db,
) {
  if (run.run_mode === 'test') return;
  if (!run.workflow_version_id) {
    throw manifestError('RUN_MANIFEST_INCOMPATIBLE', {
      reasons: ['Workflow run has no immutable workflow version'],
    });
  }
  await assertWorkflowManifestDependencies({
    workspaceId: run.workspace_id,
    workflowVersionId: run.workflow_version_id,
    definition: run.definition_snapshot,
    manifest: run.execution_manifest,
  }, client);
}
