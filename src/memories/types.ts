export type MemoryType =
  | 'preference'
  | 'fact'
  | 'decision'
  | 'project_context'
  | 'workflow_result'
  | 'error_resolution'
  | 'summary'
  | 'hypothesis';

export type MemoryScope = 'workspace' | 'agent' | 'user';

export type VerificationStatus =
  | 'user_confirmed'
  | 'agent_inferred'
  | 'system_generated'
  | 'unverified'
  | 'disputed'
  | 'superseded';

export type LegacyMemoryKind = 'conversation' | 'knowledge' | 'user';
export type MemoryActorType = 'user' | 'agent' | 'system';

export type MemorySource = {
  type: string;
  id?: string | null;
};

export type MemoryRecord = {
  id: string;
  workspaceId: string;
  agentId: string | null;
  userId: string | null;
  kind: LegacyMemoryKind;
  content: string;
  importance: number;
  metadata: Record<string, unknown>;
  memoryType: MemoryType;
  scope: MemoryScope;
  sourceType: string;
  sourceId: string | null;
  confidence: number;
  verificationStatus: VerificationStatus;
  expiresAt: Date | null;
  supersededBy: string | null;
  lastAccessedAt: Date | null;
  accessCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateMemoryInput = {
  workspaceId: string;
  agentId?: string | null;
  userId?: string | null;
  kind?: LegacyMemoryKind;
  type?: MemoryType;
  scope?: MemoryScope;
  content: string;
  importance?: number;
  metadata?: Record<string, unknown>;
  source?: MemorySource;
  confidence?: number;
  verificationStatus?: VerificationStatus;
  expiresAt?: Date | string | null;
  semanticSearch?: boolean;
  embedding?: number[] | null;
  actor?: { type: MemoryActorType; id?: string };
};

export type MemoryListFilters = {
  workspaceId: string;
  agentId?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  limit?: number;
  now?: Date;
};
