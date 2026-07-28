import { afterEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/client.js';
import { expireDueAuthorizations } from '../src/runtime/approval-expiry.js';

const enabled = process.env.RUN_INTEGRATION === 'true';

describe.runIf(enabled)('database-backed approval expiration', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let workspaceId = '';
  let userId = '';

  afterEach(async () => {
    if (workspaceId) await query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    if (userId) await query('DELETE FROM users WHERE id=$1', [userId]);
    workspaceId = '';
    userId = '';
  });

  it('expires a due task authorization and reconciles its task', async () => {
    userId = (await query<{ id: string }>(
      `INSERT INTO users(email,password_hash,display_name)
       VALUES($1,'integration-password-hash','Approval expiry integration') RETURNING id`,
      [`approval-expiry-${suffix}@example.test`],
    )).rows[0].id;
    workspaceId = (await query<{ id: string }>(
      'INSERT INTO workspaces(name) VALUES($1) RETURNING id',
      [`Approval expiry ${suffix}`],
    )).rows[0].id;
    const agentId = (await query<{ id: string }>(
      `INSERT INTO agents(workspace_id,name,role,goal,status,created_by)
       VALUES($1,'Approval expiry agent','Specialist','Exercise expiration','active',$2) RETURNING id`,
      [workspaceId, userId],
    )).rows[0].id;
    const taskId = (await query<{ id: string }>(
      `INSERT INTO tasks(workspace_id,agent_id,title,input,status,requested_by)
       VALUES($1,$2,'Expired authorization','{}'::jsonb,'awaiting_approval',$3) RETURNING id`,
      [workspaceId, agentId, userId],
    )).rows[0].id;
    const authorizationId = (await query<{ id: string }>(
      `INSERT INTO action_authorizations(
         workspace_id,subject_type,task_id,agent_id,action_key,adapter,resource_id,operation,
         risk_level,arguments_hash,status,requested_by,on_expiration,expires_at
       ) VALUES($1,'task',$2,$3,'approval-expiry-test','api',gen_random_uuid(),'write',
         'write',$4,'awaiting_confirmation',$5,'auto_reject',now()-interval '1 minute')
       RETURNING id`,
      [workspaceId, taskId, agentId, 'a'.repeat(64), userId],
    )).rows[0].id;

    await expect(expireDueAuthorizations(1)).resolves.toEqual({
      expiredIds: [authorizationId],
      escalatedIds: [],
      autoRejectedIds: [authorizationId],
      failedIds: [],
    });
    await expect(query<{ status: string; runtime_error: { code: string } }>(
      'SELECT status,runtime_error FROM action_authorizations WHERE id=$1',
      [authorizationId],
    )).resolves.toMatchObject({
      rows: [{ status: 'expired', runtime_error: { code: 'APPROVAL_EXPIRED' } }],
    });
    await expect(query<{ status: string }>('SELECT status FROM tasks WHERE id=$1', [taskId]))
      .resolves.toMatchObject({ rows: [{ status: 'cancelled' }] });
  });
});
