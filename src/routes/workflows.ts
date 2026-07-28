import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { enqueueTask, enqueueWorkflowRun } from '../queue/task-queue.js';
import { assertWorkspaceAiBudgetAvailable } from '../lib/ai-usage.js';
import { workflowDefinitionErrors, workflowDefinitionSchema, type WorkflowDefinition } from '../workflows/definition.js';
import { requestWorkflowArtifacts } from '../artifacts/service.js';
import { artifactFormatSchema } from '../artifacts/types.js';
import { retryPolicy } from '../workflows/definition.js';
import { toolRequiresApproval, type ToolRecord } from '../tools/runtime.js';
import { workflowLayoutErrors, workflowLayoutInputSchema } from '../workflows/layout.js';
import {
  buildWorkflowManifest,
  validateManifestCompatibility,
  type ExecutionManifest,
} from '../runtime/manifest.js';
import { authoritativeTraceContext, childTraceContext, createTraceContext } from '../runtime/trace.js';
import {
  redactRuntimeMessage,
  redactRuntimeValue,
  serializeRuntimeError,
} from '../runtime/errors.js';
import { requestCancellation } from '../runtime/cancellation.js';
import { dryRunWorkflow, type DryRunResources } from '../workflows/dry-run.js';
import { decryptJson } from '../lib/crypto.js';
import { canonicalJsonHash } from '../runtime/manifest.js';
import type { StoredConfig } from '../tools/runtime.js';

const workflowInput = z.object({ name: z.string().min(2).max(120), description: z.string().max(2000).default(''), definition: workflowDefinitionSchema, enabled: z.boolean().default(false) });
const runInputSchema = z.object({ input: z.record(z.unknown()).default({}) });

type WorkflowRecord = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  definition: WorkflowDefinition;
  enabled: boolean;
  status: 'draft' | 'published' | 'paused' | 'archived';
  draft_revision: number;
  published_version_id: string | null;
};

async function dryRunResources(workspaceId: string, definition: WorkflowDefinition): Promise<DryRunResources> {
  const agentIds = [...new Set(definition.nodes.filter((node) => ['agent', 'mcp_action'].includes(node.type)).map((node) => node.config.agentId).filter((id): id is string => typeof id === 'string'))];
  const toolIds = [...new Set(definition.nodes.filter((node) => ['action', 'api_action'].includes(node.type)).map((node) => node.config.toolId).filter((id): id is string => typeof id === 'string'))];
  const mcpIds = [...new Set(definition.nodes.filter((node) => node.type === 'mcp_action').map((node) => node.config.mcpToolId).filter((id): id is string => typeof id === 'string'))];
  const [agents, tools, mcpTools] = await Promise.all([
    agentIds.length ? query<{ id: string; version_id: string | null; version: number | null }>(
      `SELECT a.id,v.id version_id,v.version FROM agents a
       LEFT JOIN agent_versions v ON v.id=a.published_version_id AND v.workspace_id=a.workspace_id
       WHERE a.workspace_id=$1 AND a.status='active' AND a.id=ANY($2::uuid[])`, [workspaceId, agentIds]) : Promise.resolve({ rows: [] }),
    toolIds.length ? query<{ id: string; kind: string; permissions: string[]; config: StoredConfig }>(
      "SELECT id,kind,permissions,config FROM tools WHERE workspace_id=$1 AND enabled=true AND kind <> 'mcp' AND id=ANY($2::uuid[])", [workspaceId, toolIds]) : Promise.resolve({ rows: [] }),
    mcpIds.length ? query<{ id: string; connection_id: string; risk_level: string; agent_id: string; input_schema: unknown; connection_permission: string; tool_permission: string }>(
      `SELECT t.id,t.connection_id,t.risk_level,t.input_schema,access.agent_id,access.permission_level connection_permission,tool_access.permission_level tool_permission FROM mcp_connection_tools t
       JOIN mcp_connections c ON c.id=t.connection_id
       JOIN mcp_agent_access access ON access.connection_id=c.id AND access.enabled=true
       JOIN mcp_agent_tool_access tool_access ON tool_access.mcp_tool_id=t.id AND tool_access.agent_id=access.agent_id AND tool_access.enabled=true
       JOIN agents a ON a.id=access.agent_id AND a.workspace_id=c.workspace_id AND a.status='active'
       WHERE c.workspace_id=$1 AND c.deleted_at IS NULL AND c.enabled=true AND c.health_status='healthy'
         AND t.enabled=true AND t.id=ANY($2::uuid[])`, [workspaceId, mcpIds]) : Promise.resolve({ rows: [] }),
  ]);
  const mcpById = new Map<string, { id: string; kind: string; risk: string; permissions: string[]; connectionId: string; agentIds: string[]; schema: unknown; schemaHash: string; permissionHash: string }>();
  for (const row of mcpTools.rows) {
    const current = mcpById.get(row.id);
    if (current) current.agentIds.push(row.agent_id);
    else mcpById.set(row.id, { id: row.id, kind: 'mcp', risk: row.risk_level, permissions: [row.connection_permission, row.tool_permission], connectionId: row.connection_id, agentIds: [row.agent_id], schema: row.input_schema, schemaHash: canonicalJsonHash(row.input_schema), permissionHash: canonicalJsonHash({ connection: row.connection_permission, tool: row.tool_permission }) });
  }
  return {
    agents: new Map(agents.rows.map((row) => [row.id, { id: row.id, versionId: row.version_id, version: row.version }])),
    tools: new Map(tools.rows.map((row) => { const config = decryptJson(row.config) as Record<string, unknown>; const schema = config.inputSchema ?? { type: 'object', properties: {} }; const risk = config.readOnly === true ? 'read' : 'unknown'; return [row.id, { id: row.id, kind: row.kind, risk, permissions: row.permissions ?? [], schema, schemaHash: canonicalJsonHash(schema), permissionHash: canonicalJsonHash({ kind: row.kind, permissions: row.permissions ?? [], risk }) }]; })),
    mcpTools: mcpById,
  };
}

