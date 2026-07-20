import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { asyncRoute, parse } from '../lib/http.js';
const templateInput = z.object({ name: z.string().min(2).max(120), description: z.string().max(2000).default(''), content: z.string().min(1).max(50000), variables: z.array(z.string().min(1)).default([]) });
const experimentInput = z.object({ name: z.string().min(2).max(160), templateId: z.string().uuid(), versionAId: z.string().uuid(), versionBId: z.string().uuid() });
const resultInput = z.object({ versionId: z.string().uuid(), input: z.record(z.unknown()).default({}), output: z.string().max(100000).optional(), accuracyScore: z.number().min(0).max(1).optional(), latencyMs: z.number().int().min(0).optional(), costUsd: z.number().min(0).optional() });
export async function promptRoutes(app: FastifyInstance) {
  app.get('/templates', { preHandler: app.authenticate }, asyncRoute(async (request) => ({ data: (await query('SELECT t.*,v.id latest_version_id,v.version,v.content,v.variables FROM prompt_templates t LEFT JOIN LATERAL (SELECT * FROM prompt_versions WHERE template_id=t.id ORDER BY version DESC LIMIT 1) v ON true WHERE t.workspace_id=$1 ORDER BY t.updated_at DESC', [request.user.workspaceId])).rows })));
  app.post('/templates', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(templateInput, request.body, reply); if (!input) return;
    const client = await (await import('../db/client.js')).db.connect();
    try {
      await client.query('BEGIN');
      const template = (await client.query<{ id: string }>('INSERT INTO prompt_templates(workspace_id,name,description,created_by) VALUES($1,$2,$3,$4) RETURNING id', [request.user.workspaceId, input.name, input.description, request.user.sub])).rows[0];
      const version = (await client.query('INSERT INTO prompt_versions(template_id,version,content,variables,created_by) VALUES($1,1,$2,$3,$4) RETURNING *', [template.id, input.content, JSON.stringify(input.variables), request.user.sub])).rows[0];
      await client.query('COMMIT'); return reply.code(201).send({ id: template.id, ...input, version });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }));
  app.post('/templates/:id/versions', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(templateInput.pick({ content: true, variables: true }), request.body, reply); if (!input) return;
    const template = await query('SELECT id FROM prompt_templates WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!template.rowCount) return reply.code(404).send({ error: 'PROMPT_TEMPLATE_NOT_FOUND' });
    const version = await query('INSERT INTO prompt_versions(template_id,version,content,variables,created_by) SELECT $1,coalesce(max(version),0)+1,$2,$3,$4 FROM prompt_versions WHERE template_id=$1 RETURNING *', [template.rows[0].id, input.content, JSON.stringify(input.variables), request.user.sub]);
    await query('UPDATE prompt_templates SET updated_at=now() WHERE id=$1', [template.rows[0].id]);
    return reply.code(201).send(version.rows[0]);
  }));
  app.get('/templates/:id/versions', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const template = await query('SELECT id FROM prompt_templates WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!template.rowCount) return reply.code(404).send({ error: 'PROMPT_TEMPLATE_NOT_FOUND' });
    return { data: (await query('SELECT id,version,content,variables,created_at FROM prompt_versions WHERE template_id=$1 ORDER BY version DESC', [template.rows[0].id])).rows };
  }));
  app.delete('/templates/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const result = await query('DELETE FROM prompt_templates WHERE id=$1 AND workspace_id=$2 RETURNING id', [(request.params as { id: string }).id, request.user.workspaceId]);
    return result.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'PROMPT_TEMPLATE_NOT_FOUND' });
  }));
  app.get('/experiments', { preHandler: app.authenticate }, asyncRoute(async (request) => ({ data: (await query('SELECT e.*,t.name template_name FROM prompt_experiments e JOIN prompt_templates t ON t.id=e.template_id WHERE e.workspace_id=$1 ORDER BY e.created_at DESC', [request.user.workspaceId])).rows })));
  app.post('/experiments', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(experimentInput, request.body, reply); if (!input) return;
    const valid = await query('SELECT v.id FROM prompt_versions v JOIN prompt_templates t ON t.id=v.template_id WHERE t.workspace_id=$1 AND t.id=$2 AND v.id = ANY($3::uuid[])', [request.user.workspaceId, input.templateId, [input.versionAId, input.versionBId]]);
    if (valid.rowCount !== 2) return reply.code(400).send({ error: 'VERSIONS_DO_NOT_BELONG_TO_TEMPLATE' });
    const experiment = await query('INSERT INTO prompt_experiments(workspace_id,name,template_id,version_a_id,version_b_id,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [request.user.workspaceId, input.name, input.templateId, input.versionAId, input.versionBId, 'running']);
    return reply.code(201).send(experiment.rows[0]);
  }));
  app.get('/experiments/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const experiment = await query('SELECT * FROM prompt_experiments WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!experiment.rowCount) return reply.code(404).send({ error: 'PROMPT_EXPERIMENT_NOT_FOUND' });
    const results = await query('SELECT * FROM prompt_experiment_results WHERE experiment_id=$1 ORDER BY created_at DESC', [experiment.rows[0].id]);
    return { ...experiment.rows[0], results: results.rows };
  }));
  app.post('/experiments/:id/results', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(resultInput, request.body, reply); if (!input) return;
    const experiment = await query('SELECT * FROM prompt_experiments WHERE id=$1 AND workspace_id=$2 AND status=$3', [(request.params as { id: string }).id, request.user.workspaceId, 'running']);
    if (!experiment.rowCount) return reply.code(404).send({ error: 'PROMPT_EXPERIMENT_NOT_RUNNING' });
    const current = experiment.rows[0] as { version_a_id: string; version_b_id: string; id: string };
    if (![current.version_a_id, current.version_b_id].includes(input.versionId)) return reply.code(400).send({ error: 'VERSION_NOT_IN_EXPERIMENT' });
    const result = await query('INSERT INTO prompt_experiment_results(experiment_id,version_id,input,output,accuracy_score,latency_ms,cost_usd) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [current.id, input.versionId, JSON.stringify(input.input), input.output ?? null, input.accuracyScore ?? null, input.latencyMs ?? null, input.costUsd ?? null]);
    return reply.code(201).send(result.rows[0]);
  }));
  app.post('/experiments/:id/complete', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const result = await query("UPDATE prompt_experiments SET status='completed' WHERE id=$1 AND workspace_id=$2 AND status='running' RETURNING *", [(request.params as { id: string }).id, request.user.workspaceId]);
    return result.rowCount ? result.rows[0] : reply.code(409).send({ error: 'PROMPT_EXPERIMENT_NOT_RUNNING' });
  }));
}
