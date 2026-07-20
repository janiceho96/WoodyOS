import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';

const teamInput = z.object({ name: z.string().min(2).max(120), description: z.string().max(2000).default('') });
export async function teamRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const teams = await query('SELECT * FROM agent_teams WHERE workspace_id=$1 ORDER BY name', [request.user.workspaceId]);
    const memberships = await query('SELECT tm.team_id,tm.agent_id,tm.manager_agent_id,a.name,a.role FROM team_memberships tm JOIN agents a ON a.id=tm.agent_id WHERE a.workspace_id=$1', [request.user.workspaceId]);
    return { data: teams.rows.map((team) => ({ ...team, members: memberships.rows.filter((member) => member.team_id === team.id) })) };
  }));
  app.post('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(teamInput, request.body, reply); if (!input) return;
    const team = (await query('INSERT INTO agent_teams(workspace_id,name,description) VALUES($1,$2,$3) RETURNING *', [request.user.workspaceId, input.name, input.description])).rows[0];
    await audit(request.user.workspaceId, request.user.sub, 'team.created', 'agent_team', team.id);
    return reply.code(201).send(team);
  }));
  app.put('/:id/members/:agentId', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const input = parse(z.object({ managerAgentId: z.string().uuid().nullable().optional() }), request.body, reply); if (!input) return;
    const params = request.params as { id: string; agentId: string };
    const team = await query('SELECT id FROM agent_teams WHERE id=$1 AND workspace_id=$2', [params.id, request.user.workspaceId]);
    const agent = await query('SELECT id FROM agents WHERE id=$1 AND workspace_id=$2', [params.agentId, request.user.workspaceId]);
    if (!team.rowCount || !agent.rowCount) return reply.code(404).send({ error: 'TEAM_OR_AGENT_NOT_FOUND' });
    const membership = await query('INSERT INTO team_memberships(team_id,agent_id,manager_agent_id) VALUES($1,$2,$3) ON CONFLICT(team_id,agent_id) DO UPDATE SET manager_agent_id=EXCLUDED.manager_agent_id RETURNING *', [params.id, params.agentId, input.managerAgentId ?? null]);
    return membership.rows[0];
  }));
  app.delete('/:id/members/:agentId', { preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']) }, asyncRoute(async (request, reply) => {
    const params = request.params as { id: string; agentId: string };
    const result = await query('DELETE FROM team_memberships WHERE team_id=$1 AND agent_id=$2 RETURNING team_id', [params.id, params.agentId]);
    return result.rowCount ? reply.code(204).send() : reply.code(404).send({ error: 'TEAM_MEMBERSHIP_NOT_FOUND' });
  }));
  app.delete('/:id', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const result = await query('DELETE FROM agent_teams WHERE id=$1 AND workspace_id=$2 RETURNING id', [(request.params as { id: string }).id, request.user.workspaceId]);
    if (!result.rowCount) return reply.code(404).send({ error: 'TEAM_NOT_FOUND' });
    await audit(request.user.workspaceId, request.user.sub, 'team.deleted', 'agent_team', result.rows[0].id);
    return reply.code(204).send();
  }));
}
