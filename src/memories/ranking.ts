import type { MemoryRecord } from './types.js';

export type MemoryRankingContext = {
  workspaceId: string;
  agentId: string;
  userId: string;
  query: string;
  now?: Date;
  confirmedOnly?: boolean;
  semanticRelevance?: number;
};

const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function clamp(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function tokenSet(value: string) {
  return new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function lexicalRelevance(query: string, content: string) {
  const queryTerms = tokenSet(query);
  if (!queryTerms.size) return 0;
  const contentTerms = tokenSet(content);
  let matches = 0;
  for (const term of queryTerms) if (contentTerms.has(term)) matches += 1;
  return matches / queryTerms.size;
}

function sourceAuthority(sourceType: string) {
  if (sourceType === 'user') return 1;
  if (sourceType === 'system') return 0.8;
  if (sourceType === 'agent') return 0.6;
  return 0.4;
}

function isScopeMatch(memory: MemoryRecord, context: MemoryRankingContext) {
  if (memory.workspaceId !== context.workspaceId) return false;
  if (memory.scope === 'workspace') return true;
  if (memory.scope === 'agent') return memory.agentId === context.agentId;
  return memory.userId === context.userId;
}

export function isEligibleMemoryCandidate(memory: MemoryRecord, context: MemoryRankingContext) {
  const now = context.now ?? new Date();
  return isScopeMatch(memory, context)
    && memory.verificationStatus !== 'disputed'
    && memory.verificationStatus !== 'superseded'
    && !(context.confirmedOnly && memory.verificationStatus === 'agent_inferred')
    && (!memory.expiresAt || memory.expiresAt > now);
}

function recency(memory: MemoryRecord, now: Date) {
  const age = now.getTime() - memory.createdAt.getTime();
  return clamp(1 - age / RECENCY_WINDOW_MS);
}

export function rankMemoryCandidate(memory: MemoryRecord, context: MemoryRankingContext) {
  if (!isEligibleMemoryCandidate(memory, context)) return 0;
  const now = context.now ?? new Date();
  const semanticRelevance = clamp(context.semanticRelevance ?? lexicalRelevance(context.query, memory.content));
  return semanticRelevance * 0.40
    + 1 * 0.20
    + sourceAuthority(memory.sourceType) * 0.15
    + clamp(memory.confidence) * 0.10
    + clamp(memory.importance) * 0.10
    + recency(memory, now) * 0.05;
}
