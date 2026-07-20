import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { asyncRoute, parse } from '../lib/http.js';

const memoryInput = z.object({ agentId: z.string().uuid().nullable().optional(), kind: z.enum(['conversation', 'knowledge', 'user']), content: z.string().min(1).max(50000), importance: z.number().min(0).max(1).default(0.5), metadata: z.record(z.unknown()).default({}) });
export async function memoryRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => ({ data: (await query('SELECT id,agent_id,kind,content,importance,metadata,created_at,updated_at FROM memories WHERE workspace_id=$1 ORDER BY importance DESC,created_at DESC LIMIT 100', [request.user.workspaceId])).rows })));
  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(memoryInput, request.body, reply); if (!input) return;
    if (input.agentId) { const agent = await query('SELECT 1 FROM agents WHERE id=$1 AND workspace_id=$2', [input.agentId, request.user.workspaceId]); if (!agent.rowCount) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' }); }
    const result = await query('INSERT INTO memories(workspace_id,agent_id,user_id,kind,content,importance,metadata) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,agent_id,kind,content,importance,metadata,created_at', [request.user.workspaceId, input.agentId ?? null, request.user.sub, input.kind, input.content, input.importance, JSON.stringify(input.metadata)]);
    return reply.code(201).send(result.rows[0]);
  }));
  app.patch('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(memoryInput.pick({ content: true, importance: true, metadata: true }).partial(), request.body, reply); if (!input) return;
    const entries: Array<[string, unknown]> = [];
    if (input.content !== undefined) entries.push(['content', input.content]);
    if (input.importance !== undefined) entries.push(['importance', input.importance]);
    if (input.metadata !== undefined) entries.push(['metadata', JSON.stringify(input.metadata)]);
    if (!entries.length) return reply.code(400).send({ error: 'NO_UPDATES' });
    const values = entries.map(([, value]) => value);
    const set = entries.map(([field], index) => `${field}=$${index + 1}`).join(', ');
    const result = await query(`UPDATE memories SET ${set},updated_at=now() WHERE id=$${values.length + 1} AND workspace_id=$${values.length + 2} RETURNING id,agent_id,kind,content,importance,metadata,updated_at`, [...values, (request.params as { id: string }).id, request.user.workspaceId]);
    return result.rowCount ? result.rows[0] : reply.code(404).send({ error: 'MEMORY_NOT_FOUND' });
  }));
  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const result = await query('DELETE FROM memories WHERE id=$1 AND workspace_id=$2 RETURNING id', [(request.params as { id: string }).id, request.user.workspaceId]);
    return result.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'MEMORY_NOT_FOUND' });
  }));
}
