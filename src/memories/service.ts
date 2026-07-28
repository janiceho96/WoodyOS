import type { QueryResult, QueryResultRow } from 'pg';
import { db, query } from '../db/client.js';
import type {
  CreateMemoryInput,
  LegacyMemoryKind,
  MemoryListFilters,
  MemoryRecord,
  MemoryScope,
  MemoryType,
  VerificationStatus,
} from './types.js';

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
};

const memoryColumns = `id,workspace_id,agent_id,user_id,kind,content,importance,metadata,
  memory_type,scope,source_type,source_id,confidence,verification_status,expires_at,
  superseded_by,last_accessed_at,access_count,created_at,updated_at`;

const kindDefaults: Record<LegacyMemoryKind, { type: MemoryType; verificationStatus: VerificationStatus }> = {
  user: { type: 'preference', verificationStatus: 'user_confirmed' },
  knowledge: { type: 'fact', verificationStatus: 'unverified' },
  conversation: { type: 'summary', verificationStatus: 'unverified' },
};

const legacyKindForType: Record<MemoryType, LegacyMemoryKind> = {
  preference: 'user',
  summary: 'conversation',
  fact: 'knowledge',
  decision: 'knowledge',
  project_context: 'knowledge',
  workflow_result: 'knowledge',
  error_resolution: 'knowledge',
  hypothesis: 'knowledge',
};

export class MemoryServiceError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
  }
}

type MemoryRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  user_id: string | null;
  kind: LegacyMemoryKind;
  content: string;
  importance: number;
  metadata: Record<string, unknown> | string;
  memory_type: MemoryType;
  scope: MemoryScope;
  source_type: string;
  source_id: string | null;
  confidence: number;
  verification_status: VerificationStatus;
  expires_at: Date | null;
  superseded_by: string | null;
  last_accessed_at: Date | null;
  access_count: number;
  created_at: Date;
  updated_at: Date;
};

function asMetadata(metadata: MemoryRow['metadata']): Record<string, unknown> {
  return typeof metadata === 'string' ? JSON.parse(metadata) as Record<string, unknown> : metadata;
}

function mapMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id, workspaceId: row.workspace_id, agentId: row.agent_id, userId: row.user_id,
    kind: row.kind, content: row.content, importance: row.importance, metadata: asMetadata(row.metadata),
    memoryType: row.memory_type, scope: row.scope, sourceType: row.source_type,
    sourceId: row.source_id, confidence: row.confidence, verificationStatus: row.verification_status,
    expiresAt: row.expires_at, supersededBy: row.superseded_by, lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function resolvedCreate(input: CreateMemoryInput) {
  const kind = input.kind ?? legacyKindForType[input.type ?? 'hypothesis'];
  const defaults = kindDefaults[kind];
  const type = input.type ?? defaults.type;
  const verificationStatus = input.verificationStatus
    ?? (input.actor?.type === 'user' && kind === 'user' ? 'user_confirmed' : defaults.verificationStatus);
  if (verificationStatus === 'disputed' || verificationStatus === 'superseded') {
    throw new MemoryServiceError('TERMINAL_VERIFICATION_STATUS', 400);
  }
  if (verificationStatus === 'user_confirmed' && input.actor?.type !== 'user') {
    throw new MemoryServiceError('USER_CONFIRMATION_REQUIRED', 403);
  }
  return {
    kind,
    type,
    scope: input.scope ?? (input.agentId ? 'agent' : input.userId ? 'user' : 'workspace'),
    verificationStatus,
    sourceType: input.source?.type ?? input.actor?.type ?? 'system',
    sourceId: input.source?.id ?? input.actor?.id ?? null,
  };
}

async function insertMemory(input: CreateMemoryInput, executor: Queryable): Promise<MemoryRecord> {
  const resolved = resolvedCreate(input);
  const result = await executor.query<MemoryRow>(
    `INSERT INTO memories(
      workspace_id,agent_id,user_id,kind,content,importance,metadata,memory_type,scope,
      source_type,source_id,confidence,verification_status,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING ${memoryColumns}`,
    [
      input.workspaceId, input.agentId ?? null, input.userId ?? null, resolved.kind, input.content,
      input.importance ?? 0.5, JSON.stringify(input.metadata ?? {}), resolved.type, resolved.scope,
      resolved.sourceType, resolved.sourceId, input.confidence ?? 0.5, resolved.verificationStatus,
      input.expiresAt ?? null,
    ],
  );
  return mapMemory(result.rows[0]);
}

