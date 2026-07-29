import type { PoolClient } from 'pg';
import { db } from '../db/client.js';

export type QueryRunner = Pick<PoolClient, 'query'>;

export async function insertAuditEvent(
  client: QueryRunner,
  input: {
    workspaceId: string;
    actorId: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const event = await client.query<{ id: string }>(
    `INSERT INTO audit_events(workspace_id,actor_id,action,entity_type,entity_id,metadata)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.workspaceId, input.actorId, input.action, input.entityType, input.entityId, input.metadata ?? {}],
  );
  return event.rows[0].id;
}

export async function audit(workspaceId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) {
  await insertAuditEvent(db, { workspaceId, actorId, action, entityType, entityId, metadata });
}

export async function auditWithClient(client: PoolClient, workspaceId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) {
  await insertAuditEvent(client, { workspaceId, actorId, action, entityType, entityId, metadata });
}
