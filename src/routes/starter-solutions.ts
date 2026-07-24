import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { asyncRoute, parse } from '../lib/http.js';
import { starterSolution, starterSolutions } from '../solutions/catalog.js';
import { installAgentSolution } from '../solutions/installer.js';

export async function starterSolutionRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, asyncRoute(async () => ({ data: starterSolutions })));

  app.get('/:slug', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const params = parse(z.object({ slug: z.string().min(2).max(100) }), request.params, reply);
    if (!params) return;
    return starterSolution(params.slug) ?? reply.code(404).send({ error: 'STARTER_SOLUTION_NOT_FOUND' });
  }));

  app.post('/:slug/install', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin', 'member']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(z.object({ slug: z.string().min(2).max(100) }), request.params, reply);
    const input = parse(z.object({
      allowDuplicate: z.boolean().default(false),
      toolIdsByAgentKey: z.record(
        z.string().min(1).max(80).regex(/^[a-z][a-z0-9_-]*$/),
        z.array(z.string().uuid()).max(10),
      ).refine((value) => Object.keys(value).length <= 8, 'Too many agent tool assignments').default({}),
    }), request.body ?? {}, reply);
    if (!params || !input) return;
    const solution = starterSolution(params.slug);
    if (!solution) return reply.code(404).send({ error: 'STARTER_SOLUTION_NOT_FOUND' });
    const installed = await installAgentSolution({
      workspaceId: request.user.workspaceId,
      userId: request.user.sub,
      solution,
      allowDuplicate: input.allowDuplicate,
      toolIdsByAgentKey: input.toolIdsByAgentKey,
    });
    await audit(request.user.workspaceId, request.user.sub, 'starter_solution.installed', 'agent_solution_installation', installed.id, {
      slug: solution.slug,
      version: solution.version,
      agentCount: solution.agents.length,
      assignedToolCount: Object.values(input.toolIdsByAgentKey ?? {}).flat().length,
    });
    return reply.code(201).send(installed);
  }));
}
