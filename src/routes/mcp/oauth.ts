import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { asyncRoute, parse } from '../../lib/http.js';
import { finishMcpOAuth, oauthErrorRedirect, startMcpOAuth } from '../../mcp/oauth.js';

const idParams = z.object({ id: z.string().uuid() });
const callbackQuery = z.object({
  code: z.string().min(1).max(8_000),
  state: z.string().min(20).max(1_000),
});

export async function mcpOAuthRoutes(app: FastifyInstance) {
  app.post('/connections/:id/auth/start', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(idParams, request.params, reply);
    if (!params) return;
    const authorizationUrl = await startMcpOAuth(request.user.workspaceId, params.id);
    await audit(request.user.workspaceId, request.user.sub, 'mcp.oauth.started', 'mcp_connection', params.id);
    return { authorizationUrl };
  }));

  app.get('/oauth/callback', async (request, reply) => {
    const parsed = callbackQuery.safeParse(request.query);
    if (!parsed.success) return reply.redirect(oauthErrorRedirect().toString());
    try {
      const result = await finishMcpOAuth(parsed.data.code, parsed.data.state);
      await audit(result.connection.workspace_id, null, 'mcp.oauth.completed', 'mcp_connection', result.connection.id);
      return reply.redirect(result.redirectUrl.toString());
    } catch (error) {
      request.log.error(error);
      return reply.redirect(oauthErrorRedirect().toString());
    }
  });
}