function publicWorkflowError(value: unknown) {
  return value == null ? null : serializeRuntimeError(value);
}

function publicWorkflowEvent(row: Record<string, unknown>) {
  return {
    ...row,
    message: redactRuntimeMessage(String(row.message ?? '')),
    payload: redactRuntimeValue(row.payload ?? {}),
  };
}

function publicWorkflowAuthorization(row: Record<string, unknown>) {
  const error = publicWorkflowError(row.runtime_error ?? row.error_message);
  return { ...row, error_message: error?.message ?? null, runtime_error: error };
}

function publicWorkflowOutput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('error' in value)) return value;
  const output = value as Record<string, unknown>;
  return { ...output, error: publicWorkflowError(output.error) };
}

export { workflowDefinitionErrors } from '../workflows/definition.js';

async function validateAgentNodes(workspaceId: string, definition: WorkflowDefinition) {
  const agentIds = definition.nodes
    .filter((item) => item.type === 'agent')
    .map((item) => item.config?.agentId)
    .filter((id): id is string => typeof id === 'string');
  const agentNodes = definition.nodes.filter((item) => item.type === 'agent');
  if (agentIds.length !== agentNodes.length || !agentIds.every((id) => z.string().uuid().safeParse(id).success)) return false;
  if (!agentIds.length) return true;
  const result = await query<{ id: string }>('SELECT id FROM agents WHERE workspace_id=$1 AND status=$2 AND id = ANY($3::uuid[])', [workspaceId, 'active', agentIds]);
  return new Set(result.rows.map((row) => row.id)).size === new Set(agentIds).size;
}

async function validateActionNodes(workspaceId: string, definition: WorkflowDefinition) {
  const toolIds = definition.nodes
    .filter((item) => item.type === 'action')
    .map((item) => item.config?.toolId)
    .filter((id): id is string => typeof id === 'string');
  const actionNodes = definition.nodes.filter((item) => item.type === 'action');
  if (toolIds.length !== actionNodes.length || !toolIds.every((id) => z.string().uuid().safeParse(id).success)) return { valid: false, errors: [] as string[] };
  if (!toolIds.length) return { valid: true, errors: [] as string[] };
  const result = await query<ToolRecord>('SELECT id,name,kind,config,permissions FROM tools WHERE workspace_id=$1 AND enabled=true AND id = ANY($2::uuid[])', [workspaceId, toolIds]);
  if (new Set(result.rows.map((row) => row.id)).size !== new Set(toolIds).size) return { valid: false, errors: [] as string[] };
  const toolById = new Map(result.rows.map((tool) => [tool.id, tool]));
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const errors: string[] = [];
  for (const node of actionNodes) {
    const tool = toolById.get(String(node.config.toolId));
    if (!tool || !toolRequiresApproval(tool)) continue;
    const predecessors = definition.edges.filter((edge) => edge.target === node.id).map((edge) => nodeById.get(edge.source));
    if (!predecessors.length || predecessors.some((predecessor) => predecessor?.type !== 'approval')) errors.push(`Write-capable action ${node.id} must be directly preceded by an approval node`);
    if (retryPolicy(node).maxAttempts > 1) errors.push(`Write-capable action ${node.id} cannot use automatic retries`);
  }
  return { valid: true, errors };
}

async function validateApiActionNodes(workspaceId: string, definition: WorkflowDefinition) {
  const nodes = definition.nodes.filter((item) => item.type === 'api_action');
  const toolIds = nodes.map((item) => item.config.toolId).filter((id): id is string => typeof id === 'string');
  if (toolIds.length !== nodes.length || !toolIds.every((id) => z.string().uuid().safeParse(id).success)) return false;
  if (!toolIds.length) return true;
  const result = await query<{ id: string }>(
    "SELECT id FROM tools WHERE workspace_id=$1 AND enabled=true AND kind <> 'mcp' AND id=ANY($2::uuid[])",
    [workspaceId, toolIds],
  );
  return new Set(result.rows.map((row) => row.id)).size === new Set(toolIds).size;
}

