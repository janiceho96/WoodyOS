import type { FastifyInstance } from 'fastify';
import { mcpCatalogRoutes } from './catalog.js';
import { mcpAccessRoutes } from './access.js';
import { mcpConnectionRoutes } from './connections.js';
import { mcpToolCallRoutes } from './tool-calls.js';
import { mcpOAuthRoutes } from './oauth.js';

export async function mcpRoutes(app: FastifyInstance) {
  await app.register(mcpCatalogRoutes, { prefix: '/catalog' });
  await app.register(mcpConnectionRoutes, { prefix: '/connections' });
  await app.register(mcpAccessRoutes, { prefix: '/connections' });
  await app.register(mcpToolCallRoutes, { prefix: '/tool-calls' });
  await app.register(mcpOAuthRoutes);
}
