import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';

const defaultModel = process.env.LLM_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514';
const modelConfig = z.object({
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().min(128).max(128_000).default(4096),
  topP: z.number().min(0).max(1).default(1),
});
const capabilities = z.object({
  webBrowser: z.boolean().default(false),
  codeInterpreter: z.boolean().default(false),
  knowledgeBase: z.boolean().default(true),
});
const agentInput = z.object({
  name: z.string().min(2).max(120),
  role: z.string().min(2).max(240),
  goal: z.string().min(2).max(5000),
  instructions: z.string().max(20000).default(''),
  personality: z.string().max(80).nullable().optional(),
  model: z.string().min(2).max(160).default(defaultModel),
  modelConfig: modelConfig.default({ temperature: 0.2, maxTokens: 4096, topP: 1 }),
  capabilities: capabilities.default({ webBrowser: false, codeInterpreter: false, knowledgeBase: true }),
  status: z.enum(['draft', 'active', 'paused', 'archived']).default('draft'),
  toolIds: z.array(z.string().uuid()).default([]),
  memoryConfig: z.record(z.boolean()).default({ shortTerm: true, longTerm: true, knowledgeBase: true }),
});

async function validateTools(workspaceId: string, toolIds: string[]) {
  if (!toolIds.length) return true;
  const result = await query<{ id: string }>('SELECT id FROM tools WHERE workspace_id=$1 AND enabled=true AND id = ANY($2::uuid[])', [workspaceId, toolIds]);
  return new Set(result.rows.map((row) => row.id)).size === new Set(toolIds).size;
}

export async function agentRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const result = await query('SELECT * FROM agents WHERE workspace_id=$1 ORDER BY updated_at DESC', [request.user.workspaceId]);
    return { data: result.rows };
  }));
  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(agentInput, request.body, reply); if (!input) return;
    if (!(await validateTools(request.user.workspaceId, input.toolIds ?? []))) return reply.code(400).send({ error: 'INVALID_OR_DISABLED_TOOL' });
    const result = await query('INSERT INTO agents(workspace_id,name,role,goal,instructions,personality,model,model_config,capabilities,status,tool_ids,memory_config,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *', [request.user.workspaceId, input.name, input.role, input.goal, input.instructions, input.personality ?? null, input.model, JSON.stringify(input.modelConfig), JSON.stringify(input.capabilities), input.status, JSON.stringify(input.toolIds ?? []), JSON.stringify(input.memoryConfig ?? { shortTerm: true, longTerm: true, knowledgeBase: true }), request.user.sub]);
    await audit(request.user.workspaceId, request.user.sub, 'agent.created', 'agent', result.rows[0].id);
    return reply.code(201).send(result.rows[0]);
  }));
  app.get('/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const result = await query('SELECT * FROM agents WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    return result.rows[0];
  }));
  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(agentInput.partial(), request.body, reply); if (!input) return;
    const existing = await query('SELECT id FROM agents WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!existing.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    if (input.toolIds && !(await validateTools(request.user.workspaceId, input.toolIds))) return reply.code(400).send({ error: 'INVALID_OR_DISABLED_TOOL' });
    const columns: Record<string, unknown> = { name: input.name, role: input.role, goal: input.goal, instructions: input.instructions, personality: input.personality, model: input.model, model_config: input.modelConfig && JSON.stringify(input.modelConfig), capabilities: input.capabilities && JSON.stringify(input.capabilities), status: input.status, tool_ids: input.toolIds && JSON.stringify(input.toolIds), memory_config: input.memoryConfig && JSON.stringify(input.memoryConfig) };
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (!entries.length) return reply.code(400).send({ error: 'NO_UPDATES' });
    const set = entries.map(([name], index) => `${name}=$${index + 1}`).join(', ');
    const values = entries.map(([, value]) => value);
    const result = await query(`UPDATE agents SET ${set},updated_at=now() WHERE id=$${values.length + 1} AND workspace_id=$${values.length + 2} RETURNING *`, [...values, (request.params as { id: string }).id, request.user.workspaceId]);
    await audit(request.user.workspaceId, request.user.sub, 'agent.updated', 'agent', result.rows[0].id, { fields: entries.map(([name]) => name) });
    return result.rows[0];
  }));
  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const result = await query('UPDATE agents SET status=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3 RETURNING id', ['archived', (request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, 'agent.archived', 'agent', result.rows[0].id);
    return reply.code(204).send();
  }));
}
