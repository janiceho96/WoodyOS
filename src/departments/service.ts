import type { PoolClient, QueryResultRow } from 'pg';
import { db } from '../db/client.js';
import {
  DepartmentError,
  type ArchiveDepartmentInput,
  type CreateDepartmentInput,
  type DepartmentMembershipRecord,
  type DepartmentMutationResult,
  type DepartmentRecord,
  type MembershipType,
  type OrganizationSnapshot,
  type RemoveMembershipInput,
  type SetExecutiveAgentInput,
  type SetMembershipInput,
  type SetMembershipWithManagerInput,
  type UpdateDepartmentInput,
} from './types.js';

type DepartmentRow = QueryResultRow & {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  display_order: number;
  manager_agent_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type MembershipRow = QueryResultRow & {
  department_id: string;
  workspace_id: string;
  agent_id: string;
  membership_type: MembershipType;
  created_at: Date;
  updated_at: Date;
};

type MutationContext = {
  client: PoolClient;
  workspaceId: string;
  currentRevision: number;
};

type MutationAudit = {
  action: string;
  entityType: string;
  entityId: string | null;
  metadata?: Record<string, unknown>;
};

type PostgreSqlError = {
  code?: string;
  constraint?: string;
};

function departmentError(
  code: ConstructorParameters<typeof DepartmentError>[0],
  options: ConstructorParameters<typeof DepartmentError>[2] = {},
) {
  const statusCode = {
    DEPARTMENT_NOT_FOUND: 404,
    DEPARTMENT_ARCHIVED: 409,
    DEPARTMENT_NAME_CONFLICT: 409,
    DEPARTMENT_REVISION_CONFLICT: 409,
    DEPARTMENT_AGENT_NOT_FOUND: 404,
    DEPARTMENT_MANAGER_INACTIVE: 409,
    DEPARTMENT_EXECUTIVE_INVALID: 422,
    DEPARTMENT_MEMBERSHIP_NOT_FOUND: 404,
    DEPARTMENT_PRIMARY_MOVE_CONFIRMATION_REQUIRED: 409,
    DEPARTMENT_ACTOR_INVALID: 403,
  }[code];
  return new DepartmentError(code, statusCode, options);
}

function mapDepartment(row: DepartmentRow): DepartmentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    status: row.status,
    displayOrder: row.display_order,
    managerAgentId: row.manager_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMembership(row: MembershipRow): DepartmentMembershipRecord {
  return {
    departmentId: row.department_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    membershipType: row.membership_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function activeDepartmentForUpdate(
  client: PoolClient,
  workspaceId: string,
  departmentId: string,
) {
  const department = (await client.query<Pick<DepartmentRow, 'id' | 'status' | 'manager_agent_id'>>(
    `SELECT id,status,manager_agent_id
       FROM departments
      WHERE id=$1 AND workspace_id=$2
      FOR UPDATE`,
    [departmentId, workspaceId],
  )).rows[0];
  if (!department) throw departmentError('DEPARTMENT_NOT_FOUND');
  if (department.status === 'archived') throw departmentError('DEPARTMENT_ARCHIVED');
  return department;
}

async function agentForUpdate(
  client: PoolClient,
  workspaceId: string,
  agentId: string,
) {
  const agent = (await client.query<{ id: string; status: string }>(
    `SELECT id,status
       FROM agents
      WHERE id=$1 AND workspace_id=$2
      FOR UPDATE`,
    [agentId, workspaceId],
  )).rows[0];
  if (!agent) throw departmentError('DEPARTMENT_AGENT_NOT_FOUND');
  return agent;
}

async function ensureManagerPrimary(input: {
  client: PoolClient;
  workspaceId: string;
  departmentId: string | null;
  managerAgentId: string;
  confirmPrimaryMove?: boolean;
}) {
  const manager = await agentForUpdate(
    input.client,
    input.workspaceId,
    input.managerAgentId,
  );
  if (manager.status !== 'active') {
    throw departmentError('DEPARTMENT_MANAGER_INACTIVE');
  }

  const primary = (await input.client.query<{ department_id: string }>(
    `SELECT department_id
       FROM department_memberships
      WHERE workspace_id=$1
        AND agent_id=$2
        AND membership_type='primary'
      FOR UPDATE`,
    [input.workspaceId, input.managerAgentId],
  )).rows[0];
  if (
    primary
    && primary.department_id !== input.departmentId
    && input.confirmPrimaryMove !== true
  ) {
    throw departmentError('DEPARTMENT_PRIMARY_MOVE_CONFIRMATION_REQUIRED');
  }

  if (input.departmentId === null) return;

  await input.client.query(
    `UPDATE departments
        SET manager_agent_id=NULL,updated_at=now()
      WHERE workspace_id=$1
        AND manager_agent_id=$2
        AND id<>$3
        AND status='active'`,
    [input.workspaceId, input.managerAgentId, input.departmentId],
  );
  await input.client.query(
    `DELETE FROM department_memberships
      WHERE workspace_id=$1
        AND agent_id=$2
        AND membership_type='primary'
        AND department_id<>$3`,
    [input.workspaceId, input.managerAgentId, input.departmentId],
  );
  await input.client.query(
    `INSERT INTO department_memberships(
       department_id,workspace_id,agent_id,membership_type
     ) VALUES($1,$2,$3,'primary')
     ON CONFLICT(department_id,agent_id) DO UPDATE
       SET membership_type='primary',
           updated_at=now()
     WHERE department_memberships.workspace_id=excluded.workspace_id`,
    [input.departmentId, input.workspaceId, input.managerAgentId],
  );
}

function translatedPostgreSqlError(
  cause: unknown,
  currentRevision?: number,
) {
  if (cause instanceof DepartmentError) return cause;
  const error = cause as PostgreSqlError;
  if (
    error.code === '23505'
    && error.constraint === 'departments_active_name_idx'
  ) {
    return departmentError('DEPARTMENT_NAME_CONFLICT', { cause });
  }
  if (
    error.code === '23505'
    && (
      error.constraint === 'department_memberships_one_primary_idx'
      || error.constraint === 'department_memberships_pkey'
    )
  ) {
    return departmentError('DEPARTMENT_REVISION_CONFLICT', {
      currentRevision,
      cause,
    });
  }
  if (error.code === '40001' || error.code === '40P01') {
    return departmentError('DEPARTMENT_REVISION_CONFLICT', {
      currentRevision,
      cause,
    });
  }
  return cause;
}

async function mutateOrganization(
  input: {
    workspaceId: string;
    actorId: string;
    expectedRevision: number;
  },
  mutation: (context: MutationContext) => Promise<MutationAudit>,
): Promise<DepartmentMutationResult> {
  const client = await db.connect();
  let currentRevision: number | undefined;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO workspace_org_settings(workspace_id)
       VALUES($1)
       ON CONFLICT(workspace_id) DO NOTHING`,
      [input.workspaceId],
    );
    const settings = (await client.query<{ revision: number }>(
      `SELECT revision
         FROM workspace_org_settings
        WHERE workspace_id=$1
        FOR UPDATE`,
      [input.workspaceId],
    )).rows[0];
    if (!settings) throw departmentError('DEPARTMENT_REVISION_CONFLICT');
    currentRevision = settings.revision;
    if (input.expectedRevision !== currentRevision) {
      throw departmentError('DEPARTMENT_REVISION_CONFLICT', {
        currentRevision,
      });
    }
    const actor = await client.query(
      `SELECT 1
         FROM workspace_memberships
        WHERE workspace_id=$1 AND user_id=$2
        FOR KEY SHARE`,
      [input.workspaceId, input.actorId],
    );
    if (!actor.rowCount) throw departmentError('DEPARTMENT_ACTOR_INVALID');

    const audit = await mutation({
      client,
      workspaceId: input.workspaceId,
      currentRevision,
    });
    const nextRevision = (await client.query<{ revision: number }>(
      `UPDATE workspace_org_settings
          SET revision=revision+1,updated_at=now()
        WHERE workspace_id=$1
        RETURNING revision`,
      [input.workspaceId],
    )).rows[0].revision;
    await client.query(
      `INSERT INTO audit_events(
         workspace_id,actor_id,action,entity_type,entity_id,metadata
       ) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        input.workspaceId,
        input.actorId,
        audit.action,
        audit.entityType,
        audit.entityId,
        {
          ...(audit.metadata ?? {}),
          revision: nextRevision,
        },
      ],
    );
    await client.query('COMMIT');
    return { revision: nextRevision };
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw translatedPostgreSqlError(cause, currentRevision);
  } finally {
    client.release();
  }
}

