import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { agentAvatarSchema } from '../agents/avatar.js';
import { agentPromptRequestSchema, generateAgentPrompt } from '../agents/prompt-generator.js';
import { agentAvatarStorage } from '../avatars/storage.js';
import { deleteAgentAvatar, findAgentAvatar, saveAgentAvatar } from '../avatars/service.js';
import { loadAgentMcpAccess } from '../agents/mcp-access.js';

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
  avatar: agentAvatarSchema.optional(),
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
    if (input.avatar?.type === 'image') return reply.code(400).send({ error: 'AGENT_AVATAR_UPLOAD_REQUIRED' });
    if (!(await validateTools(request.user.workspaceId, input.toolIds ?? []))) return reply.code(400).send({ error: 'INVALID_OR_DISABLED_TOOL' });
    const result = await query('INSERT INTO agents(workspace_id,name,role,goal,instructions,personality,model,model_config,capabilities,status,tool_ids,memory_config,avatar_config,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *', [request.user.workspaceId, input.name, input.role, input.goal, input.instructions, input.personality ?? null, input.model, JSON.stringify(input.modelConfig), JSON.stringify(input.capabilities), input.status, JSON.stringify(input.toolIds ?? []), JSON.stringify(input.memoryConfig ?? { shortTerm: true, longTerm: true, knowledgeBase: true }), JSON.stringify(input.avatar ?? {}), request.user.sub]);
    await audit(request.user.workspaceId, request.user.sub, 'agent.created', 'agent', result.rows[0].id);
    return reply.code(201).send(result.rows[0]);
  }));
  app.post('/generate-prompt', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(agentPromptRequestSchema, request.body, reply); if (!input) return;
    const generated = await generateAgentPrompt(request.user.workspaceId, input);
    await audit(request.user.workspaceId, request.user.sub, 'agent.prompt_generated', 'workspace', request.user.workspaceId, {
      tone: input.tone,
      suppliedName: Boolean(input.name),
      suppliedRole: Boolean(input.role),
    });
    return generated;
  }));
  app.get('/:id/mcp-access', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const params = parse(z.object({ id: z.string().uuid() }), request.params, reply);
    if (!params) return;
    const access = await loadAgentMcpAccess(request.user.workspaceId, params.id);
    if (!access) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    return access;
  }));
  app.get('/:id', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const result = await query('SELECT * FROM agents WHERE id=$1 AND workspace_id=$2', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    return result.rows[0];
  }));
  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(agentInput.partial(), request.body, reply); if (!input) return;
    const agentId = (request.params as { id: string }).id;
    const existing = await query('SELECT id FROM agents WHERE id=$1 AND workspace_id=$2', [agentId, request.user.workspaceId]);
    if (!existing.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    if (input.toolIds && !(await validateTools(request.user.workspaceId, input.toolIds))) return reply.code(400).send({ error: 'INVALID_OR_DISABLED_TOOL' });
    if (input.avatar?.type === 'image' && !(await findAgentAvatar(request.user.workspaceId, agentId))) return reply.code(409).send({ error: 'AGENT_AVATAR_UPLOAD_REQUIRED' });
    const columns: Record<string, unknown> = { name: input.name, role: input.role, goal: input.goal, instructions: input.instructions, personality: input.personality, model: input.model, model_config: input.modelConfig && JSON.stringify(input.modelConfig), capabilities: input.capabilities && JSON.stringify(input.capabilities), status: input.status, tool_ids: input.toolIds && JSON.stringify(input.toolIds), memory_config: input.memoryConfig && JSON.stringify(input.memoryConfig), avatar_config: input.avatar && JSON.stringify(input.avatar) };
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (!entries.length) return reply.code(400).send({ error: 'NO_UPDATES' });
    const set = entries.map(([name], index) => `${name}=$${index + 1}`).join(', ');
    const values = entries.map(([, value]) => value);
    const result = await query(`UPDATE agents SET ${set},updated_at=now() WHERE id=$${values.length + 1} AND workspace_id=$${values.length + 2} RETURNING *`, [...values, agentId, request.user.workspaceId]);
    if (input.avatar && input.avatar.type !== 'image') {
      const removed = (await query<{ storage_key: string }>('DELETE FROM agent_avatar_assets WHERE agent_id=$1 AND workspace_id=$2 RETURNING storage_key', [agentId, request.user.workspaceId])).rows[0];
      if (removed) await agentAvatarStorage().delete(removed.storage_key).catch(() => undefined);
    }
    await audit(request.user.workspaceId, request.user.sub, 'agent.updated', 'agent', result.rows[0].id, { fields: entries.map(([name]) => name) });
    return result.rows[0];
  }));
  app.post('/:id/avatar/image', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const agentId = (request.params as { id: string }).id;
    const upload = await request.file({ limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    if (!upload) return reply.code(400).send({ error: 'AGENT_AVATAR_FILE_REQUIRED' });
    const asset = await saveAgentAvatar({ workspaceId: request.user.workspaceId, agentId, content: await upload.toBuffer(), mimeType: upload.mimetype, filename: upload.filename || 'avatar' });
    const agent = (await query('SELECT * FROM agents WHERE id=$1 AND workspace_id=$2', [agentId, request.user.workspaceId])).rows[0];
    await audit(request.user.workspaceId, request.user.sub, 'agent.avatar_uploaded', 'agent', agentId, { sizeBytes: asset.size_bytes });
    return reply.code(201).send(agent);
  }));
  app.get('/:id/avatar/image', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const asset = await findAgentAvatar(request.user.workspaceId, (request.params as { id: string }).id);
    if (!asset) return reply.code(404).send({ error: 'AGENT_AVATAR_NOT_FOUND' });
    const file = await agentAvatarStorage().open(asset.storage_key);
    reply.header('content-type', 'image/webp');
    reply.header('content-length', String(file.size));
    reply.header('cache-control', 'private, max-age=3600');
    reply.header('etag', `"${asset.sha256}"`);
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(file.stream);
  }));
  app.delete('/:id/avatar', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const agentId = (request.params as { id: string }).id;
    await deleteAgentAvatar(request.user.workspaceId, agentId);
    await audit(request.user.workspaceId, request.user.sub, 'agent.avatar_reset', 'agent', agentId);
    return reply.code(204).send();
  }));
  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const result = await query('UPDATE agents SET status=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3 RETURNING id', ['archived', (request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, 'agent.archived', 'agent', result.rows[0].id);
    return reply.code(204).send();
  }));
}
