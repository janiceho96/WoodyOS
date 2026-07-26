import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { encryptJsonWithContext } from '../lib/crypto.js';
import { asyncRoute, parse } from '../lib/http.js';
import { enqueueWorkflowRun } from '../queue/task-queue.js';
import { compileAgentSolution, containsLikelySecret } from '../solutions/compiler.js';
import { installAgentSolution } from '../solutions/installer.js';
import { agentSolutionSchema, parseAgentSolution } from '../solutions/schema.js';
import { assertWorkspaceAiBudgetAvailable } from '../lib/ai-usage.js';
import type { WorkflowDefinition } from '../workflows/definition.js';
import { retrieveExplicitFileContext } from '../files/context.js';

const compileInput = z.object({
  prompt: z.string().min(20).max(50_000),
  mode: z.enum(['automatic', 'single', 'multi']).default('automatic'),
  saveDraft: z.boolean().default(false),
  persistPrompt: z.boolean().default(false),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});
const installInput = z.object({
  solution: agentSolutionSchema,
  allowDuplicate: z.boolean().default(false),
  sourcePrompt: z.string().min(20).max(50_000).optional(),
  persistPrompt: z.boolean().default(false),
});
const idParams = z.object({ id: z.string().uuid() });

export async function agentSolutionRoutes(app: FastifyInstance) {
  app.post('/compile', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(compileInput, request.body, reply);
    if (!input) return;
    if (input.persistPrompt && !input.saveDraft) {
      return reply.code(400).send({ error: 'PROMPT_PERSISTENCE_REQUIRES_SAVED_DRAFT' });
    }
    const attachmentIds = [...new Set(input.attachmentIds)];
    if (attachmentIds.length) {
      const available = await query<{ id: string }>(
        `SELECT id FROM files WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='ready'`,
        [request.user.workspaceId, attachmentIds],
      );
      if (available.rowCount !== attachmentIds.length) {
        return reply.code(409).send({ error: 'FILE_ATTACHMENTS_NOT_READY_OR_MISSING' });
      }
    }
    const reference = attachmentIds.length
      ? await retrieveExplicitFileContext(request.user.workspaceId, attachmentIds, input.prompt)
      : { text: '', citations: [] };
    const solution = await compileAgentSolution(input.prompt, input.mode ?? 'automatic', request.user.workspaceId, reference.text);
    let draftId: string | null = null;
    if (input.saveDraft) {
      draftId = randomUUID();
      const encryptedPrompt = input.persistPrompt
        ? encryptJsonWithContext({ prompt: input.prompt }, `agent-solution-draft:${request.user.workspaceId}:${draftId}`)
        : null;
      await query(
        `INSERT INTO agent_solution_drafts(
           id,workspace_id,source_type,name,solution,encrypted_source_prompt,prompt_hash,created_by
         ) VALUES($1,$2,'generated',$3,$4,$5,$6,$7)`,
        [
          draftId, request.user.workspaceId, solution.name, JSON.stringify(solution),
          encryptedPrompt ? JSON.stringify(encryptedPrompt) : null,
          createHash('sha256').update(input.prompt).digest('hex'), request.user.sub,
        ],
      );
    }
    await audit(request.user.workspaceId, request.user.sub, 'agent_solution.compiled', 'agent_solution_draft', draftId, {
      mode: input.mode,
      agentCount: solution.agents.length,
      promptPersisted: Boolean(input.persistPrompt && input.saveDraft),
      attachmentCount: attachmentIds.length,
      attachmentCitationCount: reference.citations.length,
    });
    return { solution, draftId };
  }));

  app.post('/install', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(installInput, request.body, reply);
    if (!input) return;
    if (input.solution.source === 'starter') {
      return reply.code(400).send({ error: 'USE_STARTER_INSTALL_ROUTE' });
    }
    if (input.sourcePrompt && containsLikelySecret(input.sourcePrompt)) {
      return reply.code(400).send({ error: 'PROMPT_CONTAINS_POSSIBLE_SECRET' });
    }
    const installed = await installAgentSolution({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      solution: parseAgentSolution(input.solution),
      allowDuplicate: input.allowDuplicate,
      sourcePrompt: input.sourcePrompt,
      persistPrompt: input.persistPrompt,
    });
    await audit(request.user.workspaceId, request.user.sub, 'agent_solution.installed', 'agent_solution_installation', installed.id, {
      source: installed.solution.source,
      slug: installed.solution.slug,
      version: installed.solution.version,
      agentCount: installed.solution.agents.length,
    });
    return reply.code(201).send(installed);
  }));

  app.get('/installations', { preHandler: app.authenticate }, asyncRoute(async (request) => ({
    data: (await query(
      `SELECT i.id,i.source_type,i.solution_slug,i.solution_version,i.solution_name,i.status,
       i.solution_snapshot solution,i.created_resource_ids resources,i.last_test_run_id,i.last_tested_at,
       i.activated_at,i.created_at,i.updated_at,r.status last_test_status
       FROM agent_solution_installations i
       LEFT JOIN workflow_runs r ON r.id=i.last_test_run_id
       WHERE i.workspace_id=$1 AND i.status <> 'archived'
       ORDER BY i.created_at DESC`,
      [request.user.workspaceId],
    )).rows,
  })));

  app.post('/installations/:id/test', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    const body = parse(z.object({ input: z.record(z.unknown()).default({}) }), request.body, reply);
    if (!params || !body) return;
    const installation = await query<{
      id: string;
      status: string;
      solution_snapshot: z.infer<typeof agentSolutionSchema>;
      created_resource_ids: { workflowId?: string };
    }>(
      `SELECT id,status,solution_snapshot,created_resource_ids
       FROM agent_solution_installations WHERE id=$1 AND workspace_id=$2 AND status='draft'`,
      [params.id, request.user.workspaceId],
    );
    if (!installation.rowCount) return reply.code(404).send({ error: 'DRAFT_SOLUTION_INSTALLATION_NOT_FOUND' });
    const record = installation.rows[0];
    const runInput = body.input ?? {};
    const required = record.solution_snapshot.requiredInputs.filter((field) => field.required);
    const missing = required.filter((field) => runInput[field.key] === undefined || runInput[field.key] === '');
    if (missing.length) {
      return reply.code(400).send({ error: 'SOLUTION_TEST_INPUT_MISSING', details: missing.map((field) => field.label) });
    }
    const workflowId = record.created_resource_ids.workflowId;
    if (!workflowId) return reply.code(409).send({ error: 'SOLUTION_WORKFLOW_MISSING' });
    await assertWorkspaceAiBudgetAvailable(request.user.workspaceId);
    const workflow = await query<{ id: string; definition: WorkflowDefinition; draft_revision: number }>(
      "SELECT id,definition,draft_revision FROM workflows WHERE id=$1 AND workspace_id=$2 AND status <> 'archived'",
      [workflowId, request.user.workspaceId],
    );
    if (!workflow.rowCount) return reply.code(409).send({ error: 'SOLUTION_WORKFLOW_MISSING' });
    const definition = workflow.rows[0].definition;
    const trigger = definition.nodes.find((node) => node.type === 'trigger');
    if (!trigger) return reply.code(409).send({ error: 'SOLUTION_WORKFLOW_TRIGGER_MISSING' });
    const initialState = { ...runInput, input: runInput, nodes: {}, variables: {} };
    const run = await query(
      `INSERT INTO workflow_runs(workspace_id,workflow_id,input,definition_snapshot,state,cursor,run_mode,draft_revision)
       VALUES($1,$2,$3,$4,$5,$6,'test',$7) RETURNING *`,
      [
        request.user.workspaceId, workflowId, JSON.stringify(runInput), JSON.stringify(definition),
        JSON.stringify(initialState), JSON.stringify({ nodeId: trigger.id, loops: {}, attempt: 1 }), workflow.rows[0].draft_revision,
      ],
    );
    await query(
      'UPDATE agent_solution_installations SET last_test_run_id=$1,last_tested_at=now(),updated_at=now() WHERE id=$2',
      [run.rows[0].id, params.id],
    );
    try {
      await enqueueWorkflowRun(run.rows[0].id);
    } catch {
      await query(
        "UPDATE workflow_runs SET status='failed',output=$1,completed_at=now(),updated_at=now() WHERE id=$2",
        [JSON.stringify({ error: 'Workflow queue is unavailable' }), run.rows[0].id],
      );
      return reply.code(503).send({ error: 'WORKFLOW_QUEUE_UNAVAILABLE' });
    }
    await audit(request.user.workspaceId, request.user.sub, 'agent_solution.test_requested', 'agent_solution_installation', params.id, {
      workflowRunId: run.rows[0].id,
    });
    return reply.code(202).send(run.rows[0]);
  }));

  app.post('/installations/:id/activate', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params) return;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const installation = await client.query<{
        id: string;
        created_resource_ids: { agentIds?: Record<string, string>; workflowId?: string };
        last_test_status: string | null;
        last_test_revision: number | null;
      }>(
        `SELECT i.id,i.created_resource_ids,r.status last_test_status,r.draft_revision last_test_revision
         FROM agent_solution_installations i
         LEFT JOIN workflow_runs r ON r.id=i.last_test_run_id
         WHERE i.id=$1 AND i.workspace_id=$2 AND i.status='draft' FOR UPDATE OF i`,
        [params.id, request.user.workspaceId],
      );
      if (!installation.rowCount) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ error: 'DRAFT_SOLUTION_INSTALLATION_NOT_FOUND' });
      }
      if (installation.rows[0].last_test_status !== 'completed') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'SOLUTION_SUCCESSFUL_TEST_REQUIRED' });
      }
      const resources = installation.rows[0].created_resource_ids;
      const agentIds = Object.values(resources.agentIds ?? {});
      if (!agentIds.length || !resources.workflowId) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'SOLUTION_RESOURCES_MISSING' });
      }
      await client.query(
        "UPDATE agents SET status='active',updated_at=now() WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND status='draft'",
        [request.user.workspaceId, agentIds],
      );
      const workflow = await client.query<{ id: string; name: string; description: string; definition: WorkflowDefinition; draft_revision: number }>(
        "SELECT id,name,description,definition,draft_revision FROM workflows WHERE id=$1 AND workspace_id=$2 AND status <> 'archived' FOR UPDATE",
        [resources.workflowId, request.user.workspaceId],
      );
      if (!workflow.rowCount || installation.rows[0].last_test_revision !== workflow.rows[0].draft_revision) {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: 'SOLUTION_CURRENT_DRAFT_TEST_REQUIRED' });
      }
      const nextVersion = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version),0)+1 version FROM workflow_versions WHERE workflow_id=$1',
        [resources.workflowId],
      );
      const version = await client.query<{ id: string }>(
        `INSERT INTO workflow_versions(workspace_id,workflow_id,version,name,description,definition,published_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          request.user.workspaceId, resources.workflowId, nextVersion.rows[0].version, workflow.rows[0].name,
          workflow.rows[0].description, JSON.stringify(workflow.rows[0].definition), request.user.sub,
        ],
      );
      await client.query(
        "UPDATE workflows SET published_version_id=$1,status='published',enabled=true,updated_at=now() WHERE id=$2 AND workspace_id=$3",
        [version.rows[0].id, resources.workflowId, request.user.workspaceId],
      );
      await client.query(
        "UPDATE agent_solution_installations SET status='active',activated_at=now(),updated_at=now() WHERE id=$1",
        [params.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await audit(request.user.workspaceId, request.user.sub, 'agent_solution.activated', 'agent_solution_installation', params.id);
    return { id: params.id, status: 'active' };
  }));
}
