import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db/client.js';
import { parse, asyncRoute } from '../lib/http.js';

const credentials = z.object({ email: z.string().email(), password: z.string().min(12), displayName: z.string().min(1).max(100).optional(), workspaceName: z.string().min(1).max(100).optional() });
const ONBOARDING_VERSION = 1;
const onboardingInput = z.object({ lastStep: z.number().int().min(1).max(6), action: z.enum(['progress', 'complete', 'skip']).default('progress') });

function onboardingState(user: { onboarding_completed: boolean; onboarding_version: number; onboarding_last_step: number; onboarding_completed_at: Date | null; onboarding_skipped_at: Date | null }) {
  return {
    version: ONBOARDING_VERSION,
    completed: user.onboarding_completed && user.onboarding_version === ONBOARDING_VERSION,
    lastStep: user.onboarding_version === ONBOARDING_VERSION ? user.onboarding_last_step : 1,
    completedAt: user.onboarding_completed_at,
    skippedAt: user.onboarding_skipped_at,
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', asyncRoute(async (request, reply) => {
    const input = parse(credentials.refine((data) => Boolean(data.displayName && data.workspaceName), 'displayName and workspaceName are required'), request.body, reply);
    if (!input) return;
    const existing = await query('SELECT id FROM users WHERE email=$1', [input.email.toLowerCase()]);
    if (existing.rowCount) return reply.code(409).send({ error: 'EMAIL_IN_USE' });
    const client = await (await import('../db/client.js')).db.connect();
    try {
      await client.query('BEGIN');
      const user = (await client.query<{ id: string }>('INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id', [input.email.toLowerCase(), await bcrypt.hash(input.password, 12), input.displayName])).rows[0];
      const workspace = (await client.query<{ id: string }>('INSERT INTO workspaces(name) VALUES($1) RETURNING id', [input.workspaceName])).rows[0];
      await client.query('INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace.id, user.id, 'owner']);
      await client.query('COMMIT');
      const accessToken = app.jwt.sign({ sub: user.id, workspaceId: workspace.id, role: 'owner' });
      return reply.code(201).send({ accessToken, user: { id: user.id, email: input.email, displayName: input.displayName, onboarding: { version: ONBOARDING_VERSION, completed: false, lastStep: 1, completedAt: null, skippedAt: null } }, workspace: { id: workspace.id, name: input.workspaceName } });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }));

  app.post('/login', asyncRoute(async (request, reply) => {
    const input = parse(credentials.pick({ email: true, password: true }), request.body, reply);
    if (!input) return;
    const result = await query<{ id: string; password_hash: string; display_name: string; workspace_id: string; workspace_name: string; role: 'owner' | 'admin' | 'member' | 'viewer'; onboarding_completed: boolean; onboarding_version: number; onboarding_last_step: number; onboarding_completed_at: Date | null; onboarding_skipped_at: Date | null }>(
      'SELECT u.id,u.password_hash,u.display_name,u.onboarding_completed,u.onboarding_version,u.onboarding_last_step,u.onboarding_completed_at,u.onboarding_skipped_at,m.workspace_id,w.name workspace_name,m.role FROM users u JOIN workspace_memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.email=$1 ORDER BY m.created_at LIMIT 1', [input.email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(input.password, user.password_hash))) return reply.code(401).send({ error: 'INVALID_CREDENTIALS' });
    return { accessToken: app.jwt.sign({ sub: user.id, workspaceId: user.workspace_id, role: user.role }), user: { id: user.id, email: input.email, displayName: user.display_name, onboarding: onboardingState(user) }, workspace: { id: user.workspace_id, name: user.workspace_name, role: user.role } };
  }));

  app.get('/me', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const result = await query('SELECT u.id,u.email,u.display_name,u.onboarding_completed,u.onboarding_version,u.onboarding_last_step,u.onboarding_completed_at,u.onboarding_skipped_at,w.id workspace_id,w.name workspace_name,m.role FROM users u JOIN workspace_memberships m ON m.user_id=u.id JOIN workspaces w ON w.id=m.workspace_id WHERE u.id=$1 AND w.id=$2', [request.user.sub, request.user.workspaceId]);
    const user = result.rows[0] as { onboarding_completed: boolean; onboarding_version: number; onboarding_last_step: number; onboarding_completed_at: Date | null; onboarding_skipped_at: Date | null } | undefined;
    return user && { ...user, onboarding: onboardingState(user) };
  }));

  app.get('/onboarding', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const result = await query<{ onboarding_completed: boolean; onboarding_version: number; onboarding_last_step: number; onboarding_completed_at: Date | null; onboarding_skipped_at: Date | null }>('SELECT onboarding_completed,onboarding_version,onboarding_last_step,onboarding_completed_at,onboarding_skipped_at FROM users WHERE id=$1', [request.user.sub]);
    return onboardingState(result.rows[0]);
  }));

  app.put('/onboarding', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(onboardingInput, request.body, reply); if (!input) return;
    const completed = input.action !== 'progress';
    const result = await query<{ onboarding_completed: boolean; onboarding_version: number; onboarding_last_step: number; onboarding_completed_at: Date | null; onboarding_skipped_at: Date | null }>(
      'UPDATE users SET onboarding_version=$1,onboarding_last_step=$2,onboarding_completed=$3,onboarding_completed_at=CASE WHEN $4 THEN now() ELSE onboarding_completed_at END,onboarding_skipped_at=CASE WHEN $5 THEN now() ELSE onboarding_skipped_at END WHERE id=$6 RETURNING onboarding_completed,onboarding_version,onboarding_last_step,onboarding_completed_at,onboarding_skipped_at',
      [ONBOARDING_VERSION, input.lastStep, completed, input.action === 'complete', input.action === 'skip', request.user.sub],
    );
    return onboardingState(result.rows[0]);
  }));

  app.post('/onboarding/restart', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const result = await query<{ onboarding_completed: boolean; onboarding_version: number; onboarding_last_step: number; onboarding_completed_at: Date | null; onboarding_skipped_at: Date | null }>('UPDATE users SET onboarding_completed=false,onboarding_version=$1,onboarding_last_step=1,onboarding_completed_at=NULL,onboarding_skipped_at=NULL WHERE id=$2 RETURNING onboarding_completed,onboarding_version,onboarding_last_step,onboarding_completed_at,onboarding_skipped_at', [ONBOARDING_VERSION, request.user.sub]);
    return onboardingState(result.rows[0]);
  }));
}
