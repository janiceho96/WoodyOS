import type { Edge, Node } from '@xyflow/react';
import type {
  Department,
  OrganizationAgentSummary,
  OrganizationSnapshot,
} from '../../api';
import type { DepartmentView } from './departmentState';

export type DepartmentNodeKind =
  | 'workspace'
  | 'executive'
  | 'department'
  | 'manager'
  | 'agent'
  | 'shared-rail'
  | 'shared-agent';

export type DepartmentNodeData = Record<string, unknown> & {
  kind: DepartmentNodeKind;
  name: string;
  departmentId?: string;
  agentId?: string;
  description?: string;
  role?: string;
  status?: OrganizationAgentSummary['status'] | Department['status'];
  activeWorkCount?: number;
  memberCount?: number;
  apiToolCount?: number;
  mcpConnectionCount?: number;
};

export type DepartmentEdgeData = Record<string, unknown> & {
  kind: 'primary' | 'shared';
};

export type DepartmentGraphNode = Node<DepartmentNodeData, 'departmentOrg'>;
export type DepartmentGraphEdge = Edge<DepartmentEdgeData>;

export type DepartmentGraphOptions = {
  view: DepartmentView;
  workspaceName?: string;
  focusId?: string | null;
  visibleAgentIds?: ReadonlySet<string>;
  departmentId?: string;
};

const departmentGap = 330;
const memberGap = 126;
const departmentTop = 244;
const memberTop = 372;

