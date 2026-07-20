import type { FastifyInstance, FastifyRequest } from 'fastify';
import { query } from '../db/client.js';

export async function authPlugin(app: FastifyInstance) {
  app.decorate('authenticate', async (request: FastifyRequest) => {
    await request.jwtVerify();
    const membership = await query<{ role: 'owner' | 'admin' | 'member' | 'viewer' }>('SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [request.user.workspaceId, request.user.sub]);
    if (!membership.rowCount) throw Object.assign(new Error('FORBIDDEN'), { statusCode: 403 });
  });
  app.decorate('authorize', async (request: FastifyRequest, roles: Array<'owner' | 'admin' | 'member' | 'viewer'>) => {
    await app.authenticate(request);
    const membership = await query<{ role: 'owner' | 'admin' | 'member' | 'viewer' }>('SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [request.user.workspaceId, request.user.sub]);
    if (!membership.rowCount || !roles.includes(membership.rows[0].role)) throw Object.assign(new Error('FORBIDDEN'), { statusCode: 403 });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    authorize: (request: FastifyRequest, roles: Array<'owner' | 'admin' | 'member' | 'viewer'>) => Promise<void>;
  }
}
