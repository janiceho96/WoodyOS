import type { QueryResult, QueryResultRow } from 'pg';
import { db, query } from '../db/client.js';
import type {
  CreateMemoryInput,
  LegacyMemoryKind,
  MemoryListFilters,
  MemoryManagementFilters,
  MemoryRecord,
  MemoryScope,
  MemoryType,
  ManagedMemoryList,
  VerificationStatus,
} from './types.js';
import { isEligibleMemoryCandidate, rankMemoryCandidate } from './ranking.js';
import { embeddingFor } from '../lib/embeddings.js';

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
};

const INLINE_EMBEDDING_TIMEOUT_MS = 5_000;

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
  const verificationStatus = input.actor
    ? input.verificationStatus ?? (input.actor.type === 'user' && kind === 'user' ? 'user_confirmed' : defaults.verificationStatus)
    : 'unverified';
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
    // The actor is authenticated at the route/worker boundary; caller-supplied
    // source labels are provenance detail, not an authority claim.
    sourceType: input.actor?.type ?? 'legacy',
    sourceId: input.actor?.id ?? null,
  };
}

async function insertMemory(
  input: CreateMemoryInput,
  executor: Queryable,
  embedding: number[] | null,
): Promise<MemoryRecord> {
  const resolved = resolvedCreate(input);
  const result = await executor.query<MemoryRow>(
    `INSERT INTO memories(
      workspace_id,agent_id,user_id,kind,content,importance,metadata,memory_type,scope,
      source_type,source_id,confidence,verification_status,expires_at,embedding
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::vector)
    RETURNING ${memoryColumns}`,
    [
      input.workspaceId, input.agentId ?? null, input.userId ?? null, resolved.kind, input.content,
      input.importance ?? 0.5, JSON.stringify({
        ...(input.metadata ?? {}),
        ...(input.source ? { provenance: { type: input.source.type, id: input.source.id ?? null } } : {}),
      }), resolved.type, resolved.scope,
      resolved.sourceType, resolved.sourceId, input.confidence ?? 0.5, resolved.verificationStatus,
      input.expiresAt ?? null, embedding?.length ? `[${embedding.join(',')}]` : null,
    ],
  );
  return mapMemory(result.rows[0]);
}

async function authoritativeSemanticSearch(
  workspaceId: string,
  agentId: string | null | undefined,
  executor: Queryable,
): Promise<boolean> {
  if (!agentId) return false;
  const agent = await executor.query<{ semantic_search: boolean }>(
    `SELECT COALESCE((memory_config->>'semanticSearch')::boolean,false) semantic_search
       FROM agents WHERE id=$1 AND workspace_id=$2`,
    [agentId, workspaceId],
  );
  if (!agent.rowCount) throw new MemoryServiceError('AGENT_NOT_FOUND', 404);
  return agent.rows[0]?.semantic_search === true;
}

async function policyEmbedding(
  input: Pick<CreateMemoryInput, 'workspaceId' | 'agentId' | 'content'>,
  executor: Queryable,
): Promise<number[] | null> {
  const enabled = await authoritativeSemanticSearch(input.workspaceId, input.agentId, executor);
  return enabled ? await embeddingFor(input.content).catch(() => null) : null;
}

