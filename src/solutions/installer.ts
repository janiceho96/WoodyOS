import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { db } from '../db/client.js';
import { encryptJsonWithContext } from '../lib/crypto.js';
import { toolRiskLevel, type ToolRecord } from '../tools/runtime.js';
import type { AgentSolution } from './schema.js';
import { parseAgentSolution } from './schema.js';

type InstallInput = {
  workspaceId: string;
  userId: string;
  solution: AgentSolution;
  allowDuplicate?: boolean;
  sourcePrompt?: string;
  persistPrompt?: boolean;
  toolIdsByAgentKey?: Record<string, string[]>;
};

export function materializeWorkflowDefinition(solution: AgentSolution, agentIds: Map<string, string>) {
  return {
    nodes: solution.workflow.nodes.map((node) => {
      const config = { ...node.config };
      if (node.type !== 'agent') return { id: node.id, type: node.type, config };
      const agentId = node.agentKey ? agentIds.get(node.agentKey) : undefined;
      if (!agentId) throw Object.assign(new Error(`UNRESOLVED_AGENT_KEY:${node.agentKey ?? ''}`), { statusCode: 400 });
      return { id: node.id, type: node.type, config: { ...config, agentId } };
    }),
    edges: solution.workflow.edges,
  };
}

async function installWithClient(client: PoolClient, input: InstallInput) {
  const solution = parseAgentSolution(input.solution);
  const knownAgentKeys = new Set(solution.agents.map((agent) => agent.key));
  const assignments = input.toolIdsByAgentKey ?? {};
  if (Object.keys(assignments).some((agentKey) => !knownAgentKeys.has(agentKey))) {
    throw Object.assign(new Error('UNKNOWN_SOLUTION_AGENT_TOOL_ASSIGNMENT'), { statusCode: 400 });
  }
  const selectedToolIds = [...new Set(Object.values(assignments).flat())];
  if (selectedToolIds.length > 40) {
    throw Object.assign(new Error('TOO_MANY_SOLUTION_TOOL_ASSIGNMENTS'), { statusCode: 400 });
  }
  const toolRows = selectedToolIds.length
    ? (await client.query<ToolRecord>(
      `SELECT id,name,kind,config,permissions
       FROM tools WHERE workspace_id=$1 AND enabled=true AND id = ANY($2::uuid[])`,
      [input.workspaceId, selectedToolIds],
    )).rows
    : [];
  const toolById = new Map(toolRows.map((tool) => [tool.id, tool]));
  if (toolById.size !== selectedToolIds.length) {
    throw Object.assign(new Error('INVALID_OR_DISABLED_SOLUTION_TOOL'), { statusCode: 400 });
  }
  for (const agent of solution.agents) {
    const toolIds = [...new Set(assignments[agent.key] ?? [])];
    if (toolIds.length > 10) throw Object.assign(new Error('TOO_MANY_AGENT_TOOL_ASSIGNMENTS'), { statusCode: 400 });
    const assignedTools = toolIds.map((id) => toolById.get(id)!);
    for (const tool of assignedTools) {
      const compatible = agent.toolRequirements.some((requirement) =>
        requirement.permissions.some((permission) => tool.permissions.includes(permission)));
      if (!compatible || toolRiskLevel(tool) !== 'read') {
        throw Object.assign(new Error('INCOMPATIBLE_OR_NON_READ_ONLY_SOLUTION_TOOL'), { statusCode: 400 });
      }
    }
    for (const requirement of agent.toolRequirements.filter((item) => item.required)) {
      const satisfied = assignedTools.some((tool) =>
        requirement.permissions.some((permission) => tool.permissions.includes(permission)));
      if (!satisfied) {
        throw Object.assign(new Error(`MISSING_REQUIRED_SOLUTION_TOOL:${agent.key}:${requirement.key}`), { statusCode: 400 });
      }
    }
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM agent_solution_installations
      WHERE workspace_id=$1 AND source_type=$2 AND solution_slug=$3 AND solution_version=$4
        AND duplicate_of IS NULL AND status <> 'archived'
      LIMIT 1 FOR UPDATE`,
    [input.workspaceId, solution.source, solution.slug, solution.version],
  );
  if (existing.rowCount && !input.allowDuplicate) {
    throw Object.assign(new Error('AGENT_SOLUTION_ALREADY_INSTALLED'), { statusCode: 409 });
  }

  const installationId = randomUUID();
  const promptHash = input.sourcePrompt
    ? createHash('sha256').update(input.sourcePrompt).digest('hex')
    : null;
  const encryptedPrompt = input.persistPrompt && input.sourcePrompt
    ? encryptJsonWithContext({ prompt: input.sourcePrompt }, `agent-solution:${input.workspaceId}:${installationId}`)
    : null;
  await client.query(
    `INSERT INTO agent_solution_installations(
       id,workspace_id,source_type,solution_slug,solution_version,solution_name,solution_snapshot,
       encrypted_source_prompt,prompt_hash,duplicate_of,installed_by
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      installationId, input.workspaceId, solution.source, solution.slug, solution.version, solution.name,
      JSON.stringify(solution), encryptedPrompt ? JSON.stringify(encryptedPrompt) : null, promptHash,
      existing.rows[0]?.id ?? null, input.userId,
    ],
  );

  const defaultModel = process.env.LLM_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514';
  const agentIds = new Map<string, string>();
  for (const agent of solution.agents) {
    const toolIds = [...new Set(assignments[agent.key] ?? [])];
    const created = await client.query<{ id: string }>(
      `INSERT INTO agents(
         workspace_id,name,role,goal,instructions,personality,model,model_config,capabilities,
         status,tool_ids,memory_config,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12) RETURNING id`,
      [
        input.workspaceId, agent.name, agent.role, agent.goal, agent.instructions, agent.personality,
        agent.model ?? defaultModel, JSON.stringify(agent.modelConfig), JSON.stringify(agent.capabilities),
        JSON.stringify(toolIds),
        JSON.stringify({ shortTerm: true, longTerm: true, knowledgeBase: agent.capabilities.knowledgeBase }),
        input.userId,
      ],
    );
    agentIds.set(agent.key, created.rows[0].id);
  }

  const team = await client.query<{ id: string }>(
    'INSERT INTO agent_teams(workspace_id,name,description) VALUES($1,$2,$3) RETURNING id',
    [input.workspaceId, solution.team.name, solution.team.description],
  );
  const managerId = solution.team.managerAgentKey ? agentIds.get(solution.team.managerAgentKey) ?? null : null;
  for (const agent of solution.agents) {
    const agentId = agentIds.get(agent.key)!;
    await client.query(
      'INSERT INTO team_memberships(team_id,agent_id,manager_agent_id) VALUES($1,$2,$3)',
      [team.rows[0].id, agentId, agentId === managerId ? null : managerId],
    );
  }

  const definition = materializeWorkflowDefinition(solution, agentIds);
  const workflow = await client.query<{ id: string }>(
    `INSERT INTO workflows(workspace_id,name,description,definition,enabled,created_by)
     VALUES($1,$2,$3,$4,false,$5) RETURNING id`,
    [input.workspaceId, solution.workflow.name, solution.workflow.description, JSON.stringify(definition), input.userId],
  );
  const resources = {
    agentIds: Object.fromEntries(agentIds),
    teamId: team.rows[0].id,
    workflowId: workflow.rows[0].id,
  };
  await client.query(
    'UPDATE agent_solution_installations SET created_resource_ids=$1,updated_at=now() WHERE id=$2',
    [JSON.stringify(resources), installationId],
  );
  return { id: installationId, status: 'draft' as const, solution, resources };
}

export async function installAgentSolution(input: InstallInput) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const installed = await installWithClient(client, input);
    await client.query('COMMIT');
    return installed;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string }).code === '23505') {
      throw Object.assign(new Error('AGENT_SOLUTION_ALREADY_INSTALLED'), { statusCode: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function installAgentSolutionInTransaction(client: PoolClient, input: InstallInput) {
  return installWithClient(client, input);
}
