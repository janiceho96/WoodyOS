import type { FastifyInstance } from 'fastify';
import { query } from '../db/client.js';
import { asyncRoute } from '../lib/http.js';
export async function auditRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request) => ({ data: (await query('SELECT a.*,u.display_name actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.workspace_id=$1 ORDER BY a.created_at DESC LIMIT 200', [request.user.workspaceId])).rows })));
}
