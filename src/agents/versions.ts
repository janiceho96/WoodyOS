import type { PoolClient } from 'pg';
import { db } from '../db/client.js';
import {
  normalizeCapabilities,
  normalizeModelConfig,
  type AgentCapabilities,
  type AgentModelConfig,
} from '../lib/agent-runtime.js';

export type AgentVersionSnapshot = {
  name: string;
  role: string;
  goal: string;
  instructions: string;
  personality: string | null;
  model: string;
  modelConfig: AgentModelConfig;
  capabilities: AgentCapabilities;
  apiToolIds: string[];
  memoryConfig: Record<string, unknown>;
  avatarIdentity: Record<string, unknown>;
};

export type AgentVersion = {
  id: string;
  workspaceId: string;
  agentId: string;
  version: number;
  snapshot: AgentVersionSnapshot;
  publishedBy: string | null;
  createdAt: string;
};

type AgentVersionRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  version: number;
  snapshot: AgentVersionSnapshot;
  published_by: string | null;
  created_at: Date | string;
};

type AgentDraftRow = {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  goal: string;
  instructions: string;
  personality: string | null;
  model: string;
  model_config: unknown;
  capabilities: unknown;
  tool_ids: unknown;
  memory_config: unknown;
  avatar_config: unknown;
};

type WorkspaceAgentRow = {
  id: string;
  published_version_id: string | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function versionError(code: string, statusCode: number) {
  return Object.assign(new Error(code), { code, statusCode });
}

function mapVersion(row: AgentVersionRow): AgentVersion {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    version: row.version,
    snapshot: row.snapshot,
    publishedBy: row.published_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

function snapshotOf(agent: AgentDraftRow): AgentVersionSnapshot {
  return {
    name: agent.name,
    role: agent.role,
    goal: agent.goal,
    instructions: agent.instructions,
    personality: agent.personality,
    model: agent.model,
    modelConfig: normalizeModelConfig(agent.model_config),
    capabilities: normalizeCapabilities(agent.capabilities),
    apiToolIds: Array.isArray(agent.tool_ids)
      ? agent.tool_ids.filter((id): id is string => typeof id === 'string')
      : [],
    memoryConfig: objectValue(agent.memory_config),
    avatarIdentity: objectValue(agent.avatar_config),
  };
}

async function publishWithClient(
  client: PoolClient,
  input: { workspaceId: string; agentId: string; actorId: string },
) {
  const draft = (await client.query<AgentDraftRow>(
    `SELECT agent.*
       FROM agents agent
       JOIN workspace_memberships membership
         ON membership.workspace_id=agent.workspace_id AND membership.user_id=$3
      WHERE agent.id=$1 AND agent.workspace_id=$2 AND agent.status <> 'archived'
      FOR UPDATE OF agent`,
    [input.agentId, input.workspaceId, input.actorId],
  )).rows[0];
  if (!draft) throw versionError('AGENT_NOT_FOUND', 404);
  const nextVersion = (await client.query<{ version: number }>(
    'SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_versions WHERE agent_id=$1 AND workspace_id=$2',
    [input.agentId, input.workspaceId],
  )).rows[0].version;
  const inserted = (await client.query<AgentVersionRow>(
    `INSERT INTO agent_versions(workspace_id,agent_id,version,snapshot,published_by)
     VALUES($1,$2,$3,$4,$5)
     RETURNING id,workspace_id,agent_id,version,snapshot,published_by,created_at`,
    [input.workspaceId, input.agentId, nextVersion, JSON.stringify(snapshotOf(draft)), input.actorId],
  )).rows[0];
  await client.query(
    'UPDATE agents SET published_version_id=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3',
    [inserted.id, input.agentId, input.workspaceId],
  );
  return mapVersion(inserted);
}

export async function publishAgent(input: {
  workspaceId: string;
  agentId: string;
  actorId: string;
}): Promise<AgentVersion> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const published = await publishWithClient(client, input);
    await client.query('COMMIT');
    return published;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function enforceWorkspaceAgentModel(
  client: PoolClient,
  input: { workspaceId: string; actorId: string; model: string },
): Promise<{ agentsUpdated: number; versionsPublished: number }> {
  const agents = (await client.query<WorkspaceAgentRow>(
    `SELECT agent.id,agent.published_version_id
       FROM agents agent
       JOIN workspace_memberships membership
         ON membership.workspace_id=agent.workspace_id AND membership.user_id=$2
      WHERE agent.workspace_id=$1 AND agent.status <> 'archived'
      ORDER BY agent.id
      FOR UPDATE OF agent`,
    [input.workspaceId, input.actorId],
  )).rows;

  if (agents.length > 0) {
    await client.query(
      'UPDATE agents SET model=$1,updated_at=now() WHERE workspace_id=$2 AND id=ANY($3::uuid[])',
      [input.model, input.workspaceId, agents.map((agent) => agent.id)],
    );
  }

  let versionsPublished = 0;
  for (const agent of agents) {
    if (!agent.published_version_id) continue;
    await publishWithClient(client, { workspaceId: input.workspaceId, agentId: agent.id, actorId: input.actorId });
    versionsPublished += 1;
  }

  return { agentsUpdated: agents.length, versionsPublished };
}

export async function getAgentVersion(workspaceId: string, versionId: string): Promise<AgentVersion> {
  const row = (await db.query<AgentVersionRow>(
    `SELECT id,workspace_id,agent_id,version,snapshot,published_by,created_at
       FROM agent_versions WHERE id=$1 AND workspace_id=$2`,
    [versionId, workspaceId],
  )).rows[0];
  if (!row) throw versionError('AGENT_VERSION_NOT_FOUND', 404);
  return mapVersion(row);
}

export async function resolvePublishedAgentVersion(workspaceId: string, agentId: string): Promise<AgentVersion> {
  const row = (await db.query<AgentVersionRow>(
    `SELECT version.id,version.workspace_id,version.agent_id,version.version,
            version.snapshot,version.published_by,version.created_at
       FROM agents agent
       JOIN agent_versions version
         ON version.id=agent.published_version_id
        AND version.agent_id=agent.id
        AND version.workspace_id=agent.workspace_id
      WHERE agent.id=$1 AND agent.workspace_id=$2 AND agent.status='active'`,
    [agentId, workspaceId],
  )).rows[0];
  if (!row) throw versionError('AGENT_VERSION_REQUIRED', 409);
  return mapVersion(row);
}
