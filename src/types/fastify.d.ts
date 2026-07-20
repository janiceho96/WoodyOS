import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; workspaceId: string; role: 'owner' | 'admin' | 'member' | 'viewer' };
    user: { sub: string; workspaceId: string; role: 'owner' | 'admin' | 'member' | 'viewer' };
  }
}
