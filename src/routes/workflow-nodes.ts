import type { FastifyInstance } from 'fastify';
import { publicWorkflowNodeCatalog } from '../workflows/registry.js';

export async function workflowNodeRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: app.authenticate }, async () => ({
    version: 1,
    data: publicWorkflowNodeCatalog(),
  }));
}