async function ensureAgentInWorkspace(input: CreateMemoryInput, executor: Queryable) {
  if (!input.agentId) return;
  const agent = await executor.query('SELECT 1 FROM agents WHERE id=$1 AND workspace_id=$2', [input.agentId, input.workspaceId]);
  if (!agent.rowCount) throw new MemoryServiceError('AGENT_NOT_FOUND', 404);
}

export async function createMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
  await ensureAgentInWorkspace(input, { query });
  return insertMemory(input, { query });
}

async function updateLifecycle(
  workspaceId: string,
  memoryId: string,
  verificationStatus: 'user_confirmed' | 'disputed',
  actorId: string,
): Promise<MemoryRecord> {
  const result = await query<MemoryRow>(
    `UPDATE memories
        SET verification_status=$1,updated_at=now()
      WHERE id=$2 AND workspace_id=$3
        AND verification_status <> 'superseded'
        AND EXISTS (
          SELECT 1 FROM workspace_memberships
           WHERE workspace_id=$3 AND user_id=$4
        )
      RETURNING ${memoryColumns}`,
    [verificationStatus, memoryId, workspaceId, actorId],
  );
  if (!result.rowCount) throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
  return mapMemory(result.rows[0]);
}

export function confirmMemory(input: { workspaceId: string; memoryId: string; actorId: string }) {
  return updateLifecycle(input.workspaceId, input.memoryId, 'user_confirmed', input.actorId);
}

export function disputeMemory(input: { workspaceId: string; memoryId: string; actorId: string }) {
  return updateLifecycle(input.workspaceId, input.memoryId, 'disputed', input.actorId);
}

export async function expireMemory(input: { workspaceId: string; memoryId: string; now?: Date }) {
  const result = await query<MemoryRow>(
    `UPDATE memories SET expires_at=COALESCE($1,now()),updated_at=now()
      WHERE id=$2 AND workspace_id=$3 AND verification_status <> 'superseded'
      RETURNING ${memoryColumns}`,
    [input.now ?? null, input.memoryId, input.workspaceId],
  );
  if (!result.rowCount) throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
  return mapMemory(result.rows[0]);
}

export async function deleteMemory(input: { workspaceId: string; memoryId: string }) {
  const result = await query<{ id: string }>('DELETE FROM memories WHERE id=$1 AND workspace_id=$2 RETURNING id', [input.memoryId, input.workspaceId]);
  if (!result.rowCount) throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
}

export async function updateMemory(input: {
  workspaceId: string;
  memoryId: string;
  content?: string;
  importance?: number;
  metadata?: Record<string, unknown>;
}): Promise<MemoryRecord> {
  const entries: Array<[string, unknown]> = [];
  if (input.content !== undefined) entries.push(['content', input.content]);
  if (input.importance !== undefined) entries.push(['importance', input.importance]);
  if (input.metadata !== undefined) entries.push(['metadata', JSON.stringify(input.metadata)]);
  if (!entries.length) throw new MemoryServiceError('NO_UPDATES', 400);
  const values = entries.map(([, value]) => value);
  const set = entries.map(([field], index) => `${field}=$${index + 1}`).join(', ');
  const result = await query<MemoryRow>(
    `UPDATE memories SET ${set},updated_at=now()
      WHERE id=$${values.length + 1} AND workspace_id=$${values.length + 2}
      RETURNING ${memoryColumns}`,
    [...values, input.memoryId, input.workspaceId],
  );
  if (!result.rowCount) throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
  return mapMemory(result.rows[0]);
}

