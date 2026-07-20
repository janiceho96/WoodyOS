import { createHash } from 'node:crypto';
import { db, query } from '../db/client.js';
import type { EncryptedPayload } from '../lib/crypto.js';
import { decryptMcpCredentials, requestHeaders } from './credentials.js';
import { McpError } from './errors.js';
import { mcpTransport } from './transports/index.js';
import type { McpDiscoveredTool } from './transports/adapter.js';
import { oauthProviderForRuntime } from './oauth.js';

export type McpConnectionRecord = {
  id: string;
  workspace_id: string;
  name: string;
  transport: string;
  endpoint_url: string;
  auth_type: string;
  encrypted_credentials: EncryptedPayload | null;
  enabled: boolean;
  health_status: string;
};

export async function loadMcpConnection(workspaceId: string, connectionId: string) {
  const result = await query<McpConnectionRecord>(
    `SELECT id,workspace_id,name,transport,endpoint_url,auth_type,encrypted_credentials,
     enabled,health_status FROM mcp_connections
     WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
    [connectionId, workspaceId],
  );
  if (!result.rowCount) throw new McpError('MCP_CONNECTION_NOT_FOUND', 'MCP connection not found', 404);
  return result.rows[0];
}

export async function openMcpConnection(connection: McpConnectionRecord) {
  const credentials = decryptMcpCredentials(
    connection.workspace_id,
    connection.id,
    connection.encrypted_credentials,
  );
  const headers = connection.auth_type === 'oauth2' ? {} : requestHeaders(connection.auth_type, credentials);
  const authProvider = connection.auth_type === 'oauth2'
    ? oauthProviderForRuntime(connection)
    : undefined;
  return mcpTransport(connection.transport).connect({
    endpointUrl: connection.endpoint_url,
    headers,
    authProvider,
  });
}

function riskSuggestion(tool: McpDiscoveredTool) {
  if (tool.annotations.destructiveHint === true) return 'destructive';
  if (tool.annotations.readOnlyHint === true) return 'read';
  if (tool.annotations.openWorldHint === true) return 'external_write';
  return 'unknown';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function schemaHash(tool: McpDiscoveredTool) {
  return createHash('sha256').update(stableJson({
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  })).digest('hex');
}

function humanConnectionError(error: unknown) {
  if (error instanceof McpError) return error;
  const message = error instanceof Error ? error.message : 'The MCP server could not be reached';
  const safeMessage = message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(token|secret|password|api[-_]?key)=([^&\s]+)/gi, '$1=[redacted]');
  return new McpError('MCP_CONNECTION_FAILED', safeMessage.slice(0, 500), 502, { cause: error });
}

export async function testMcpConnection(workspaceId: string, connectionId: string) {
  const connection = await loadMcpConnection(workspaceId, connectionId);
  const started = Date.now();
  try {
    const session = await openMcpConnection(connection);
    try {
      await session.ping();
      const tools = await session.listTools();
      await query(
        `UPDATE mcp_connections SET health_status='healthy',consecutive_failures=0,last_health_check_at=now(),
         last_success_at=now(),last_error_code=NULL,last_error_message=NULL,server_info=$1,server_capabilities=$2,updated_at=now()
         WHERE id=$3 AND workspace_id=$4`,
        [JSON.stringify(session.info.serverInfo), JSON.stringify(session.info.capabilities), connectionId, workspaceId],
      );
      return {
        status: 'healthy' as const,
        durationMs: Date.now() - started,
        toolsAvailable: tools.length,
        serverInfo: session.info.serverInfo,
      };
    } finally {
      await session.close();
    }
  } catch (cause) {
    const error = humanConnectionError(cause);
    await query(
      `UPDATE mcp_connections SET health_status=CASE WHEN $1 IN ('MCP_AUTH_REQUIRED','MCP_OAUTH_REQUIRED') THEN 'auth_required' ELSE 'unhealthy' END,
       consecutive_failures=consecutive_failures+1,last_health_check_at=now(),last_error_code=$1,last_error_message=$2,updated_at=now()
       WHERE id=$3 AND workspace_id=$4`,
      [error.code, error.message, connectionId, workspaceId],
    );
    throw error;
  }
}

export async function discoverMcpTools(workspaceId: string, connectionId: string) {
  const connection = await loadMcpConnection(workspaceId, connectionId);
  let session;
  try {
    session = await openMcpConnection(connection);
    const tools = await session.listTools();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const discoveredNames: string[] = [];
      for (const tool of tools) {
        discoveredNames.push(tool.name);
        await client.query(
          `INSERT INTO mcp_connection_tools(
             connection_id,remote_name,title,description,input_schema,output_schema,annotations,risk_level,schema_hash,discovered_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
           ON CONFLICT(connection_id,remote_name) DO UPDATE SET
             title=EXCLUDED.title,description=EXCLUDED.description,input_schema=EXCLUDED.input_schema,
             output_schema=EXCLUDED.output_schema,annotations=EXCLUDED.annotations,schema_hash=EXCLUDED.schema_hash,
             discovered_at=now(),updated_at=now()`,
          [
            connectionId,
            tool.name,
            tool.title ?? null,
            tool.description,
            JSON.stringify(tool.inputSchema),
            tool.outputSchema ? JSON.stringify(tool.outputSchema) : null,
            JSON.stringify(tool.annotations),
            riskSuggestion(tool),
            schemaHash(tool),
          ],
        );
      }
      if (discoveredNames.length) {
        await client.query(
          'UPDATE mcp_connection_tools SET enabled=false,updated_at=now() WHERE connection_id=$1 AND NOT(remote_name = ANY($2::text[]))',
          [connectionId, discoveredNames],
        );
      } else {
        await client.query('UPDATE mcp_connection_tools SET enabled=false,updated_at=now() WHERE connection_id=$1', [connectionId]);
      }
      await client.query(
        `UPDATE mcp_connections SET health_status='healthy',consecutive_failures=0,last_health_check_at=now(),
         last_success_at=now(),last_error_code=NULL,last_error_message=NULL,server_info=$1,server_capabilities=$2,updated_at=now()
         WHERE id=$3 AND workspace_id=$4`,
        [JSON.stringify(session.info.serverInfo), JSON.stringify(session.info.capabilities), connectionId, workspaceId],
      );
      await client.query('COMMIT');
      return { discovered: tools.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (cause) {
    const error = humanConnectionError(cause);
    await query(
      `UPDATE mcp_connections SET health_status=CASE WHEN $1 IN ('MCP_AUTH_REQUIRED','MCP_OAUTH_REQUIRED') THEN 'auth_required' ELSE 'unhealthy' END,
       consecutive_failures=consecutive_failures+1,last_health_check_at=now(),last_error_code=$1,last_error_message=$2,updated_at=now()
       WHERE id=$3 AND workspace_id=$4`,
      [error.code, error.message, connectionId, workspaceId],
    );
    throw error;
  } finally {
    await session?.close().catch(() => undefined);
  }
}
