import { db } from '../../db/client.js';
import { McpError, humanMcpError } from '../errors.js';
import type { McpRegistryEntry, McpRegistryHeader } from '../types.js';
import { DEFAULT_MCP_REGISTRY_URL, fetchRegistryPage } from './client.js';

const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';
const SYNC_LOCK_ID = 1_904_270_061;

type OfficialMetadata = {
  status?: string;
  publishedAt?: string;
  updatedAt?: string;
  isLatest?: boolean;
};

function officialMetadata(entry: McpRegistryEntry): OfficialMetadata {
  const value = entry._meta?.[OFFICIAL_META_KEY];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as OfficialMetadata : {};
}

function catalogStatus(value: unknown) {
  if (value === 'active' || value === 'deprecated' || value === 'deleted') return value;
  return 'unknown';
}

function safeIcon(entry: McpRegistryEntry) {
  const icon = entry.server.icons?.find((candidate) => {
    if (!candidate.src) return false;
    try {
      const url = new URL(candidate.src);
      return url.protocol === 'https:' && candidate.mimeType !== 'image/svg+xml';
    } catch {
      return false;
    }
  });
  return icon?.src ?? null;
}

function safeHeaderInputs(headers: McpRegistryHeader[] | undefined) {
  return (headers ?? [])
    .filter(({ name }) => name.length <= 200 && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
    .map(({ name, description, isRequired, isSecret }) => ({
      name,
      description: description ?? '',
      isRequired: Boolean(isRequired),
      isSecret: Boolean(isSecret),
    }));
}

export async function syncMcpRegistry(input: {
  forceFull?: boolean;
  fetchPage?: typeof fetchRegistryPage;
} = {}) {
  const registryUrl = process.env.MCP_REGISTRY_URL ?? DEFAULT_MCP_REGISTRY_URL;
  const client = await db.connect();
  const startedAt = new Date();
  let locked = false;
  let serversSeen = 0;
  let serversUpdated = 0;
  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) locked', [SYNC_LOCK_ID]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) throw new McpError('MCP_REGISTRY_SYNC_RUNNING', 'An MCP Registry synchronization is already running', 409);

    const existing = await client.query<{ last_successful_sync_at: Date | null }>(
      'SELECT last_successful_sync_at FROM mcp_registry_sync_state WHERE registry_url=$1',
      [registryUrl],
    );
    const updatedSince = input.forceFull ? undefined : existing.rows[0]?.last_successful_sync_at?.toISOString();
    await client.query(
      `INSERT INTO mcp_registry_sync_state(registry_url,status,last_started_at,last_error_code,last_error_message,updated_at)
       VALUES($1,'running',$2,NULL,NULL,now())
       ON CONFLICT(registry_url) DO UPDATE SET status='running',last_started_at=$2,last_error_code=NULL,last_error_message=NULL,updated_at=now()`,
      [registryUrl, startedAt],
    );

    let cursor: string | undefined;
    const fetchPage = input.fetchPage ?? fetchRegistryPage;
    do {
      const page = await fetchPage({ cursor, updatedSince, includeDeleted: Boolean(updatedSince) });
      await client.query('BEGIN');
      try {
        for (const entry of page.servers) {
          serversSeen++;
          const metadata = officialMetadata(entry);
          const server = entry.server;
          const row = await client.query<{ id: string }>(
            `INSERT INTO mcp_catalog_servers(
               registry_name,version,title,description,website_url,repository_url,repository_source,repository_id,
               icon_url,registry_status,is_latest,raw_metadata,registry_published_at,registry_updated_at,synced_at,updated_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())
             ON CONFLICT(registry_name,version) DO UPDATE SET
               title=EXCLUDED.title,description=EXCLUDED.description,website_url=EXCLUDED.website_url,
               repository_url=EXCLUDED.repository_url,repository_source=EXCLUDED.repository_source,
               repository_id=EXCLUDED.repository_id,icon_url=EXCLUDED.icon_url,registry_status=EXCLUDED.registry_status,
               is_latest=EXCLUDED.is_latest,raw_metadata=EXCLUDED.raw_metadata,
               registry_published_at=EXCLUDED.registry_published_at,registry_updated_at=EXCLUDED.registry_updated_at,
               synced_at=now(),updated_at=now()
             RETURNING id`,
            [
              server.name,
              server.version,
              server.title ?? server.name,
              server.description ?? '',
              server.websiteUrl ?? null,
              server.repository?.url ?? null,
              server.repository?.source ?? null,
              server.repository?.id ?? null,
              safeIcon(entry),
              catalogStatus(metadata.status),
              metadata.isLatest ?? true,
              JSON.stringify(entry._meta ?? {}),
              metadata.publishedAt ?? null,
              metadata.updatedAt ?? null,
            ],
          );
          const serverId = row.rows[0].id;
          await client.query('DELETE FROM mcp_catalog_endpoints WHERE catalog_server_id=$1', [serverId]);
          for (const [position, remote] of (server.remotes ?? []).entries()) {
            let endpoint: URL;
            try {
              endpoint = new URL(remote.url);
            } catch {
              continue;
            }
            const supported = remote.type === 'streamable-http' && endpoint.protocol === 'https:';
            await client.query(
              `INSERT INTO mcp_catalog_endpoints(
                 catalog_server_id,transport,endpoint_url,header_inputs,endpoint_variables,position,supported
               ) VALUES($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT(catalog_server_id,transport,endpoint_url) DO UPDATE SET
               header_inputs=EXCLUDED.header_inputs,endpoint_variables=EXCLUDED.endpoint_variables,
               position=LEAST(mcp_catalog_endpoints.position,EXCLUDED.position),
               supported=EXCLUDED.supported,updated_at=now()`,
              [
                serverId,
                remote.type,
                remote.url,
                JSON.stringify(safeHeaderInputs(remote.headers)),
                JSON.stringify(remote.variables ?? {}),
                position,
                supported,
              ],
            );
          }
          serversUpdated++;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      cursor = page.metadata.nextCursor;
    } while (cursor);

    await client.query(
      `UPDATE mcp_registry_sync_state SET status='succeeded',last_successful_sync_at=now(),
       servers_seen=$2,servers_updated=$3,last_error_code=NULL,last_error_message=NULL,updated_at=now()
       WHERE registry_url=$1`,
      [registryUrl, serversSeen, serversUpdated],
    );
    return { status: 'succeeded' as const, serversSeen, serversUpdated, incremental: Boolean(updatedSince) };
  } catch (cause) {
    const error = humanMcpError(cause);
    await client.query(
      `INSERT INTO mcp_registry_sync_state(
         registry_url,status,last_started_at,last_error_code,last_error_message,servers_seen,servers_updated,updated_at
       ) VALUES($1,'failed',$2,$3,$4,$5,$6,now())
       ON CONFLICT(registry_url) DO UPDATE SET status='failed',last_error_code=$3,last_error_message=$4,
       servers_seen=$5,servers_updated=$6,updated_at=now()`,
      [registryUrl, startedAt, error.code, error.message.slice(0, 1_000), serversSeen, serversUpdated],
    ).catch(() => undefined);
    throw error;
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
