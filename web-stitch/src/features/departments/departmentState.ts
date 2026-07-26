import {
  DepartmentApiError,
  type OrganizationAgentSummary,
  type OrganizationSnapshot,
  type Session,
} from '../../api';

export type DepartmentView = 'org' | 'collaboration';
export type DepartmentCanvasMode = 'graph' | 'list';
export type BinaryFilter = 'any' | 'yes' | 'no';
export type DepartmentFilters = {
  departmentId: string;
  role: string;
  status: string;
  activeWork: BinaryFilter;
  mcpAccess: BinaryFilter;
  apiToolAccess: BinaryFilter;
};

export const emptyDepartmentFilters: DepartmentFilters = {
  departmentId: 'all',
  role: 'all',
  status: 'all',
  activeWork: 'any',
  mcpAccess: 'any',
  apiToolAccess: 'any',
};

export function initialDepartmentView(): DepartmentView {
  return 'org';
}

export function nextDepartmentView(
  current: DepartmentView,
  action: 'show-org' | 'show-collaboration',
): DepartmentView {
  if (action === 'show-org') return 'org';
  if (action === 'show-collaboration') return 'collaboration';
  return current;
}

export function initialDepartmentCanvasMode(smallScreen: boolean): DepartmentCanvasMode {
  return smallScreen ? 'list' : 'graph';
}

export function nextDepartmentCanvasMode(
  current: DepartmentCanvasMode,
  action: 'show-graph' | 'show-list',
): DepartmentCanvasMode {
  if (action === 'show-graph') return 'graph';
  if (action === 'show-list') return 'list';
  return current;
}

function matchesCountFilter(value: number, filter: BinaryFilter) {
  if (filter === 'any') return true;
  return filter === 'yes' ? value > 0 : value === 0;
}

export function filteredDepartmentAgentIds(
  snapshot: OrganizationSnapshot,
  filters: DepartmentFilters,
): Set<string> {
  const departmentAgentIds = filters.departmentId === 'all'
    ? null
    : new Set(
      snapshot.memberships
        .filter((membership) => membership.departmentId === filters.departmentId)
        .map((membership) => membership.agentId),
    );
  return new Set(snapshot.agents.filter((agent) => (
    (!departmentAgentIds || departmentAgentIds.has(agent.id))
    && (filters.role === 'all' || agent.role === filters.role)
    && (filters.status === 'all' || agent.status === filters.status)
    && matchesCountFilter(agent.activeWorkCount, filters.activeWork)
    && matchesCountFilter(agent.mcpConnectionCount, filters.mcpAccess)
    && matchesCountFilter(agent.apiToolCount, filters.apiToolAccess)
  )).map((agent) => agent.id));
}

export function primaryDepartmentId(
  snapshot: OrganizationSnapshot,
  agentId: string,
): string | null {
  return snapshot.memberships.find((membership) => (
    membership.agentId === agentId && membership.membershipType === 'primary'
  ))?.departmentId ?? null;
}

export function sharedDepartmentIds(
  snapshot: OrganizationSnapshot,
  agentId: string,
): string[] {
  return snapshot.memberships.filter((membership) => (
    membership.agentId === agentId && membership.membershipType === 'shared'
  )).map((membership) => membership.departmentId);
}

export function unassignedDepartmentAgents(
  snapshot: OrganizationSnapshot,
): OrganizationAgentSummary[] {
  const assigned = new Set(snapshot.memberships.filter((membership) => (
    membership.membershipType === 'primary'
  )).map((membership) => membership.agentId));
  return snapshot.agents.filter((agent) => !assigned.has(agent.id) && agent.status !== 'archived')
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function canEditDepartmentStructure(
  role: Session['workspace']['role'],
): boolean {
  return role === 'owner' || role === 'admin';
}

export function requiresPrimaryMoveConfirmation({
  currentPrimaryDepartmentId,
  nextDepartmentId,
}: {
  currentPrimaryDepartmentId: string | null;
  nextDepartmentId: string;
}): boolean {
  return currentPrimaryDepartmentId !== null
    && currentPrimaryDepartmentId !== nextDepartmentId;
}

export type DepartmentMutationFailure = {
  message: string;
  refresh: boolean;
};

const departmentErrorMessages: Partial<Record<DepartmentApiError['code'], string>> = {
  DEPARTMENT_NAME_CONFLICT: 'Another active Department already uses that name.',
  DEPARTMENT_ARCHIVED: 'This Department is archived and can no longer be changed.',
  DEPARTMENT_MANAGER_INACTIVE: 'Choose an active agent as Department manager.',
  DEPARTMENT_EXECUTIVE_INVALID: 'Choose an active agent as executive.',
  DEPARTMENT_PRIMARY_MOVE_CONFIRMATION_REQUIRED: 'Confirm the primary Department move before saving.',
  DEPARTMENT_ACTOR_INVALID: 'Your workspace role does not allow Department changes.',
  DEPARTMENT_NOT_FOUND: 'This Department no longer exists.',
  DEPARTMENT_AGENT_NOT_FOUND: 'This agent no longer exists in the workspace.',
  DEPARTMENT_MEMBERSHIP_NOT_FOUND: 'That Department assignment no longer exists.',
};

export function departmentMutationFailure(cause: unknown): DepartmentMutationFailure {
  if (cause instanceof DepartmentApiError) {
    if (cause.code === 'DEPARTMENT_REVISION_CONFLICT') {
      return {
        refresh: true,
        message: 'The organization changed in another session. Woody refreshed the latest structure; review it and try again.',
      };
    }
    return {
      refresh: cause.code === 'DEPARTMENT_NOT_FOUND'
        || cause.code === 'DEPARTMENT_AGENT_NOT_FOUND'
        || cause.code === 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
        || cause.code === 'DEPARTMENT_ARCHIVED',
      message: departmentErrorMessages[cause.code] ?? 'Woody could not update the organization.',
    };
  }
  return {
    refresh: false,
    message: cause instanceof Error ? cause.message : 'Woody could not update the organization.',
  };
}
