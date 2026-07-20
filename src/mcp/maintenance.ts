import { query } from '../db/client.js';
import { testMcpConnection } from './connections.js';
import { syncMcpRegistry } from './registry/sync.js';

let registryTimer: NodeJS.Timeout | undefined;
let healthTimer: NodeJS.Timeout | undefined;

async function registryDue() {
  const intervalHours = Math.max(1, Number(process.env.MCP_REGISTRY_SYNC_INTERVAL_HOURS ?? 6));
  const state = await query<{ due: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1 FROM mcp_registry_sync_state
       WHERE status='succeeded' AND last_successful_sync_at > now() - ($1 * interval '1 hour')
     ) due`,
    [intervalHours],
  );
  if (state.rows[0]?.due) await syncMcpRegistry();
}

async function healthDue() {
  const connections = await query<{ id: string; workspace_id: string }>(
    `SELECT id,workspace_id FROM mcp_connections
     WHERE enabled=true AND deleted_at IS NULL
     AND (
       last_health_check_at IS NULL
       OR (consecutive_failures < 3 AND last_health_check_at < now() - interval '15 minutes')
       OR (consecutive_failures >= 3 AND last_health_check_at < now() - interval '1 hour')
     )
     ORDER BY COALESCE(last_health_check_at,'epoch') LIMIT 20`,
  );
  for (const connection of connections.rows) {
    await testMcpConnection(connection.workspace_id, connection.id).catch(() => undefined);
  }
}

export function startMcpMaintenance() {
  const registryIntervalMs = Math.max(1, Number(process.env.MCP_REGISTRY_SYNC_INTERVAL_HOURS ?? 6)) * 60 * 60 * 1_000;
  registryTimer = setInterval(() => void registryDue().catch((error) => console.error('MCP Registry sync failed', error)), registryIntervalMs);
  healthTimer = setInterval(() => void healthDue().catch((error) => console.error('MCP health checks failed', error)), 5 * 60 * 1_000);
  registryTimer.unref();
  healthTimer.unref();
  const initial = setTimeout(() => {
    void registryDue().catch((error) => console.error('Initial MCP Registry sync failed', error));
    void healthDue().catch((error) => console.error('Initial MCP health checks failed', error));
  }, 30_000);
  initial.unref();
}

export function stopMcpMaintenance() {
  if (registryTimer) clearInterval(registryTimer);
  if (healthTimer) clearInterval(healthTimer);
  registryTimer = undefined;
  healthTimer = undefined;
}