async function validateMcpActionNodes(workspaceId: string, definition: WorkflowDefinition) {
  const nodes = definition.nodes.filter((item) => item.type === 'mcp_action');
  const pairs = nodes.map((node) => ({ agentId: node.config.agentId, toolId: node.config.mcpToolId }));
  if (pairs.some((pair) => typeof pair.agentId !== 'string' || typeof pair.toolId !== 'string'
    || !z.string().uuid().safeParse(pair.agentId).success || !z.string().uuid().safeParse(pair.toolId).success)) return false;
  if (!pairs.length) return true;
  const agentIds = [...new Set(pairs.map((pair) => pair.agentId as string))];
  const toolIds = [...new Set(pairs.map((pair) => pair.toolId as string))];
  const result = await query<{ agent_id: string; tool_id: string }>(
    `SELECT access.agent_id,t.id tool_id
     FROM mcp_connection_tools t
     JOIN mcp_connections c ON c.id=t.connection_id
     JOIN mcp_agent_access access ON access.connection_id=c.id AND access.enabled=true
     JOIN mcp_agent_tool_access tool_access ON tool_access.mcp_tool_id=t.id
       AND tool_access.agent_id=access.agent_id AND tool_access.enabled=true
     JOIN agents a ON a.id=access.agent_id AND a.workspace_id=c.workspace_id AND a.status='active'
     WHERE c.workspace_id=$1 AND c.deleted_at IS NULL AND c.enabled=true AND c.health_status='healthy'
       AND t.enabled=true AND access.agent_id=ANY($2::uuid[]) AND t.id=ANY($3::uuid[])`,
    [workspaceId, agentIds, toolIds],
  );
  const allowed = new Set(result.rows.map((row) => `${row.agent_id}:${row.tool_id}`));
  return pairs.every((pair) => allowed.has(`${pair.agentId}:${pair.toolId}`));
}

async function definitionResourceError(workspaceId: string, definition: WorkflowDefinition) {
  const definitionErrors = workflowDefinitionErrors(definition);
  if (definitionErrors.length) return { status: 400, body: { error: 'INVALID_WORKFLOW_DEFINITION', details: definitionErrors } };
  if (!(await validateAgentNodes(workspaceId, definition))) return { status: 400, body: { error: 'INVALID_OR_INACTIVE_AGENT_NODE' } };
  const actionValidation = await validateActionNodes(workspaceId, definition);
  if (!actionValidation.valid) return { status: 400, body: { error: 'INVALID_OR_DISABLED_TOOL_NODE' } };
  if (actionValidation.errors.length) return { status: 400, body: { error: 'UNSAFE_ACTION_NODE', details: actionValidation.errors } };
  if (!(await validateApiActionNodes(workspaceId, definition))) return { status: 400, body: { error: 'INVALID_OR_DISABLED_API_ACTION_NODE' } };
  if (!(await validateMcpActionNodes(workspaceId, definition))) return { status: 400, body: { error: 'INVALID_OR_UNAUTHORIZED_MCP_ACTION_NODE' } };
  return null;
}