async function boundedEmbedding(content: string): Promise<number[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INLINE_EMBEDDING_TIMEOUT_MS);
  try {
    return await embeddingFor(content, { signal: controller.signal }).catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

async function createMemoryWithExecutor(input: CreateMemoryInput, executor: Queryable): Promise<MemoryRecord> {
  const embedding = await policyEmbedding(input, executor);
  return insertMemory(input, executor, embedding);
}

export async function createMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
  return createMemoryWithExecutor(input, { query });
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
  scope?: MemoryScope;
  agentId?: string | null;
  expiresAt?: Date | null;
  actorId?: string;
}): Promise<MemoryRecord> {
  const snapshotResult = await query<{
    agent_id: string | null;
    user_id: string | null;
    scope: MemoryScope;
    revision_token: string;
    semantic_search: boolean;
  }>(
    `SELECT m.agent_id,m.user_id,m.scope,m.updated_at::text revision_token,
      COALESCE((a.memory_config->>'semanticSearch')::boolean,false) semantic_search
       FROM memories m
       LEFT JOIN agents a ON a.id=m.agent_id AND a.workspace_id=m.workspace_id
      WHERE m.id=$1 AND m.workspace_id=$2 AND m.verification_status <> 'superseded'`,
    [input.memoryId, input.workspaceId],
  );
  if (!snapshotResult.rowCount) throw new MemoryServiceError('MEMORY_NOT_FOUND', 404);
  const snapshot = snapshotResult.rows[0];
  const changesOwnership = input.scope !== undefined || input.agentId !== undefined;
  const entries: Array<[string, unknown]> = [];
  const targetScope = input.scope ?? snapshot.scope;
  let targetAgentId = input.agentId === undefined ? snapshot.agent_id : input.agentId;
  if (changesOwnership) {
    if (targetScope === 'workspace') {
      entries.push(['scope', 'workspace'], ['agent_id', null], ['user_id', null]);
      targetAgentId = null;
    } else if (targetScope === 'agent') {
      if (!targetAgentId) throw new MemoryServiceError('AGENT_REQUIRED_FOR_SCOPE', 400);
      entries.push(['scope', 'agent'], ['agent_id', targetAgentId], ['user_id', null]);
    } else {
      if (!input.actorId) throw new MemoryServiceError('USER_SCOPE_ACTOR_REQUIRED', 403);
      entries.push(['scope', 'user'], ['agent_id', targetAgentId], ['user_id', input.actorId]);
    }
  }
  const targetHasAgentPolicy = targetScope !== 'workspace' && Boolean(targetAgentId);
  const preflightSemanticEnabled = targetHasAgentPolicy
    ? targetAgentId === snapshot.agent_id && targetScope === snapshot.scope
      ? snapshot.semantic_search === true
      : await authoritativeSemanticSearch(input.workspaceId, targetAgentId!, { query })
    : false;
  let preflightEmbedding: number[] | null | undefined;
  if (input.content !== undefined) {
    preflightEmbedding = preflightSemanticEnabled ? await boundedEmbedding(input.content) : null;
    entries.push(['content', input.content], ['embedding', preflightEmbedding?.length ? `[${preflightEmbedding.join(',')}]` : null]);
  } else if (!preflightSemanticEnabled) {
    entries.push(['embedding', null]);
  }
  if (input.importance !== undefined) {
    if (!Number.isFinite(input.importance) || input.importance < 0 || input.importance > 1) {
      throw new MemoryServiceError('IMPORTANCE_INVALID', 400);
    }
    entries.push(['importance', input.importance]);
  }
  if (input.metadata !== undefined) entries.push(['metadata', JSON.stringify(input.metadata)]);
  if (input.expiresAt !== undefined) {
    if (input.expiresAt !== null && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date())) {
      throw new MemoryServiceError('EXPIRY_INVALID', 400);
    }
    entries.push(['expires_at', input.expiresAt]);
  }
  if (!entries.length) throw new MemoryServiceError('NO_UPDATES', 400);
  const set = entries.map(([field], index) => field === 'metadata'
    ? `metadata=(metadata || ($${index + 1}::jsonb - 'provenance'))`
    : field === 'embedding'
      ? `embedding=$${index + 1}::vector`
    : `${field}=$${index + 1}`).join(', ');
  const values = entries.map(([, value]) => value);
  const policyCondition = targetHasAgentPolicy
    ? `AND EXISTS (
      SELECT 1 FROM agents target_agent
       WHERE target_agent.id=$${values.length + 4}
         AND target_agent.workspace_id=$${values.length + 5}
         AND COALESCE((target_agent.memory_config->>'semanticSearch')::boolean,false)=$${values.length + 6}
    )`
    : '';
  const result = await query<MemoryRow>(
    `UPDATE memories SET ${set},updated_at=now()
      WHERE id=$${values.length + 1} AND workspace_id=$${values.length + 2}
        AND verification_status <> 'superseded'
        AND updated_at::text=$${values.length + 3}
        ${policyCondition}
      RETURNING ${memoryColumns}`,
    targetHasAgentPolicy
      ? [...values, input.memoryId, input.workspaceId, snapshot.revision_token, targetAgentId, input.workspaceId, preflightSemanticEnabled]
      : [...values, input.memoryId, input.workspaceId, snapshot.revision_token],
  );
  if (!result.rowCount) throw new MemoryServiceError('MEMORY_UPDATE_CONFLICT', 409);
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
  const inlineReplacement = input.replacement
    ? { ...input.replacement, workspaceId: input.workspaceId }
    : null;
  const preflightSemanticEnabled = inlineReplacement
    ? await authoritativeSemanticSearch(
      inlineReplacement.workspaceId,
      inlineReplacement.agentId,
      { query },
    )
    : false;
  const prefetchedEmbedding = inlineReplacement && preflightSemanticEnabled
    ? await boundedEmbedding(inlineReplacement.content)
    : null;
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
      const semanticStillEnabled = await authoritativeSemanticSearch(
        inlineReplacement!.workspaceId,
        inlineReplacement!.agentId,
        client,
      );
      replacement = await insertMemory(
        inlineReplacement!,
        client,
        preflightSemanticEnabled && semanticStillEnabled ? prefetchedEmbedding : null,
      );
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

