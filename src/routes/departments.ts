import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import {
  archiveDepartment,
  createDepartment,
  getOrganization,
  removeMembership,
  setExecutiveAgent,
  setMembership,
  updateDepartment,
} from '../departments/service.js';
import {
  DepartmentError,
  type OrganizationSnapshot,
} from '../departments/types.js';
import { asyncRoute, parse } from '../lib/http.js';

export type OrganizationAgentSummary = {
  id: string;
  name: string;
  role: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  avatar: Record<string, unknown>;
  activeWorkCount: number;
  apiToolCount: number;
  mcpConnectionCount: number;
};

export type SafeOrganizationResponse = OrganizationSnapshot & {
  agents: OrganizationAgentSummary[];
};

type OrganizationAgentSummaryRow = {
  id: string;
  name: string;
  role: string;
  status: OrganizationAgentSummary['status'];
  avatar: Record<string, unknown>;
  active_work_count: number;
  api_tool_count: number;
  mcp_connection_count: number;
};

const expectedRevision = z.number().int().min(1);
const departmentIdParams = z.object({ id: z.string().uuid() });
const memberParams = departmentIdParams.extend({ agentId: z.string().uuid() });
const managerSelection = {
  managerAgentId: z.string().uuid().nullable().optional(),
  confirmPrimaryMove: z.boolean().optional(),
};
const createDepartmentInput = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2_000).default(''),
  displayOrder: z.number().int().min(0).max(1_000_000).default(0),
  ...managerSelection,
  expectedRevision,
});
const updateDepartmentInput = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2_000).optional(),
  displayOrder: z.number().int().min(0).max(1_000_000).optional(),
  ...managerSelection,
  expectedRevision,
}).refine(
  (input) => Object.keys(input).some((key) => (
    key !== 'expectedRevision' && key !== 'confirmPrimaryMove'
  )),
  'At least one Department field must be updated',
);
const membershipInput = z.object({
  membershipType: z.enum(['primary', 'shared']),
  expectedRevision,
});
const revisionInput = z.object({ expectedRevision });
const executiveInput = revisionInput.extend({
  agentId: z.string().uuid().nullable(),
});

function mapAgentSummary(
  row: OrganizationAgentSummaryRow,
): OrganizationAgentSummary {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    avatar: row.avatar,
    activeWorkCount: row.active_work_count,
    apiToolCount: row.api_tool_count,
    mcpConnectionCount: row.mcp_connection_count,
  };
}

export async function getSafeOrganization(
  workspaceId: string,
): Promise<SafeOrganizationResponse> {
  const [organization, agents] = await Promise.all([
    getOrganization(workspaceId),
    query<OrganizationAgentSummaryRow>(
      `SELECT a.id,a.name,a.role,a.status,a.avatar_config avatar,
              (
                SELECT count(*)::int
                  FROM tasks task
                 WHERE task.workspace_id=a.workspace_id
                   AND task.agent_id=a.id
                   AND task.status IN ('queued','running','awaiting_approval')
              ) active_work_count,
              jsonb_array_length(a.tool_ids)::int api_tool_count,
              (
                SELECT count(DISTINCT granted.connection_id)::int
                  FROM (
                    SELECT access.connection_id
                      FROM mcp_agent_access access
                     WHERE access.agent_id=a.id AND access.enabled=true
                    UNION
                    SELECT tool.connection_id
                      FROM mcp_agent_tool_access access
                      JOIN mcp_connection_tools tool
                        ON tool.id=access.mcp_tool_id
                       AND tool.enabled=true
                     WHERE access.agent_id=a.id AND access.enabled=true
                  ) granted
                  JOIN mcp_connections connection
                    ON connection.id=granted.connection_id
                   AND connection.workspace_id=a.workspace_id
                   AND connection.enabled=true
                   AND connection.deleted_at IS NULL
              ) mcp_connection_count
         FROM agents a
        WHERE a.workspace_id=$1
        ORDER BY a.name,a.id`,
      [workspaceId],
    ),
  ]);
  return {
    ...organization,
    agents: agents.rows.map(mapAgentSummary),
  };
}

export function sendDepartmentError(
  reply: FastifyReply,
  cause: unknown,
) {
  if (!(cause instanceof DepartmentError)) throw cause;
  return reply.code(cause.statusCode).send({
    error: cause.code,
    ...(cause.currentRevision === undefined
      ? {}
      : { currentRevision: cause.currentRevision }),
  });
}

async function sendMutation(
  reply: FastifyReply,
  statusCode: number,
  operation: () => Promise<{ revision: number }>,
) {
  try {
    return reply.code(statusCode).send(await operation());
  } catch (cause) {
    return sendDepartmentError(reply, cause);
  }
}

export async function departmentRoutes(app: FastifyInstance) {
  app.get('/', {
    preHandler: app.authenticate,
  }, asyncRoute(async (request) => getSafeOrganization(
    request.user.workspaceId,
  )));

  app.post('/', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(createDepartmentInput, request.body, reply);
    if (!input) return;
    return sendMutation(reply, 201, () => createDepartment({
      ...input,
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
    }));
  }));

  app.patch('/:id', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(departmentIdParams, request.params, reply);
    if (!params) return;
    const input = parse(updateDepartmentInput, request.body, reply);
    if (!input) return;
    return sendMutation(reply, 200, () => updateDepartment({
      ...input,
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
      departmentId: params.id,
    }));
  }));

  app.delete('/:id', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(departmentIdParams, request.params, reply);
    if (!params) return;
    const input = parse(revisionInput, request.body, reply);
    if (!input) return;
    return sendMutation(reply, 200, () => archiveDepartment({
      ...input,
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
      departmentId: params.id,
    }));
  }));

  app.put('/:id/members/:agentId', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(memberParams, request.params, reply);
    if (!params) return;
    const input = parse(membershipInput, request.body, reply);
    if (!input) return;
    return sendMutation(reply, 200, () => setMembership({
      ...input,
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
      departmentId: params.id,
      agentId: params.agentId,
    }));
  }));

  app.delete('/:id/members/:agentId', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(memberParams, request.params, reply);
    if (!params) return;
    const input = parse(revisionInput, request.body, reply);
    if (!input) return;
    return sendMutation(reply, 200, () => removeMembership({
      ...input,
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
      departmentId: params.id,
      agentId: params.agentId,
    }));
  }));

  app.put('/settings/executive', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(executiveInput, request.body, reply);
    if (!input) return;
    return sendMutation(reply, 200, () => setExecutiveAgent({
      ...input,
      workspaceId: request.user.workspaceId,
      actorId: request.user.sub,
    }));
  }));
}
