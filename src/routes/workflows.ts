import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { enqueueWorkflowRun } from '../queue/task-queue.js';
import { assertWorkspaceAiBudgetAvailable } from '../lib/ai-usage.js';
import { workflowDefinitionErrors, workflowDefinitionSchema, type WorkflowDefinition } from '../workflows/definition.js';
import { requestWorkflowArtifacts } from '../artifacts/service.js';
import { artifactFormatSchema } from '../artifacts/types.js';
import { retryPolicy } from '../workflows/definition.js';
import { toolRequiresApproval, type ToolRecord } from '../tools/runtime.js';

const workflowInput = z.object({ name: z.string().min(2).max(120), description: z.string().max(2000).default(''), definition: workflowDefinitionSchema, enabled: z.boolean().default(true) });

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

export async function workflowRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => ({ data: (await query('SELECT * FROM workflows WHERE workspace_id=$1 ORDER BY updated_at DESC', [request.user.workspaceId])).rows })));
  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(workflowInput, request.body, reply); if (!input) return;
    const definition = input.definition as WorkflowDefinition;
    const definitionErrors = workflowDefinitionErrors(definition);
    if (definitionErrors.length) return reply.code(400).send({ error: 'INVALID_WORKFLOW_DEFINITION', details: definitionErrors });
    if (!(await validateAgentNodes(request.user.workspaceId, definition))) return reply.code(400).send({ error: 'INVALID_OR_INACTIVE_AGENT_NODE' });
    const actionValidation = await validateActionNodes(request.user.workspaceId, definition);
    if (!actionValidation.valid) return reply.code(400).send({ error: 'INVALID_OR_DISABLED_TOOL_NODE' });
    if (actionValidation.errors.length) return reply.code(400).send({ error: 'UNSAFE_ACTION_NODE', details: actionValidation.errors });
    const result = await query('INSERT INTO workflows(workspace_id,name,description,definition,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [request.user.workspaceId, input.name, input.description, JSON.stringify(definition), input.enabled, request.user.sub]);
    await audit(request.user.workspaceId, request.user.sub, 'workflow.created', 'workflow', result.rows[0].id);
    return reply.code(201).send(result.rows[0]);
  }));
  app.get('/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const result = await query('SELECT * FROM workflows WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    return result.rowCount ? result.rows[0] : reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND' });
  }));
  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(workflowInput.partial(), request.body, reply); if (!input) return;
    if (input.definition) {
      const definition = input.definition as WorkflowDefinition;
      const definitionErrors = workflowDefinitionErrors(definition);
      if (definitionErrors.length) return reply.code(400).send({ error: 'INVALID_WORKFLOW_DEFINITION', details: definitionErrors });
      if (!(await validateAgentNodes(request.user.workspaceId, definition))) return reply.code(400).send({ error: 'INVALID_OR_INACTIVE_AGENT_NODE' });
      const actionValidation = await validateActionNodes(request.user.workspaceId, definition);
      if (!actionValidation.valid) return reply.code(400).send({ error: 'INVALID_OR_DISABLED_TOOL_NODE' });
      if (actionValidation.errors.length) return reply.code(400).send({ error: 'UNSAFE_ACTION_NODE', details: actionValidation.errors });
    }
    const entries: Array<[string, unknown]> = [];
    if (input.name !== undefined) entries.push(['name', input.name]);
    if (input.description !== undefined) entries.push(['description', input.description]);
    if (input.definition !== undefined) entries.push(['definition', JSON.stringify(input.definition)]);
    if (input.enabled !== undefined) entries.push(['enabled', input.enabled]);
    if (!entries.length) return reply.code(400).send({ error: 'NO_UPDATES' });
    const values = entries.map(([, value]) => value);
    const set = entries.map(([field], index) => `${field}=$${index + 1}`).join(', ');
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
  app.post('/:id/runs', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const workflow = await query<{ id: string; name: string; definition: WorkflowDefinition }>('SELECT id,name,definition FROM workflows WHERE id=$1 AND workspace_id=$2 AND enabled=true', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!workflow.rowCount) return reply.code(404).send({ error: 'WORKFLOW_NOT_FOUND_OR_DISABLED' });
    const input = parse(z.object({ input: z.record(z.unknown()).default({}) }), request.body, reply); if (!input) return;
    await assertWorkspaceAiBudgetAvailable(request.user.workspaceId);
    const trigger = workflow.rows[0].definition.nodes.find((node) => node.type === 'trigger');
    if (!trigger) return reply.code(409).send({ error: 'WORKFLOW_TRIGGER_MISSING' });
    const initialState = { input: input.input, ...input.input };
    const cursor = { nodeId: trigger.id, loops: {}, attempt: 1 };
    const run = await query(
      `INSERT INTO workflow_runs(workspace_id,workflow_id,input,definition_snapshot,state,cursor)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [request.user.workspaceId, workflow.rows[0].id, JSON.stringify(input.input), JSON.stringify(workflow.rows[0].definition), JSON.stringify(initialState), JSON.stringify(cursor)],
    );
    const formats = [...new Set(workflow.rows[0].definition.nodes
      .filter((node) => node.type === 'output' && Array.isArray(node.config.artifactFormats))
      .flatMap((node) => (node.config.artifactFormats as unknown[]).map((item) => artifactFormatSchema.safeParse(item)).filter((item) => item.success).map((item) => item.data)))];
    if (formats.length) await requestWorkflowArtifacts({ workspaceId: request.user.workspaceId, createdBy: request.user.sub, workflowRunId: run.rows[0].id, title: workflow.rows[0].name, formats, ready: false });
    try {
      await enqueueWorkflowRun(run.rows[0].id);
    } catch (queueError) {
      const message = (queueError instanceof Error ? queueError.message : 'Workflow queue unavailable').slice(0, 2000);
      await query("UPDATE workflow_runs SET status='failed',output=$1,completed_at=now(),updated_at=now() WHERE id=$2", [JSON.stringify({ error: message }), run.rows[0].id]);
      await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [run.rows[0].id]);
      throw queueError;
    }
    await audit(request.user.workspaceId, request.user.sub, 'workflow.run_requested', 'workflow_run', run.rows[0].id, { workflowId: workflow.rows[0].id });
    return reply.code(202).send(run.rows[0]);
  }));
  app.get('/runs/:runId', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    const run = await query('SELECT * FROM workflow_runs WHERE id=$1 AND workspace_id=$2', [runId, request.user.workspaceId]);
    if (!run.rowCount) return reply.code(404).send({ error: 'WORKFLOW_RUN_NOT_FOUND' });
    const [events, approvals, nodeStates, artifacts] = await Promise.all([
      query('SELECT * FROM workflow_run_events WHERE workflow_run_id=$1 ORDER BY created_at', [runId]),
      query('SELECT * FROM workflow_approvals WHERE workflow_run_id=$1 ORDER BY requested_at', [runId]),
      query('SELECT * FROM workflow_run_node_states WHERE workflow_run_id=$1 ORDER BY started_at,attempt', [runId]),
      query('SELECT * FROM artifacts WHERE workflow_run_id=$1 ORDER BY created_at', [runId]),
    ]);
    return { ...run.rows[0], events: events.rows, approvals: approvals.rows, nodeStates: nodeStates.rows, artifacts: artifacts.rows };
  }));
  app.post('/runs/:runId/approvals/:approvalId', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(2000).optional() }), request.body, reply); if (!input) return;
    const params = request.params as { runId: string; approvalId: string };
    const approval = await query("UPDATE workflow_approvals SET status=$1,resolved_at=now(),resolved_by=$2,comment=$3 WHERE id=$4 AND workflow_run_id=$5 AND workspace_id=$6 AND status='pending' RETURNING *", [input.decision, request.user.sub, input.comment ?? null, params.approvalId, params.runId, request.user.workspaceId]);
    if (!approval.rowCount) return reply.code(409).send({ error: 'APPROVAL_NOT_PENDING' });
    if (input.decision === 'rejected') {
      await query("UPDATE workflow_runs SET status='cancelled',completed_at=now(),updated_at=now() WHERE id=$1", [params.runId]);
      await query("UPDATE artifacts SET status='skipped',error_message=NULL,updated_at=now() WHERE workflow_run_id=$1 AND status='pending'", [params.runId]);
    }
    else {
      await query("UPDATE workflow_runs SET status='queued',updated_at=now() WHERE id=$1", [params.runId]);
      try {
        await enqueueWorkflowRun(params.runId, `${params.runId}-${params.approvalId}`);
      } catch (queueError) {
        await query("UPDATE workflow_approvals SET status='pending',resolved_at=NULL,resolved_by=NULL,comment=NULL WHERE id=$1", [params.approvalId]);
        await query("UPDATE workflow_runs SET status='awaiting_approval',updated_at=now() WHERE id=$1", [params.runId]);
        throw queueError;
      }
    }
    return approval.rows[0];
  }));
}
