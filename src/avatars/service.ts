import { createHash, randomUUID } from 'node:crypto';
import { db, query } from '../db/client.js';
import { agentAvatarStorage } from './storage.js';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

type AvatarAsset = {
  id: string;
  workspace_id: string;
  agent_id: string;
  storage_provider: string;
  storage_key: string;
  mime_type: 'image/webp';
  size_bytes: number;
  sha256: string;
  original_filename: string | null;
};

export function validateAgentAvatarUpload(mimeType: string, size: number) {
  if (!ACCEPTED_TYPES.has(mimeType)) throw Object.assign(new Error('AGENT_AVATAR_TYPE_UNSUPPORTED'), { statusCode: 415 });
  if (!size || size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('AGENT_AVATAR_TOO_LARGE'), { statusCode: 413 });
}

async function normalizeAvatar(content: Buffer, mimeType: string, filename: string) {
  const bytes = new Uint8Array(content.length);
  bytes.set(content);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), filename);
  const response = await fetch(`${(process.env.EXTRACTOR_URL ?? 'http://localhost:8000').replace(/\/$/, '')}/avatar`, {
    method: 'POST',
    headers: process.env.EXTRACTOR_TOKEN ? { authorization: `Bearer ${process.env.EXTRACTOR_TOKEN}` } : {},
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error('AGENT_AVATAR_PROCESSING_FAILED'), { statusCode: 422 });
  }
  const normalized = Buffer.from(await response.arrayBuffer());
  if (!normalized.length || normalized.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('AGENT_AVATAR_PROCESSING_FAILED'), { statusCode: 422 });
  return normalized;
}

export async function saveAgentAvatar(input: { workspaceId: string; agentId: string; content: Buffer; mimeType: string; filename: string }) {
  validateAgentAvatarUpload(input.mimeType, input.content.length);
  const agent = (await query<{ id: string }>('SELECT id FROM agents WHERE id=$1 AND workspace_id=$2', [input.agentId, input.workspaceId])).rows[0];
  if (!agent) throw Object.assign(new Error('AGENT_NOT_FOUND'), { statusCode: 404 });

  const normalized = await normalizeAvatar(input.content, input.mimeType, input.filename);
  const key = `${input.workspaceId}/${randomUUID()}.webp`;
  const storage = agentAvatarStorage();
  await storage.put(key, normalized);
  const previous = (await query<Pick<AvatarAsset, 'storage_key'>>('SELECT storage_key FROM agent_avatar_assets WHERE agent_id=$1 AND workspace_id=$2', [input.agentId, input.workspaceId])).rows[0];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const asset = (await client.query<AvatarAsset>(
      `INSERT INTO agent_avatar_assets(workspace_id,agent_id,storage_provider,storage_key,mime_type,size_bytes,sha256,original_filename)
       VALUES($1,$2,$3,$4,'image/webp',$5,$6,$7)
       ON CONFLICT(agent_id) DO UPDATE SET storage_provider=excluded.storage_provider,storage_key=excluded.storage_key,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,sha256=excluded.sha256,original_filename=excluded.original_filename,updated_at=now()
       RETURNING *`,
      [input.workspaceId, input.agentId, storage.provider, key, normalized.length, createHash('sha256').update(normalized).digest('hex'), input.filename.slice(0, 260)],
    )).rows[0];
    await client.query(`UPDATE agents SET avatar_config='{"type":"image","value":"uploaded"}'::jsonb,updated_at=now() WHERE id=$1 AND workspace_id=$2`, [input.agentId, input.workspaceId]);
    await client.query('COMMIT');
    if (previous?.storage_key && previous.storage_key !== key) await storage.delete(previous.storage_key).catch(() => undefined);
    return asset;
  } catch (error) {
    await client.query('ROLLBACK');
    await storage.delete(key);
    throw error;
  } finally {
    client.release();
  }
}

export async function findAgentAvatar(workspaceId: string, agentId: string) {
  return (await query<AvatarAsset>('SELECT * FROM agent_avatar_assets WHERE agent_id=$1 AND workspace_id=$2', [agentId, workspaceId])).rows[0];
}

export async function deleteAgentAvatar(workspaceId: string, agentId: string) {
  const client = await db.connect();
  let asset: AvatarAsset | undefined;
  try {
    await client.query('BEGIN');
    const agent = (await client.query<{ id: string }>('SELECT id FROM agents WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [agentId, workspaceId])).rows[0];
    if (!agent) throw Object.assign(new Error('AGENT_NOT_FOUND'), { statusCode: 404 });
    asset = (await client.query<AvatarAsset>('DELETE FROM agent_avatar_assets WHERE agent_id=$1 AND workspace_id=$2 RETURNING *', [agentId, workspaceId])).rows[0];
    await client.query(`UPDATE agents SET avatar_config='{}'::jsonb,updated_at=now() WHERE id=$1`, [agentId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (asset) await agentAvatarStorage().delete(asset.storage_key).catch(() => undefined);
  return Boolean(asset);
}
