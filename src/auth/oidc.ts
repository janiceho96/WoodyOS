import type { FastifyInstance } from 'fastify';
import oauthPlugin from '@fastify/oauth2';
import bcrypt from 'bcryptjs';
import { db, query } from '../db/client.js';

type OidcClient = { getAccessTokenFromAuthorizationCodeFlow: (request: unknown, reply: unknown) => Promise<{ token: { access_token: string } }>; userinfo: (token: string) => Promise<Record<string, unknown>> };

export async function registerOidc(app: FastifyInstance) {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return false;
  const callbackUri = process.env.OIDC_CALLBACK_URL ?? `${process.env.API_PUBLIC_URL ?? 'http://localhost:3001'}/v1/auth/oidc/callback`;
  await app.register(oauthPlugin, { name: 'oidc', scope: ['openid', 'profile', 'email'], credentials: { client: { id: clientId, secret: clientSecret } }, startRedirectPath: '/v1/auth/oidc/login', callbackUri, discovery: { issuer } });
  app.get('/v1/auth/oidc/callback', async (request, reply) => {
    const client = (app as unknown as { oidc: OidcClient }).oidc;
    const { token } = await client.getAccessTokenFromAuthorizationCodeFlow(request, reply);
    const profile = await client.userinfo(token.access_token);
    const subject = typeof profile.sub === 'string' ? profile.sub : null;
    const email = typeof profile.email === 'string' ? profile.email.toLowerCase() : null;
    if (!subject || !email) return reply.code(400).send({ error: 'OIDC_PROFILE_MISSING_SUBJECT_OR_EMAIL' });
    const name = typeof profile.name === 'string' ? profile.name : email.split('@')[0];
    const existing = await query<{ user_id: string; workspace_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>('SELECT o.user_id,m.workspace_id,m.role FROM oauth_accounts o JOIN workspace_memberships m ON m.user_id=o.user_id WHERE o.issuer=$1 AND o.subject=$2 ORDER BY m.created_at LIMIT 1', [issuer, subject]);
    let userId: string; let workspaceId: string; let role: 'owner' | 'admin' | 'member' | 'viewer';
    if (existing.rowCount) ({ user_id: userId, workspace_id: workspaceId, role } = existing.rows[0]);
    else {
      const connection = await db.connect();
      try {
        await connection.query('BEGIN');
        let user = (await connection.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [email])).rows[0];
        if (!user) user = (await connection.query<{ id: string }>('INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id', [email, await bcrypt.hash(crypto.randomUUID(), 12), name])).rows[0];
        userId = user.id;
        const membership = (await connection.query<{ workspace_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>('SELECT workspace_id,role FROM workspace_memberships WHERE user_id=$1 ORDER BY created_at LIMIT 1', [userId])).rows[0];
        if (membership) ({ workspace_id: workspaceId, role } = membership);
        else {
          const workspace = (await connection.query<{ id: string }>('INSERT INTO workspaces(name) VALUES($1) RETURNING id', [`${name}'s Workspace`])).rows[0];
          workspaceId = workspace.id; role = 'owner';
          await connection.query('INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, userId, role]);
        }
        await connection.query('INSERT INTO oauth_accounts(user_id,issuer,subject,email) VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject) DO NOTHING', [userId, issuer, subject, email]);
        await connection.query('COMMIT');
      } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    }
    return { accessToken: app.jwt.sign({ sub: userId, workspaceId, role }), user: { id: userId, email, displayName: name }, workspace: { id: workspaceId, role } };
  });
  return true;
}
