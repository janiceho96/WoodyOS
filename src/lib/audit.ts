import { query } from '../db/client.js';

export async function audit(workspaceId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown> = {}) {
  await query(
    'INSERT INTO audit_events(workspace_id, actor_id, action, entity_type, entity_id, metadata) VALUES($1,$2,$3,$4,$5,$6)',
    [workspaceId, actorId, action, entityType, entityId, metadata],
  );
}