export async function getOrganization(
  workspaceId: string,
): Promise<OrganizationSnapshot> {
  const client = await db.connect();
  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const settings = (await client.query<{
      revision: number;
      executive_agent_id: string | null;
    }>(
      `SELECT revision,executive_agent_id
         FROM workspace_org_settings
        WHERE workspace_id=$1`,
      [workspaceId],
    )).rows[0];
    const departments = (await client.query<DepartmentRow>(
      `SELECT id,workspace_id,name,description,status,display_order,
              manager_agent_id,created_at,updated_at
         FROM departments
        WHERE workspace_id=$1
        ORDER BY display_order,name,id`,
      [workspaceId],
    )).rows.map(mapDepartment);
    const memberships = (await client.query<MembershipRow>(
      `SELECT department_id,workspace_id,agent_id,membership_type,
              created_at,updated_at
         FROM department_memberships
        WHERE workspace_id=$1
        ORDER BY department_id,agent_id`,
      [workspaceId],
    )).rows.map(mapMembership);
    await client.query('COMMIT');
    return {
      revision: settings?.revision ?? 1,
      executiveAgentId: settings?.executive_agent_id ?? null,
      departments,
      memberships,
    };
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

export async function createDepartment(
  input: CreateDepartmentInput,
): Promise<DepartmentMutationResult> {
  return mutateOrganization(input, async ({ client, workspaceId }) => {
    if (input.managerAgentId) {
      await ensureManagerPrimary({
        client,
        workspaceId,
        departmentId: null,
        managerAgentId: input.managerAgentId,
        confirmPrimaryMove: input.confirmPrimaryMove,
      });
    }
    const department = (await client.query<{ id: string }>(
      `INSERT INTO departments(
         workspace_id,name,description,display_order,manager_agent_id
       ) VALUES($1,$2,$3,$4,$5)
       RETURNING id`,
      [
        workspaceId,
        input.name,
        input.description ?? '',
        input.displayOrder ?? 0,
        input.managerAgentId ?? null,
      ],
    )).rows[0];
    if (input.managerAgentId) {
      await ensureManagerPrimary({
        client,
        workspaceId,
        departmentId: department.id,
        managerAgentId: input.managerAgentId,
        confirmPrimaryMove: input.confirmPrimaryMove,
      });
    }
    return {
      action: 'department.created',
      entityType: 'department',
      entityId: department.id,
    };
  });
}

export async function updateDepartment(
  input: UpdateDepartmentInput,
): Promise<DepartmentMutationResult> {
  return mutateOrganization(input, async ({ client, workspaceId }) => {
    await activeDepartmentForUpdate(client, workspaceId, input.departmentId);
    if (input.managerAgentId) {
      await ensureManagerPrimary({
        client,
        workspaceId,
        departmentId: input.departmentId,
        managerAgentId: input.managerAgentId,
        confirmPrimaryMove: input.confirmPrimaryMove,
      });
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column}=$${values.length}`);
    };
    if (input.name !== undefined) assign('name', input.name);
    if (input.description !== undefined) {
      assign('description', input.description);
    }
    if (input.displayOrder !== undefined) {
      assign('display_order', input.displayOrder);
    }
    if (input.managerAgentId !== undefined) {
      assign('manager_agent_id', input.managerAgentId);
    }
    if (assignments.length > 0) {
      values.push(input.departmentId, workspaceId);
      await client.query(
        `UPDATE departments
            SET ${assignments.join(',')},updated_at=now()
          WHERE id=$${values.length - 1} AND workspace_id=$${values.length}`,
        values,
      );
    }
    return {
      action: 'department.updated',
      entityType: 'department',
      entityId: input.departmentId,
    };
  });
}

export async function setMembership(
  input: SetMembershipInput,
): Promise<DepartmentMutationResult> {
  return mutateOrganization(input, async ({ client, workspaceId }) => {
    await setMembershipWithClient({
      client,
      workspaceId,
      departmentId: input.departmentId,
      agentId: input.agentId,
      membershipType: input.membershipType,
    });
    return {
      action: 'department.membership_set',
      entityType: 'department_membership',
      entityId: input.departmentId,
      metadata: {
        agentId: input.agentId,
        membershipType: input.membershipType,
      },
    };
  });
}

async function setMembershipWithClient(input: {
  client: PoolClient;
  workspaceId: string;
  departmentId: string;
  agentId: string;
  membershipType: MembershipType;
}) {
  const {
    client,
    workspaceId,
    departmentId,
    agentId,
    membershipType,
  } = input;
  await activeDepartmentForUpdate(client, workspaceId, departmentId);
  await agentForUpdate(client, workspaceId, agentId);

  if (membershipType === 'primary') {
    await client.query(
      `UPDATE departments
          SET manager_agent_id=NULL,updated_at=now()
        WHERE workspace_id=$1
          AND manager_agent_id=$2
          AND id<>$3
          AND status='active'`,
      [workspaceId, agentId, departmentId],
    );
    await client.query(
      `DELETE FROM department_memberships
        WHERE workspace_id=$1
          AND agent_id=$2
          AND membership_type='primary'
          AND department_id<>$3`,
      [workspaceId, agentId, departmentId],
    );
  } else {
    await client.query(
      `UPDATE departments
          SET manager_agent_id=NULL,updated_at=now()
        WHERE id=$1
          AND workspace_id=$2
          AND manager_agent_id=$3`,
      [departmentId, workspaceId, agentId],
    );
  }

  await client.query(
    `INSERT INTO department_memberships(
       department_id,workspace_id,agent_id,membership_type
     ) VALUES($1,$2,$3,$4)
     ON CONFLICT(department_id,agent_id) DO UPDATE
       SET membership_type=excluded.membership_type,
           updated_at=now()
     WHERE department_memberships.workspace_id=excluded.workspace_id`,
    [departmentId, workspaceId, agentId, membershipType],
  );
}

export async function setMembershipWithManager(
  input: SetMembershipWithManagerInput,
): Promise<DepartmentMutationResult> {
  return mutateOrganization(input, async ({ client, workspaceId }) => {
    await activeDepartmentForUpdate(
      client,
      workspaceId,
      input.departmentId,
    );
    if (input.managerAgentId) {
      await ensureManagerPrimary({
        client,
        workspaceId,
        departmentId: input.departmentId,
        managerAgentId: input.managerAgentId,
        confirmPrimaryMove: input.confirmPrimaryMove,
      });
      await client.query(
        `UPDATE departments
            SET manager_agent_id=$1,updated_at=now()
          WHERE id=$2 AND workspace_id=$3`,
        [input.managerAgentId, input.departmentId, workspaceId],
      );
    }
    await setMembershipWithClient({
      client,
      workspaceId,
      departmentId: input.departmentId,
      agentId: input.agentId,
      membershipType: input.membershipType,
    });
    return {
      action: 'department.membership_set',
      entityType: 'department_membership',
      entityId: input.departmentId,
      metadata: {
        agentId: input.agentId,
        membershipType: input.membershipType,
        ...(input.managerAgentId
          ? { managerAgentId: input.managerAgentId }
          : {}),
      },
    };
  });
}

export async function removeMembership(
  input: RemoveMembershipInput,
): Promise<DepartmentMutationResult> {
  return mutateOrganization(input, async ({ client, workspaceId }) => {
    await activeDepartmentForUpdate(client, workspaceId, input.departmentId);
    await agentForUpdate(client, workspaceId, input.agentId);
    const removed = await client.query(
      `DELETE FROM department_memberships
        WHERE department_id=$1
          AND workspace_id=$2
          AND agent_id=$3
        RETURNING membership_type`,
      [input.departmentId, workspaceId, input.agentId],
    );
    if (!removed.rowCount) {
      throw departmentError('DEPARTMENT_MEMBERSHIP_NOT_FOUND');
    }
    await client.query(
      `UPDATE departments
          SET manager_agent_id=NULL,updated_at=now()
        WHERE id=$1
          AND workspace_id=$2
          AND manager_agent_id=$3`,
      [input.departmentId, workspaceId, input.agentId],
    );
    return {
      action: 'department.membership_removed',
      entityType: 'department_membership',
      entityId: input.departmentId,
      metadata: { agentId: input.agentId },
    };
  });
}

export async function archiveDepartment(
  input: ArchiveDepartmentInput,
): Promise<DepartmentMutationResult> {
  return mutateOrganization(input, async ({ client, workspaceId }) => {
    await activeDepartmentForUpdate(client, workspaceId, input.departmentId);
    await client.query(
      `UPDATE department_memberships
          SET membership_type='shared',updated_at=now()
        WHERE department_id=$1
          AND workspace_id=$2
          AND membership_type='primary'`,
      [input.departmentId, workspaceId],
    );
    await client.query(
      `UPDATE departments
          SET status='archived',updated_at=now()
        WHERE id=$1 AND workspace_id=$2`,
      [input.departmentId, workspaceId],
    );
    return {
      action: 'department.archived',
      entityType: 'department',
      entityId: input.departmentId,
    };
  });
}

export async function setExecutiveAgent(
  input: SetExecutiveAgentInput,
): Promise<DepartmentMutationResult> {
  return mutateOrganization(input, async ({ client, workspaceId }) => {
    if (input.agentId !== null) {
      const executive = (await client.query<{ id: string }>(
        `SELECT id
           FROM agents
          WHERE id=$1 AND workspace_id=$2
          FOR UPDATE`,
        [input.agentId, workspaceId],
      )).rows[0];
      if (!executive) {
        throw departmentError('DEPARTMENT_EXECUTIVE_INVALID');
      }
    }
    await client.query(
      `UPDATE workspace_org_settings
          SET executive_agent_id=$1,updated_at=now()
        WHERE workspace_id=$2`,
      [input.agentId, workspaceId],
    );
    return {
      action: 'department.executive_set',
      entityType: 'organization',
      entityId: workspaceId,
      metadata: { executiveAgentId: input.agentId },
    };
  });
}
