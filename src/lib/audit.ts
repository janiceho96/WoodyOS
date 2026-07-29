import type { PoolClient } from 'pg';
import { query } from '../db/client.js';

const insertAuditEvent = `INSERT INTO audit_events(workspace_id, actor_id, action, entity_type, entity_id, metadata) VALUES($1,$2,$3,$4,$5,$6)`;

export async function audit(workspaceId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) {
  await query(insertAuditEvent, [workspaceId, actorId, action, entityType, entityId, metadata]);
}

export async function auditWithClient(client: PoolClient, workspaceId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) {
  await client.query(insertAuditEvent, [workspaceId, actorId, action, entityType, entityId, metadata]);
}