async function createQueuedRun(input: {
  workspaceId: string;
  userId: string;
  workflow: Pick<WorkflowRecord, 'id' | 'name' | 'draft_revision'>;
  definition: WorkflowDefinition;
  runInput: Record<string, unknown>;
  mode: 'test' | 'production';
  workflowVersionId?: string | null;
  testTargetNodeId?: string | null;
}) {
  await assertWorkspaceAiBudgetAvailable(input.workspaceId);
  const trigger = input.definition.nodes.find((node) => node.type === 'trigger');
  if (!trigger) return { error: 'WORKFLOW_TRIGGER_MISSING' as const };
  const initialState = {
    ...input.runInput,
    input: input.runInput,
    nodes: {},
    variables: {},
    __runtime: { agentExecutionIdentitySchemaVersion: 1 },
  };
  const cursor = { nodeId: trigger.id, loops: {}, attempt: 1 };
  const trace = createTraceContext();
  const client = await db.connect();
  let run: { rows: Array<{ id: string; [key: string]: unknown }> };
  try {
    await client.query('BEGIN');
    const manifest = input.mode === 'production'
      ? await buildWorkflowManifest({
        workspaceId: input.workspaceId,
        workflowVersionId: input.workflowVersionId ?? '',
        definition: input.definition,
      }, client)
      : null;
    run = await client.query<{ id: string; [key: string]: unknown }>(
      `INSERT INTO workflow_runs(
         workspace_id,workflow_id,input,definition_snapshot,state,cursor,workflow_version_id,run_mode,
         draft_revision,test_target_node_id,manifest_version,execution_manifest,
         trace_id,span_id,parent_span_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        input.workspaceId, input.workflow.id, JSON.stringify(input.runInput), JSON.stringify(input.definition),
        JSON.stringify(initialState), JSON.stringify(cursor), input.workflowVersionId ?? null, input.mode,
        input.mode === 'test' ? input.workflow.draft_revision : null, input.testTargetNodeId ?? null,
        manifest?.manifestVersion ?? 1, manifest ? JSON.stringify(manifest) : null,
        trace.traceId, trace.spanId, trace.parentSpanId,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const formats = input.testTargetNodeId ? [] : [...new Set(input.definition.nodes
    .filter((node) => node.type === 'output' && Array.isArray(node.config.artifactFormats))
    .flatMap((node) => (node.config.artifactFormats as unknown[]).map((item) => artifactFormatSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data)))];
  if (formats.length) await requestWorkflowArtifacts({ workspaceId: input.workspaceId, createdBy: input.userId, workflowRunId: run.rows[0].id, title: input.workflow.name, formats, ready: false });
  try {
    await enqueueWorkflowRun(run.rows[0].id, run.rows[0].id, 0, String(run.rows[0].trace_id));
  } catch (queueError) {
    const error = serializeRuntimeError(queueError);
    await query(
      "UPDATE workflow_runs SET status='failed',output=$1,error=$2,completed_at=now(),updated_at=now() WHERE id=$3",
      [JSON.stringify({ error }), JSON.stringify(error), run.rows[0].id],
    );
    await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.rows[0].id]);
    throw queueError;
  }
  return { run: run.rows[0] };
}

const workflowListSql = `SELECT w.*,
  pv.version published_version,
  latest_test.status latest_test_status,
  latest_test.draft_revision latest_test_revision,
  latest_test.id latest_test_run_id
 FROM workflows w
 LEFT JOIN workflow_versions pv ON pv.id=w.published_version_id
 LEFT JOIN LATERAL (
   SELECT id,status,draft_revision FROM workflow_runs
   WHERE workflow_id=w.id AND run_mode='test' AND test_target_node_id IS NULL ORDER BY created_at DESC LIMIT 1
 ) latest_test ON true`;

export async function workflowRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => ({ data: (await query(`${workflowListSql} WHERE w.workspace_id=$1 AND w.status <> 'archived' ORDER BY w.updated_at DESC`, [request.user.workspaceId])).rows })));
  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(workflowInput, request.body, reply); if (!input) return;
    const definition = input.definition as WorkflowDefinition;
    const validationError = await definitionResourceError(request.user.workspaceId, definition);
    if (validationError) return reply.code(validationError.status).send(validationError.body);
    if (input.enabled) return reply.code(400).send({ error: 'WORKFLOW_PUBLISH_REQUIRED', message: 'Save the workflow as a draft, test it, then publish it.' });
    const result = await query(
      `INSERT INTO workflows(workspace_id,name,description,definition,enabled,status,created_by)
       VALUES($1,$2,$3,$4,false,'draft',$5) RETURNING *`,
      [request.user.workspaceId, input.name, input.description, JSON.stringify(definition), request.user.sub],
    );
    await audit(request.user.workspaceId, request.user.sub, 'workflow.created', 'workflow', result.rows[0].id);
    return reply.code(201).send(result.rows[0]);
  }));
  app.get('/:id/layout', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const workflowId = (request.params as { id: string }).id;
    const result = await query<{
      id: string;
      schema_version: number | null;
      positions: unknown[] | null;
      viewport: Record<string, unknown> | null;
      updated_at: string | null;
    }>(
      `SELECT w.id,l.schema_version,l.positions,l.viewport,l.updated_at
       FROM workflows w LEFT JOIN LATERAL (
         SELECT schema_version,positions,viewport,updated_at FROM workflow_editor_layouts
         WHERE workflow_id=w.id ORDER BY schema_version DESC LIMIT 1
       ) l ON true
       WHERE w.id=$1 AND w.workspace_id=$2`,
      [workflowId, request.user.workspaceId],
    );
    if (!result.rowCount) return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
    const layout = result.rows[0];
    return {
      workflowId,
      schemaVersion: layout.schema_version ?? 1,
      positions: layout.positions ?? [],
      viewport: layout.viewport ?? { x: 0, y: 0, zoom: 1 },
      updatedAt: layout.updated_at,
    };
  }));
  app.put('/:id/layout', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(workflowLayoutInputSchema, request.body, reply); if (!input) return;
    const layout = { schemaVersion: input.schemaVersion ?? 1, positions: input.positions, viewport: input.viewport ?? { x: 0, y: 0, zoom: 1 } };
    const workflowId = (request.params as { id: string }).id;
    const workflow = await query<{ id: string; definition: WorkflowDefinition }>(
      'SELECT id,definition FROM workflows WHERE id=$1 AND workspace_id=$2',
      [workflowId, request.user.workspaceId],
    );
    if (!workflow.rowCount) return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
    const errors = workflowLayoutErrors(layout, workflow.rows[0].definition);
    if (errors.length) return reply.code(400).send({ error: 'INVALID_WORKFLOW_LAYOUT', details: errors });
    const result = await query<{
      schema_version: number;
      positions: unknown[];
      viewport: Record<string, unknown>;
      updated_at: string;
    }>(
      `INSERT INTO workflow_editor_layouts(workflow_id,workspace_id,schema_version,positions,viewport,updated_by)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(workflow_id,schema_version) DO UPDATE SET
         positions=EXCLUDED.positions,viewport=EXCLUDED.viewport,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING schema_version,positions,viewport,updated_at`,
      [workflowId, request.user.workspaceId, layout.schemaVersion, JSON.stringify(layout.positions), JSON.stringify(layout.viewport), request.user.sub],
    );
    await audit(request.user.workspaceId, request.user.sub, 'workflow.layout.updated', 'workflow', workflowId, { schemaVersion: layout.schemaVersion, nodeCount: layout.positions.length });
    return {
      workflowId,
      schemaVersion: result.rows[0].schema_version,
      positions: result.rows[0].positions,
      viewport: result.rows[0].viewport,
      updatedAt: result.rows[0].updated_at,
    };
  }));
  app.get('/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const result = await query(`${workflowListSql} WHERE w.id=$1 AND w.workspace_id=$2`, [(request.params as { id: string }).id, request.user.workspaceId]);
    return result.rowCount ? result.rows[0] : reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
  }));
  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(workflowInput.partial(), request.body, reply); if (!input) return;
    if (input.definition) {
      const definition = input.definition as WorkflowDefinition;
      const validationError = await definitionResourceError(request.user.workspaceId, definition);
      if (validationError) return reply.code(validationError.status).send(validationError.body);
    }
    if (input.enabled === true) {
      if (input.name !== undefined || input.description !== undefined || input.definition !== undefined) {
        return reply.code(400).send({ error: 'WORKFLOW_RESUME_MUST_BE_SEPARATE', message: 'Save draft changes separately before resuming the published version.' });
      }
      const resumed = await query(
        `UPDATE workflows SET enabled=true,status='published',updated_at=now()
         WHERE id=$1 AND workspace_id=$2 AND published_version_id IS NOT NULL AND status <> 'archived' RETURNING *`,
        [(request.params as { id: string }).id, request.user.workspaceId],
      );
      if (!resumed.rowCount) return reply.code(409).send({ error: 'WORKFLOW_PUBLISH_REQUIRED', message: 'Test and publish this workflow before enabling it.' });
      await audit(request.user.workspaceId, request.user.sub, 'workflow.resumed', 'workflow', resumed.rows[0].id);
      return resumed.rows[0];
    }
    const entries: Array<[string, unknown]> = [];
    if (input.name !== undefined) entries.push(['name', input.name]);
    if (input.description !== undefined) entries.push(['description', input.description]);
    if (input.definition !== undefined) entries.push(['definition', JSON.stringify(input.definition)]);
    if (input.enabled === false) { entries.push(['enabled', false]); entries.push(['status', 'paused']); }
    if (!entries.length) return reply.code(400).send({ error: 'NO_UPDATES' });
    const values = entries.map(([, value]) => value);
    const changesDraft = input.name !== undefined || input.description !== undefined || input.definition !== undefined;
    const set = `${entries.map(([field], index) => `${field}=$${index + 1}`).join(', ')}${changesDraft ? ', draft_revision=draft_revision+1' : ''}`;
    const result = await query(`UPDATE workflows SET ${set},updated_at=now() WHERE id=$${values.length + 1} AND workspace_id=$${values.length + 2} RETURNING *`, [...values, (request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, 'workflow.updated', 'workflow', result.rows[0].id, { fields: entries.map(([field]) => field) });
    return result.rows[0];
  }));
  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const result = await query('DELETE FROM workflows WHERE id=$1 AND workspace_id=$2 RETURNING id', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, 'workflow.deleted', 'workflow', result.rows[0].id);
    return reply.code(204).send();
  }));
  app.post('/:id/dry-run', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(runInputSchema, request.body, reply); if (!input) return;
    const workflow = await query<WorkflowRecord>(
      "SELECT * FROM workflows WHERE id=$1 AND workspace_id=$2 AND status <> 'archived'",
      [(request.params as { id: string }).id, request.user.workspaceId],
    );
    if (!workflow.rowCount) return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
    // This endpoint intentionally only performs tenant-scoped SELECTs. It creates no run,
    // audit event, artifact, queue item, worker task, or persisted execution manifest.
    return dryRunWorkflow({ workspaceId: request.user.workspaceId, definition: workflow.rows[0].definition, input: input.input ?? {}, resources: await dryRunResources(request.user.workspaceId, workflow.rows[0].definition) });
  }));
  app.post('/:id/test-runs', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(runInputSchema, request.body, reply); if (!input) return;
    const workflow = await query<WorkflowRecord>(
      "SELECT * FROM workflows WHERE id=$1 AND workspace_id=$2 AND status <> 'archived'",
      [(request.params as { id: string }).id, request.user.workspaceId],
    );
    if (!workflow.rowCount) return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
    const validationError = await definitionResourceError(request.user.workspaceId, workflow.rows[0].definition);
    if (validationError) return reply.code(validationError.status).send(validationError.body);
    const created = await createQueuedRun({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      workflow: workflow.rows[0],
      definition: workflow.rows[0].definition,
      runInput: input.input ?? {},
      mode: 'test',
    });
    if ('error' in created) return reply.code(409).send({ error: created.error });
    await audit(request.user.workspaceId, request.user.sub, 'workflow.test_requested', 'workflow_run', created.run.id, {
      workflowId: workflow.rows[0].id,
      draftRevision: workflow.rows[0].draft_revision,
    });
    return reply.code(202).send(created.run);
  }));
  app.post('/:id/nodes/:nodeId/test-runs', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(runInputSchema, request.body, reply); if (!input) return;
    const params = request.params as { id: string; nodeId: string };
    const workflow = await query<WorkflowRecord>(
      "SELECT * FROM workflows WHERE id=$1 AND workspace_id=$2 AND status <> 'archived'",
      [params.id, request.user.workspaceId],
    );
    if (!workflow.rowCount) return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
    const node = workflow.rows[0].definition.nodes.find((candidate) => candidate.id === params.nodeId);
    if (!node || node.type === 'trigger') return reply.code(400).send({ error: 'WORKFLOW_TEST_NODE_INVALID', message: 'Choose a non-trigger node from the current draft.' });
    const validationError = await definitionResourceError(request.user.workspaceId, workflow.rows[0].definition);
    if (validationError) return reply.code(validationError.status).send(validationError.body);
    const created = await createQueuedRun({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      workflow: workflow.rows[0],
      definition: workflow.rows[0].definition,
      runInput: input.input ?? {},
      mode: 'test',
      testTargetNodeId: node.id,
    });
    if ('error' in created) return reply.code(409).send({ error: created.error });
    await audit(request.user.workspaceId, request.user.sub, 'workflow.node_test_requested', 'workflow_run', created.run.id, {
      workflowId: workflow.rows[0].id,
      nodeId: node.id,
      draftRevision: workflow.rows[0].draft_revision,
    });
    return reply.code(202).send(created.run);
  }));
  app.post('/:id/publish', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const workflowId = (request.params as { id: string }).id;
    const client = await db.connect();
    let published: Record<string, unknown> | undefined;
    try {
      await client.query('BEGIN');
      const workflow = await client.query<WorkflowRecord>(
        "SELECT * FROM workflows WHERE id=$1 AND workspace_id=$2 AND status <> 'archived' FOR UPDATE",
        [workflowId, request.user.workspaceId],
      );
      if (!workflow.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
      }
      const draft = workflow.rows[0];
      const validationError = await definitionResourceError(request.user.workspaceId, draft.definition);
      if (validationError) {
        await client.query('ROLLBACK');
        return reply.code(validationError.status).send(validationError.body);
      }
      const tested = await client.query<{ id: string }>(
        `SELECT id FROM workflow_runs
         WHERE workflow_id=$1 AND workspace_id=$2 AND run_mode='test' AND draft_revision=$3 AND status='completed'
           AND test_target_node_id IS NULL
         ORDER BY completed_at DESC LIMIT 1`,
        [workflowId, request.user.workspaceId, draft.draft_revision],
      );
      if (!tested.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'WORKFLOW_SUCCESSFUL_TEST_REQUIRED', message: 'Run and complete a test of the current saved draft before publishing.' });
      }
      const nextVersion = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version),0)+1 version FROM workflow_versions WHERE workflow_id=$1',
        [workflowId],
      );
      const version = await client.query(
        `INSERT INTO workflow_versions(workspace_id,workflow_id,version,name,description,definition,published_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [request.user.workspaceId, workflowId, nextVersion.rows[0].version, draft.name, draft.description, JSON.stringify(draft.definition), request.user.sub],
      );
      const updated = await client.query(
        `UPDATE workflows SET published_version_id=$1,status='published',enabled=true,updated_at=now()
         WHERE id=$2 AND workspace_id=$3 RETURNING *`,
        [version.rows[0].id, workflowId, request.user.workspaceId],
      );
      published = { ...updated.rows[0], published_version: version.rows[0].version };
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await audit(request.user.workspaceId, request.user.sub, 'workflow.published', 'workflow', workflowId, {
      version: published?.published_version,
    });
    return published;
  }));
  app.post('/:id/runs', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const workflow = await query<WorkflowRecord & { published_name: string; published_definition: WorkflowDefinition }>(
      `SELECT w.*,v.name published_name,v.definition published_definition
       FROM workflows w JOIN workflow_versions v ON v.id=w.published_version_id
       WHERE w.id=$1 AND w.workspace_id=$2 AND w.enabled=true AND w.status='published'`,
      [(request.params as { id: string }).id, request.user.workspaceId],
    );
    if (!workflow.rowCount) return reply.code(409).send({ error: 'WORKFLOW_NOT_PUBLISHED', message: 'Test and publish this workflow before running it.' });
    const input = parse(runInputSchema, request.body, reply); if (!input) return;
    const definition = workflow.rows[0].published_definition;
    const validationError = await definitionResourceError(request.user.workspaceId, definition);
    if (validationError) return reply.code(validationError.status).send(validationError.body);
    const created = await createQueuedRun({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      workflow: { ...workflow.rows[0], name: workflow.rows[0].published_name },
      definition,
      runInput: input.input ?? {},
      mode: 'production',
      workflowVersionId: workflow.rows[0].published_version_id,
    });
    if ('error' in created) return reply.code(409).send({ error: created.error });
    await audit(request.user.workspaceId, request.user.sub, 'workflow.run_requested', 'workflow_run', created.run.id, {
      workflowId: workflow.rows[0].id,
      workflowVersionId: workflow.rows[0].published_version_id,
    });
    return reply.code(202).send(created.run);
  }));
  app.get('/runs/:runId', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = await query('SELECT * FROM workflow_runs WHERE id=$1 AND workspace_id=$2', [runId, request.user.workspaceId]);
    if (!run.rowCount) return reply.code(404).send({ error: 'WORKFLOW_RUN_NOT_FOUND' });
    const [events, approvals, actionAuthorizations, nodeStates, artifacts, usage] = await Promise.all([
      query('SELECT * FROM workflow_run_events WHERE workflow_run_id=$1 ORDER BY created_at', [runId]),
      query('SELECT * FROM workflow_approvals WHERE workflow_run_id=$1 ORDER BY requested_at', [runId]),
      query(`SELECT id,node_id,iteration_key,attempt,adapter,resource_id,operation,target_summary,risk_level,
             arguments_summary,arguments_hash,status,requested_at,expires_at,resolved_at,consumed_at,error_message,runtime_error
             FROM action_authorizations WHERE workflow_run_id=$1 ORDER BY requested_at`, [runId]),
      query('SELECT * FROM workflow_run_node_states WHERE workflow_run_id=$1 ORDER BY started_at,attempt', [runId]),
      query('SELECT * FROM artifacts WHERE workflow_run_id=$1 ORDER BY created_at', [runId]),
      query<{ agent_tasks: number; input_tokens: number; output_tokens: number; estimated_cost_usd: string }>(
        `SELECT count(*)::int agent_tasks,
         COALESCE(sum(token_input),0)::int input_tokens,
         COALESCE(sum(token_output),0)::int output_tokens,
         COALESCE(sum(estimated_cost_usd),0)::text estimated_cost_usd
         FROM tasks WHERE workflow_run_id=$1`,
        [runId],
      ),
    ]);
    const totals = usage.rows[0] ?? { agent_tasks: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: '0' };
    return {
      ...run.rows[0],
      error: publicWorkflowError(run.rows[0].error),
      output: publicWorkflowOutput(run.rows[0].output),
      events: events.rows.map((row) => publicWorkflowEvent(row)),
      approvals: approvals.rows,
      actionAuthorizations: actionAuthorizations.rows.map((row) => publicWorkflowAuthorization(row)),
      nodeStates: nodeStates.rows.map((row) => ({
        ...row,
        error: publicWorkflowError(row.error),
      })),
      artifacts: artifacts.rows,
      usage: {
        agentTasks: Number(totals.agent_tasks),
        inputTokens: Number(totals.input_tokens),
        outputTokens: Number(totals.output_tokens),
        estimatedCostUsd: Number(totals.estimated_cost_usd),
      },
    };
  }));
  app.post('/runs/:runId/cancel', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const result = await requestCancellation({
      kind: 'workflow_run',
      id: runId,
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
    });
    if (!result) return reply.code(409).send({ error: 'WORKFLOW_RUN_CANNOT_BE_CANCELLED' });
    const trace = childTraceContext({
      traceId: result.trace_id,
      spanId: result.span_id,
      parentSpanId: result.parent_span_id,
    });
    await query(
      `INSERT INTO workflow_run_events(
         workspace_id,workflow_run_id,node_id,event_type,message,payload,trace_id,span_id,parent_span_id
       ) VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
      [
        request.user.workspaceId,
        result.id,
        'workflow.cancel_requested',
        'Workflow cancellation requested by user',
        '{}',
        trace.traceId,
        trace.spanId,
        trace.parentSpanId,
      ],
    );
    const childTasks = await query<{ id: string; trace_id: string }>(
      `SELECT id,trace_id FROM tasks
       WHERE workflow_run_id=$1 AND workspace_id=$2
         AND status IN ('cancel_requested','cancelling')`,
      [result.id, request.user.workspaceId],
    );
    await Promise.all([
      enqueueWorkflowRun(result.id, result.id, 0, result.trace_id),
      ...childTasks.rows.map((task) => enqueueTask(task.id, task.id, task.trace_id)),
    ]);
    await audit(request.user.workspaceId, request.user.sub, 'workflow.cancel_requested', 'workflow_run', result.id);
    return reply.code(202).send(result);
  }));
  app.post('/runs/:runId/approvals/:approvalId', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional() }), request.body, reply); if (!input) return;
    const params = request.params as { runId: string; approvalId: string };
    const client = await db.connect();
    let traceId = '';
    let approval: Record<string, unknown> | null = null;
    try {
      await client.query('BEGIN');
      const run = (await client.query<{
        run_mode: 'test' | 'production';
        execution_manifest: ExecutionManifest | null;
        trace_id: string;
        span_id: string;
        parent_span_id: string | null;
        status: string;
      }>(
        `SELECT run_mode,execution_manifest,trace_id,span_id,parent_span_id,status
           FROM workflow_runs
          WHERE id=$1 AND workspace_id=$2
          FOR UPDATE`,
        [params.runId, request.user.workspaceId],
      )).rows[0];
      if (!run) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'RUN_MANIFEST_INCOMPATIBLE',
          details: { reasons: ['Execution run is missing'] },
        });
      }
      traceId = authoritativeTraceContext(run).traceId;
      if (run.status !== 'awaiting_approval') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'APPROVAL_NOT_PENDING' });
      }
      if (input.decision === 'approved') {
        const compatibility = run.run_mode === 'production'
          ? validateManifestCompatibility(run.execution_manifest)
          : { ok: true, reasons: [] };
        if (!compatibility.ok) {
          await client.query('ROLLBACK');
          return reply.code(409).send({
            error: 'RUN_MANIFEST_INCOMPATIBLE',
            details: { reasons: compatibility.reasons },
          });
        }
      }
      const pending = await client.query(
        `SELECT * FROM workflow_approvals
          WHERE id=$1 AND workflow_run_id=$2 AND workspace_id=$3 AND status='pending'
          FOR UPDATE`,
        [params.approvalId, params.runId, request.user.workspaceId],
      );
      if (!pending.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'APPROVAL_NOT_PENDING' });
      }
      const resolved = await client.query(
        `UPDATE workflow_approvals
            SET status=$1,resolved_at=now(),resolved_by=$2,comment=$3
          WHERE id=$4 AND workflow_run_id=$5 AND workspace_id=$6 AND status='pending'
          RETURNING *`,
        [input.decision, request.user.sub, input.comment ?? null, params.approvalId, params.runId, request.user.workspaceId],
      );
      const transitioned = input.decision === 'rejected'
        ? await client.query(
          `UPDATE workflow_runs SET status='cancelled',completed_at=now(),updated_at=now()
            WHERE id=$1 AND workspace_id=$2 AND status='awaiting_approval' RETURNING id`,
          [params.runId, request.user.workspaceId],
        )
        : await client.query(
          `UPDATE workflow_runs SET status='queued',updated_at=now()
            WHERE id=$1 AND workspace_id=$2 AND status='awaiting_approval' RETURNING id`,
          [params.runId, request.user.workspaceId],
        );
      if (!resolved.rowCount || !transitioned.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'APPROVAL_NOT_PENDING' });
      }
      approval = resolved.rows[0];
      if (input.decision === 'rejected') {
        await client.query(
          "UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'",
          [params.runId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (input.decision === 'approved') {
      try {
        await enqueueWorkflowRun(params.runId, `${params.runId}-${params.approvalId}`, 0, traceId);
      } catch (queueError) {
        const recovery = await db.connect();
        try {
          await recovery.query('BEGIN');
          const queued = await recovery.query(
            `SELECT id FROM workflow_runs
              WHERE id=$1 AND workspace_id=$2 AND status='queued'
              FOR UPDATE`,
            [params.runId, request.user.workspaceId],
          );
          if (queued.rowCount) {
            await recovery.query(
              `UPDATE workflow_approvals
                  SET status='pending',resolved_at=NULL,resolved_by=NULL,comment=NULL
                WHERE id=$1 AND workflow_run_id=$2 AND workspace_id=$3 AND status='approved'`,
              [params.approvalId, params.runId, request.user.workspaceId],
            );
            await recovery.query(
              `UPDATE workflow_runs SET status='awaiting_approval',updated_at=now()
                WHERE id=$1 AND workspace_id=$2 AND status='queued'`,
              [params.runId, request.user.workspaceId],
            );
          }
          await recovery.query('COMMIT');
        } catch (recoveryError) {
          await recovery.query('ROLLBACK');
          throw recoveryError;
        } finally {
          recovery.release();
        }
        throw queueError;
      }
    }
    await audit(
      request.user.workspaceId,
      request.user.sub,
      `workflow.approval.${input.decision}`,
      'workflow_run',
      params.runId,
      { approvalId: params.approvalId, comment: input.comment ?? null },
    );
    return approval;
  }));
}