function compareDepartment(left: Department, right: Department) {
  return left.displayOrder - right.displayOrder
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function compareAgent(left: OrganizationAgentSummary, right: OrganizationAgentSummary) {
  return left.role.localeCompare(right.role)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function agentNodeData(
  agent: OrganizationAgentSummary,
  kind: Extract<DepartmentNodeKind, 'executive' | 'manager' | 'agent' | 'shared-agent'>,
): DepartmentNodeData {
  return {
    kind,
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    activeWorkCount: agent.activeWorkCount,
    apiToolCount: agent.apiToolCount,
    mcpConnectionCount: agent.mcpConnectionCount,
  };
}

function primaryEdge(source: string, target: string): DepartmentGraphEdge {
  return {
    id: `primary:${source}:${target}`,
    source,
    target,
    data: { kind: 'primary' },
    type: 'smoothstep',
  };
}

function sharedEdge(departmentId: string, agentId: string): DepartmentGraphEdge {
  return {
    id: `shared:${departmentId}:${agentId}`,
    source: `department:${departmentId}`,
    target: `agent:${agentId}`,
    data: { kind: 'shared' },
    type: 'smoothstep',
    animated: false,
    style: { strokeDasharray: '6 5' },
  };
}

export function buildDepartmentGraph(
  snapshot: OrganizationSnapshot,
  options: DepartmentGraphOptions,
): { nodes: DepartmentGraphNode[]; edges: DepartmentGraphEdge[] } {
  const allDepartments = snapshot.departments
    .filter((department) => department.status === 'active')
    .sort(compareDepartment);
  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const focusDepartmentId = options.focusId?.startsWith('department:')
    ? options.focusId.slice('department:'.length)
    : null;
  const focusAgentId = options.focusId?.startsWith('agent:')
    ? options.focusId.slice('agent:'.length)
    : null;
  const visibleAgent = (agentId: string) => (
    agentId === snapshot.executiveAgentId
    || agentId === focusAgentId
    || !options.visibleAgentIds
    || options.visibleAgentIds.has(agentId)
  );
  const focusAgentDepartments = focusAgentId
    ? new Set(snapshot.memberships.filter((membership) => (
      membership.agentId === focusAgentId
    )).map((membership) => membership.departmentId))
    : null;
  const departments = allDepartments.filter((department) => (
    (!options.departmentId || options.departmentId === 'all' || department.id === options.departmentId)
    && (!focusDepartmentId || department.id === focusDepartmentId)
    && (!focusAgentDepartments
      || focusAgentDepartments.has(department.id)
      || department.managerAgentId === focusAgentId)
  ));
  const departmentIds = new Set(departments.map((department) => department.id));
  const sharedAgentIds = new Set(snapshot.memberships.filter((membership) => (
    membership.membershipType === 'shared'
    && membership.agentId !== snapshot.executiveAgentId
  )).map((membership) => membership.agentId));
  const rootX = departments.length > 1 ? ((departments.length - 1) * departmentGap) / 2 : 0;
  const nodes: DepartmentGraphNode[] = [{
    id: 'workspace',
    type: 'departmentOrg',
    position: { x: rootX, y: 18 },
    data: { kind: 'workspace', name: options.workspaceName ?? 'Workspace' },
    draggable: false,
  }];
  const edges: DepartmentGraphEdge[] = [];

  const executive = snapshot.executiveAgentId
    ? agentById.get(snapshot.executiveAgentId)
    : undefined;
  if (executive) {
    const executiveDepartments = snapshot.memberships.filter((membership) => (
      membership.agentId === executive.id
    )).map((membership) => allDepartments.find((department) => (
      department.id === membership.departmentId
    ))?.name).filter((name): name is string => Boolean(name));
    nodes.push({
      id: `agent:${executive.id}`,
      type: 'departmentOrg',
      position: { x: rootX, y: 126 },
      data: {
        ...agentNodeData(executive, 'executive'),
        description: executiveDepartments.length
          ? `Department reference: ${executiveDepartments.join(', ')}`
          : 'No Department membership',
      },
      draggable: false,
    });
    edges.push(primaryEdge('workspace', `agent:${executive.id}`));
  }
  const departmentParent = executive ? `agent:${executive.id}` : 'workspace';

  departments.forEach((department, departmentIndex) => {
    const x = departmentIndex * departmentGap;
    const departmentNodeId = `department:${department.id}`;
    const summaryAgentIds = new Set(snapshot.memberships.filter((membership) => (
      membership.departmentId === department.id
    )).map((membership) => membership.agentId));
    const summaryAgents = [...summaryAgentIds].map((agentId) => agentById.get(agentId))
      .filter((agent): agent is OrganizationAgentSummary => Boolean(agent));
    nodes.push({
      id: departmentNodeId,
      type: 'departmentOrg',
      position: { x, y: departmentTop },
      data: {
        kind: 'department',
        name: department.name,
        description: department.description,
        departmentId: department.id,
        status: department.status,
        memberCount: summaryAgents.length,
        activeWorkCount: summaryAgents.reduce((total, agent) => total + agent.activeWorkCount, 0),
      },
      draggable: false,
    });
    edges.push(primaryEdge(departmentParent, departmentNodeId));

    const primaryAgentIds = snapshot.memberships.filter((membership) => (
      membership.departmentId === department.id
      && membership.membershipType === 'primary'
      && membership.agentId !== snapshot.executiveAgentId
      && visibleAgent(membership.agentId)
      && (!focusAgentId || membership.agentId === focusAgentId)
    )).map((membership) => membership.agentId);
    const primaryAgents = primaryAgentIds
      .map((agentId) => agentById.get(agentId))
      .filter((agent): agent is OrganizationAgentSummary => Boolean(agent))
      .sort(compareAgent);
    const manager = department.managerAgentId && primaryAgents.find((agent) => (
      agent.id === department.managerAgentId
    ));
    const orderedAgents = manager
      ? [manager, ...primaryAgents.filter((agent) => agent.id !== manager.id)]
      : primaryAgents;
    const managerNodeId = manager ? `agent:${manager.id}` : null;

    orderedAgents.forEach((agent, memberIndex) => {
      if (sharedAgentIds.has(agent.id)) return;
      const nodeId = `agent:${agent.id}`;
      nodes.push({
        id: nodeId,
        type: 'departmentOrg',
        position: { x, y: memberTop + memberIndex * memberGap },
        data: agentNodeData(agent, agent.id === department.managerAgentId ? 'manager' : 'agent'),
        draggable: false,
      });
      edges.push(primaryEdge(
        managerNodeId && agent.id !== department.managerAgentId
          ? managerNodeId
          : departmentNodeId,
        nodeId,
      ));
    });
  });

  const sharedAgents = [...sharedAgentIds]
    .filter((agentId) => visibleAgent(agentId) && (!focusAgentId || focusAgentId === agentId))
    .map((agentId) => agentById.get(agentId))
    .filter((agent): agent is OrganizationAgentSummary => Boolean(agent))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  if (sharedAgents.length) {
    const railX = departments.length * departmentGap + 72;
    nodes.push({
      id: 'shared-rail',
      type: 'departmentOrg',
      position: { x: railX, y: departmentTop },
      data: { kind: 'shared-rail', name: 'Shared specialists' },
      draggable: false,
    });
    sharedAgents.forEach((agent, index) => {
      const nodeId = `agent:${agent.id}`;
      nodes.push({
        id: nodeId,
        type: 'departmentOrg',
        position: { x: railX, y: memberTop + index * memberGap },
        data: agentNodeData(agent, 'shared-agent'),
        draggable: false,
      });
      const primary = snapshot.memberships.find((membership) => (
        membership.agentId === agent.id
        && membership.membershipType === 'primary'
        && departmentIds.has(membership.departmentId)
      ));
      if (primary) edges.push(primaryEdge(`department:${primary.departmentId}`, nodeId));
    });
  }

  if (options.view === 'collaboration' || options.focusId) {
    snapshot.memberships.filter((membership) => (
      membership.membershipType === 'shared'
      && departmentIds.has(membership.departmentId)
      && nodes.some((node) => node.id === `agent:${membership.agentId}`)
    )).forEach((membership) => {
      edges.push(sharedEdge(membership.departmentId, membership.agentId));
    });
  }

  return { nodes, edges };
}