export async function supersedeMemory(input: {
  workspaceId: string;
  memoryId: string;
  replacementMemoryId?: string;
  replacement?: Omit<CreateMemoryInput, 'workspaceId'>;
}): Promise<{ memory: MemoryRecord; replacement: MemoryRecord }> {
  if (!input.replacementMemoryId && !input.replacement) throw new MemoryServiceError('REPLACEMENT_REQUIRED', 400);
  if (input.replacementMemoryId === input.memoryId) throw new MemoryServiceError('INVALID_REPLACEMENT', 400);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let replacement: MemoryRecord;
    if (input.replacementMemoryId) {
      const locked = await client.query<MemoryRow>(
        `SELECT ${memoryColumns} FROM memories
          WHERE workspace_id=$1 AND id=ANY($2::uuid[])
          ORDER BY id FOR UPDATE`,
        [input.workspaceId, [input.memoryId, input.replacementMemoryId].sort()],
      );
      const byId = new Map(locked.rows.map((row) => [row.id, row]));
      const previous = byId.get(input.memoryId);
      const replacementRow = byId.get(input.replacementMemoryId);
      if (!previous || !replacementRow) throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
      if (previous.verification_status === 'superseded') throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
      const now = new Date();
      if (
        replacementRow.verification_status === 'disputed'
        || replacementRow.verification_status === 'superseded'
        || (replacementRow.expires_at !== null && replacementRow.expires_at <= now)
      ) throw new MemoryServiceError('REPLACEMENT_NOT_ELIGIBLE', 409);
      const ancestry = await client.query<{ cycle: boolean }>(
        `WITH RECURSIVE ancestry(id,superseded_by,path,cycle) AS (
          SELECT id,superseded_by,ARRAY[id],false
            FROM memories WHERE workspace_id=$1 AND id=$2
          UNION ALL
          SELECT next.id,next.superseded_by,ancestry.path || next.id,next.id=ANY(ancestry.path)
            FROM memories next JOIN ancestry ON next.id=ancestry.superseded_by
           WHERE next.workspace_id=$1 AND NOT ancestry.cycle
        )
        SELECT COALESCE(bool_or(cycle OR id=$3),false) cycle FROM ancestry`,
        [input.workspaceId, input.replacementMemoryId, input.memoryId],
      );
      if (ancestry.rows[0]?.cycle) throw new MemoryServiceError('MEMORY_SUPERSESSION_CYCLE', 409);
      replacement = mapMemory(replacementRow);
    } else {
      const previousResult = await client.query<MemoryRow>(
        `SELECT ${memoryColumns} FROM memories
          WHERE id=$1 AND workspace_id=$2 AND verification_status <> 'superseded'
          FOR UPDATE`,
        [input.memoryId, input.workspaceId],
      );
      const previous = previousResult.rows[0];
      if (!previous) throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
      await ensureAgentInWorkspace({ ...input.replacement!, workspaceId: input.workspaceId }, client);
      replacement = await insertMemory({ ...input.replacement!, workspaceId: input.workspaceId }, client);
    }
    const superseded = await client.query<MemoryRow>(
      `UPDATE memories SET verification_status='superseded',superseded_by=$1,updated_at=now()
        WHERE id=$2 AND workspace_id=$3 AND verification_status <> 'superseded'
        RETURNING ${memoryColumns}`,
      [replacement.id, input.memoryId, input.workspaceId],
    );
    if (!superseded.rowCount) throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
    await client.query('COMMIT');
    return { memory: mapMemory(superseded.rows[0]), replacement };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listEligibleMemories(filters: MemoryListFilters): Promise<MemoryRecord[]> {
  const values: unknown[] = [filters.workspaceId, filters.now ?? new Date()];
  const conditions = [
    'workspace_id=$1',
    "verification_status NOT IN ('disputed','superseded')",
    '(expires_at IS NULL OR expires_at > $2)',
  ];
  if (filters.agentId) {
    values.push(filters.agentId);
    conditions.push(`agent_id=$${values.length}`);
  }
  if (filters.type) {
    values.push(filters.type);
    conditions.push(`memory_type=$${values.length}`);
  }
  if (filters.scope) {
    values.push(filters.scope);
    conditions.push(`scope=$${values.length}`);
  }
  values.push(Math.min(Math.max(filters.limit ?? 100, 1), 100));
  const result = await query<MemoryRow>(
    `SELECT ${memoryColumns} FROM memories WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC,created_at DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(mapMemory);
}

export function serializeMemory(memory: MemoryRecord) {
  return {
    id: memory.id, agent_id: memory.agentId, user_id: memory.userId, kind: memory.kind,
    content: memory.content, importance: memory.importance, metadata: memory.metadata,
    memory_type: memory.memoryType, scope: memory.scope, source_type: memory.sourceType,
    source_id: memory.sourceId, confidence: memory.confidence,
    verification_status: memory.verificationStatus, expires_at: memory.expiresAt,
    superseded_by: memory.supersededBy, last_accessed_at: memory.lastAccessedAt,
    access_count: memory.accessCount, created_at: memory.createdAt, updated_at: memory.updatedAt,
  };
}
