import { normalizeDraftAgentPayload } from '../copilot/contracts.js';
import type { DraftAgentPayload } from '../copilot/types.js';
import type { QueryRunner } from '../lib/audit.js';
import type { AgentInput, AgentRecord } from './types.js';

export async function createAgentWithClient(
  client: QueryRunner,
  input: { workspaceId: string; actorId: string; payload: AgentInput },
): Promise<AgentRecord> {
  const payload = input.payload;
  const result = await client.query<AgentRecord>(
    `INSERT INTO agents(
       workspace_id,name,role,goal,instructions,personality,model,model_config,capabilities,
       status,tool_ids,memory_config,avatar_config,created_by
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      input.workspaceId,
      payload.name,
      payload.role,
      payload.goal,
      payload.instructions,
      payload.personality ?? null,
      payload.model,
      JSON.stringify(payload.modelConfig),
      JSON.stringify(payload.capabilities),
      payload.status,
      JSON.stringify(payload.toolIds ?? []),
      JSON.stringify(payload.memoryConfig),
      JSON.stringify(payload.avatar ?? {}),
      input.actorId,
    ],
  );
  return result.rows[0];
}

export async function createDraftAgentWithClient(
  client: QueryRunner,
  input: { workspaceId: string; actorId: string; payload: DraftAgentPayload },
): Promise<AgentRecord> {
  const safe = normalizeDraftAgentPayload(input.payload);
  return createAgentWithClient(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    payload: {
      ...safe,
      avatar: undefined,
    },
  });
}
