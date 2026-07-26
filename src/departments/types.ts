export type MembershipType = 'primary' | 'shared';

export type DepartmentStatus = 'active' | 'archived';

export type DepartmentErrorCode =
  | 'DEPARTMENT_NOT_FOUND'
  | 'DEPARTMENT_ARCHIVED'
  | 'DEPARTMENT_NAME_CONFLICT'
  | 'DEPARTMENT_REVISION_CONFLICT'
  | 'DEPARTMENT_AGENT_NOT_FOUND'
  | 'DEPARTMENT_MANAGER_INACTIVE'
  | 'DEPARTMENT_EXECUTIVE_INVALID'
  | 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
  | 'DEPARTMENT_PRIMARY_MOVE_CONFIRMATION_REQUIRED'
  | 'DEPARTMENT_ACTOR_INVALID';

export interface DepartmentRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: DepartmentStatus;
  displayOrder: number;
  managerAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DepartmentMembershipRecord {
  departmentId: string;
  workspaceId: string;
  agentId: string;
  membershipType: MembershipType;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationSnapshot {
  revision: number;
  executiveAgentId: string | null;
  departments: DepartmentRecord[];
  memberships: DepartmentMembershipRecord[];
}

export interface DepartmentMutationResult {
  revision: number;
}

interface RevisionedDepartmentMutation {
  workspaceId: string;
  actorId: string;
  expectedRevision: number;
}

interface ManagerSelection {
  managerAgentId?: string | null;
  confirmPrimaryMove?: boolean;
}

export interface CreateDepartmentInput
  extends RevisionedDepartmentMutation, ManagerSelection {
  name: string;
  description?: string;
  displayOrder?: number;
}

export interface UpdateDepartmentInput
  extends RevisionedDepartmentMutation, ManagerSelection {
  departmentId: string;
  name?: string;
  description?: string;
  displayOrder?: number;
}

export interface SetMembershipInput extends RevisionedDepartmentMutation {
  departmentId: string;
  agentId: string;
  membershipType: MembershipType;
}

export interface RemoveMembershipInput extends RevisionedDepartmentMutation {
  departmentId: string;
  agentId: string;
}

export interface ArchiveDepartmentInput extends RevisionedDepartmentMutation {
  departmentId: string;
}

export interface SetExecutiveAgentInput extends RevisionedDepartmentMutation {
  agentId: string | null;
}

export class DepartmentError extends Error {
  readonly code: DepartmentErrorCode;
  readonly statusCode: number;
  readonly currentRevision?: number;

  constructor(
    code: DepartmentErrorCode,
    statusCode: number,
    options: { currentRevision?: number; cause?: unknown } = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DepartmentError';
    this.code = code;
    this.statusCode = statusCode;
    this.currentRevision = options.currentRevision;
  }
}
