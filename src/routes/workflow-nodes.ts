import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicWorkflowNodeCatalog } from '../workflows/registry.js';
import { asyncRoute, parse } from '../lib/http.js';
import { buildQualityLoopDefinition } from '../workflows/quality-loop.js';

const qualityLoopInput = z.object({
  workerAgentId: z.string().uuid(),
  graderAgentId: z.string().uuid(),
  revisionStrategy: z.enum(['same_worker', 'dedicated_agent']),
  revisionAgentId: z.string().uuid().optional(),
  maximumRevisions: z.number().int().min(0).max(99),
  passingScore: z.number().min(0).max(100),
  onLimit: z.enum(['return_best', 'human_review', 'fail']),
}).superRefine((value, context) => {
  if (value.revisionStrategy === 'dedicated_agent' && !value.revisionAgentId) {
    context.addIssue({ code: 'custom', path: ['revisionAgentId'], message: 'Choose a dedicated revision agent' });
  }
});

export async function workflowNodeRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, async () => ({
    version: 1,
    data: publicWorkflowNodeCatalog(),
  }));
  app.post('/quality-loop-template', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(qualityLoopInput, request.body, reply); if (!input) return;
    return buildQualityLoopDefinition(input);
  }));
}