export async function listManagedMemories(filters: MemoryManagementFilters): Promise<ManagedMemoryList> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const offset = Math.min(Math.max(filters.offset ?? 0, 0), 1_000);
  const values: unknown[] = [filters.workspaceId, filters.now ?? new Date()];
  const conditions = ['workspace_id=$1'];
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
  if (filters.verificationStatus) {
    values.push(filters.verificationStatus);
    conditions.push(`verification_status=$${values.length}`);
  }
  if (filters.expiry === 'active') conditions.push('(expires_at IS NULL OR expires_at > $2)');
  if (filters.expiry === 'expired') conditions.push('expires_at <= $2');
  values.push(limit + 1, offset);
  const result = await query<MemoryRow>(
    `SELECT ${memoryColumns} FROM memories WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC,id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  const memories = result.rows.slice(0, limit).map(mapMemory);
  return {
    memories,
    pagination: { limit, offset, nextOffset: result.rows.length > limit && offset + limit <= 1_000 ? offset + limit : null },
  };
}

export type RetrieveAgentMemoriesInput = {
  workspaceId: string;
  agentId: string;
  userId: string;
  query: string;
  limit?: number;
  confirmedOnly?: boolean;
  now?: Date;
  queryEmbedding?: number[];
};

export type AgentPromptMemory = {
  id: string;
  content: string;
  memoryType: MemoryType;
  scope: MemoryScope;
  verificationStatus: VerificationStatus;
  score: number;
};

export async function retrieveAgentMemories(input: RetrieveAgentMemoriesInput): Promise<AgentPromptMemory[]> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 4, 1), 8);
  const values: unknown[] = [input.workspaceId, input.agentId, input.userId, now];
  const conditions = [
    'workspace_id=$1',
    "(scope='workspace' OR (scope='agent' AND agent_id=$2) OR (scope='user' AND user_id=$3))",
    "verification_status NOT IN ('disputed','superseded')",
    '(expires_at IS NULL OR expires_at > $4)',
  ];
  if (input.confirmedOnly) conditions.push("verification_status <> 'agent_inferred'");
  const vector = input.queryEmbedding?.length ? `[${input.queryEmbedding.join(',')}]` : null;
  const candidateLimit = 1_000;
  const vectorIndex = values.length + 1;
  const similarityColumn = vector
    ? `,CASE WHEN embedding IS NULL THEN NULL ELSE 1-(embedding <=> $${vectorIndex}::vector) END semantic_relevance`
    : ',NULL::real semantic_relevance';
  const lexicalValues = vector
    ? [...values, vector, input.query, candidateLimit]
    : [...values, input.query, candidateLimit];
  const lexicalQueryIndex = lexicalValues.length - 1;
  const lexicalCandidates = query<MemoryRow & { semantic_relevance: number | null }>(
    `SELECT ${memoryColumns}${similarityColumn} FROM memories WHERE ${conditions.join(' AND ')}
      ORDER BY ts_rank(to_tsvector('simple',content),websearch_to_tsquery('simple',$${lexicalQueryIndex})) DESC,
        CASE source_type WHEN 'user' THEN 1 WHEN 'system' THEN .8 WHEN 'agent' THEN .6 ELSE .4 END DESC,
        confidence DESC,importance DESC,created_at DESC,id ASC LIMIT $${lexicalValues.length}`,
    lexicalValues,
  );
  const semanticCandidates = vector
    ? query<MemoryRow & { semantic_relevance: number | null }>(
      `SELECT ${memoryColumns}${similarityColumn} FROM memories WHERE ${conditions.join(' AND ')}
        ORDER BY semantic_relevance DESC NULLS LAST,
          CASE source_type WHEN 'user' THEN 1 WHEN 'system' THEN .8 WHEN 'agent' THEN .6 ELSE .4 END DESC,
          confidence DESC,importance DESC,created_at DESC,id ASC LIMIT $${values.length + 2}`,
      [...values, vector, candidateLimit],
    )
    : null;
  const [lexicalResult, semanticResult] = await Promise.all([
    lexicalCandidates,
    semanticCandidates ?? Promise.resolve(null),
  ]);
  const rowsById = new Map<string, MemoryRow & { semantic_relevance: number | null }>();
  for (const row of [...(semanticResult?.rows ?? []), ...lexicalResult.rows]) {
    if (!rowsById.has(row.id)) rowsById.set(row.id, row);
  }
  const rows = [...rowsById.values()];
  const rankingContext = { ...input, now };
  const selected = rows
    .map((row) => ({ memory: mapMemory(row), semanticRelevance: row.semantic_relevance }))
    .filter(({ memory }) => isEligibleMemoryCandidate(memory, rankingContext))
    .map(({ memory, semanticRelevance }) => ({ memory, score: rankMemoryCandidate(memory, {
      ...rankingContext,
      semanticRelevance: semanticRelevance ?? undefined,
    }) }))
    .sort((left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id))
    .slice(0, limit);

  return selected.map(({ memory, score }) => ({
    id: memory.id,
    content: memory.content,
    memoryType: memory.memoryType,
    scope: memory.scope,
    verificationStatus: memory.verificationStatus,
    score,
  }));
}

export async function claimAgentMemoriesForPrompt(input: {
  workspaceId: string;
  agentId: string;
  userId: string;
  selected: AgentPromptMemory[];
  confirmedOnly?: boolean;
  now?: Date;
}): Promise<AgentPromptMemory[]> {
  if (!input.selected.length) return [];
  const values: unknown[] = [input.selected.map((memory) => memory.id), input.workspaceId, input.agentId, input.userId, input.now ?? new Date()];
  const conditions = [
    'id=ANY($1::uuid[])',
    'workspace_id=$2',
    "(scope='workspace' OR (scope='agent' AND agent_id=$3) OR (scope='user' AND user_id=$4))",
    "verification_status NOT IN ('disputed','superseded')",
    '(expires_at IS NULL OR expires_at > $5)',
  ];
  if (input.confirmedOnly) conditions.push("verification_status <> 'agent_inferred'");
  const claimed = await query<MemoryRow>(
    `UPDATE memories SET last_accessed_at=now(),access_count=access_count+1
      WHERE ${conditions.join(' AND ')} RETURNING ${memoryColumns}`,
    values,
  );
  const selectedById = new Map(input.selected.map((memory) => [memory.id, memory]));
  return claimed.rows
    .map(mapMemory)
    .map((memory) => {
      const selected = selectedById.get(memory.id);
      return selected ? {
        id: memory.id, content: memory.content, memoryType: memory.memoryType, scope: memory.scope,
        verificationStatus: memory.verificationStatus, score: selected.score,
      } : null;
    })
    .filter((memory): memory is AgentPromptMemory => Boolean(memory))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
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
