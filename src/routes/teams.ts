import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  archiveDepartment,
  createDepartment,
  getOrganization,
  removeMembership,
  setMembershipWithManager,
} from '../departments/service.js';
import {
  DepartmentError,
  type DepartmentErrorCode,
  type DepartmentRecord,
} from '../departments/types.js';
import { asyncRoute, parse } from '../lib/http.js';
import {
  getSafeOrganization,
  sendDepartmentError,
  type OrganizationAgentSummary,
  type SafeOrganizationResponse,
} from './departments.js';

const teamInput = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2_000).default(''),
});
const teamParams = z.object({ id: z.string().uuid() });
const membershipParams = teamParams.extend({ agentId: z.string().uuid() });
const legacyMembershipInput = z.object({
  managerAgentId: z.string().uuid().nullable().optional(),
  confirmPrimaryMove: z.boolean().optional(),
});

function legacyTeam(
  department: DepartmentRecord,
  organization: SafeOrganizationResponse,
  agents: Map<string, OrganizationAgentSummary>,
) {
  return {
    id: department.id,
    workspace_id: department.workspaceId,
    name: department.name,
    description: department.description,
    created_at: department.createdAt,
    members: organization.memberships
      .filter((membership) => membership.departmentId === department.id)
      .flatMap((membership) => {
        const agent = agents.get(membership.agentId);
        if (!agent) return [];
        return [{
          team_id: department.id,
          agent_id: membership.agentId,
          manager_agent_id: membership.agentId === department.managerAgentId
            ? null
            : department.managerAgentId,
          name: agent.name,
          role: agent.role,
        }];
      }),
  };
}

function legacyCreatedTeam(department: DepartmentRecord) {
  return {
    id: department.id,
    workspace_id: department.workspaceId,
    name: department.name,
    description: department.description,
    created_at: department.createdAt,
  };
}

async function currentRevision(workspaceId: string) {
  return (await getOrganization(workspaceId)).revision;
}

async function sendLegacyMutation<T>(
  reply: FastifyReply,
  operation: () => Promise<T>,
  errorCodes: Partial<Record<
    DepartmentErrorCode,
    string | { code: string; statusCode: number }
  >> = {},
) {
  try {
    return await operation();
  } catch (cause) {
    const mapped = cause instanceof DepartmentError
      ? errorCodes[cause.code]
      : undefined;
    if (cause instanceof DepartmentError && mapped) {
      return reply.code(
        typeof mapped === 'string' ? cause.statusCode : mapped.statusCode,
      ).send({
        error: typeof mapped === 'string' ? mapped : mapped.code,
      });
    }
    return sendDepartmentError(reply, cause);
  }
}

export async function teamRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Deprecation', 'true');
  });

  app.get('/', {
    preHandler: app.authenticate,
  }, asyncRoute(async (request) => {
    const organization = await getSafeOrganization(request.user.workspaceId);
    const agents = new Map(organization.agents.map((agent) => [agent.id, agent]));
    return {
      data: organization.departments
        .filter((department) => department.status === 'active')
        .map((department) => legacyTeam(department, organization, agents)),
    };
  }));

  app.post('/', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const input = parse(teamInput, request.body, reply);
    if (!input) return;
    return sendLegacyMutation(reply, async () => {
      const before = await getOrganization(request.user.workspaceId);
      const result = await createDepartment({
        workspaceId: request.user.workspaceId,
        actorId: request.user.sub,
        expectedRevision: before.revision,
        name: input.name,
        description: input.description,
      });
      const after = await getOrganization(request.user.workspaceId);
      const previousIds = new Set(before.departments.map((department) => (
        department.id
      )));
      const created = after.departments.find((department) => (
        !previousIds.has(department.id)
        && department.status === 'active'
        && department.name === input.name
      ));
      if (!created) {
        throw Object.assign(new Error('TEAM_CREATION_RESULT_MISSING'), {
          statusCode: 500,
        });
      }
      reply.header('X-Organization-Revision', String(result.revision));
      return reply.code(201).send(legacyCreatedTeam(created));
    });
  }));

  app.put('/:id/members/:agentId', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(membershipParams, request.params, reply);
    if (!params) return;
    const input = parse(legacyMembershipInput, request.body ?? {}, reply);
    if (!input) return;
    return sendLegacyMutation(reply, async () => {
      const result = await setMembershipWithManager({
        workspaceId: request.user.workspaceId,
        actorId: request.user.sub,
        expectedRevision: await currentRevision(request.user.workspaceId),
        departmentId: params.id,
        agentId: params.agentId,
        membershipType: 'primary',
        managerAgentId: input.managerAgentId,
        confirmPrimaryMove: input.confirmPrimaryMove,
      });
      reply.header('X-Organization-Revision', String(result.revision));
      return reply.send({
        team_id: params.id,
        agent_id: params.agentId,
        manager_agent_id: input.managerAgentId ?? null,
      });
    }, {
      DEPARTMENT_NOT_FOUND: 'TEAM_OR_AGENT_NOT_FOUND',
      DEPARTMENT_AGENT_NOT_FOUND: 'TEAM_OR_AGENT_NOT_FOUND',
      DEPARTMENT_ARCHIVED: {
        code: 'TEAM_OR_AGENT_NOT_FOUND',
        statusCode: 404,
      },
    });
  }));

  app.delete('/:id/members/:agentId', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(membershipParams, request.params, reply);
    if (!params) return;
    return sendLegacyMutation(reply, async () => {
      const result = await removeMembership({
        workspaceId: request.user.workspaceId,
        actorId: request.user.sub,
        expectedRevision: await currentRevision(request.user.workspaceId),
        departmentId: params.id,
        agentId: params.agentId,
      });
      reply.header('X-Organization-Revision', String(result.revision));
      return reply.code(204).send();
    }, {
      DEPARTMENT_NOT_FOUND: 'TEAM_MEMBERSHIP_NOT_FOUND',
      DEPARTMENT_AGENT_NOT_FOUND: 'TEAM_MEMBERSHIP_NOT_FOUND',
      DEPARTMENT_MEMBERSHIP_NOT_FOUND: 'TEAM_MEMBERSHIP_NOT_FOUND',
      DEPARTMENT_ARCHIVED: {
        code: 'TEAM_MEMBERSHIP_NOT_FOUND',
        statusCode: 404,
      },
    });
  }));

  app.delete('/:id', {
    preHandler: (request) => app.authorize(request, ['owner', 'admin']),
  }, asyncRoute(async (request, reply) => {
    const params = parse(teamParams, request.params, reply);
    if (!params) return;
    return sendLegacyMutation(reply, async () => {
      const result = await archiveDepartment({
        workspaceId: request.user.workspaceId,
        actorId: request.user.sub,
        expectedRevision: await currentRevision(request.user.workspaceId),
        departmentId: params.id,
      });
      reply.header('X-Organization-Revision', String(result.revision));
      return reply.code(204).send();
    }, {
      DEPARTMENT_NOT_FOUND: 'TEAM_NOT_FOUND',
      DEPARTMENT_ARCHIVED: {
        code: 'TEAM_NOT_FOUND',
        statusCode: 404,
      },
    });
  }));
}
