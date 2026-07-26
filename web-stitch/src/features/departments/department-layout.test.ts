// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DepartmentApiError, type OrganizationSnapshot } from '../../api';
import { primaryNavigation } from '../../app/navigation';
import { buildDepartmentGraph } from './departmentLayout';
import {
  canEditDepartmentStructure,
  departmentMutationFailure,
  filteredDepartmentAgentIds,
  initialDepartmentCanvasMode,
  initialDepartmentView,
  nextDepartmentCanvasMode,
  nextDepartmentView,
  requiresPrimaryMoveConfirmation,
  type DepartmentFilters,
} from './departmentState';

export const organizationFixture: OrganizationSnapshot = {
  revision: 7,
  executiveAgentId: 'executive',
  departments: [
    {
      id: 'marketing',
      workspaceId: 'workspace',
      name: 'Marketing',
      description: 'Growth and communications',
      status: 'active',
      displayOrder: 20,
      managerAgentId: 'marketing-manager',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 'sales',
      workspaceId: 'workspace',
      name: 'Sales',
      description: 'Revenue operations',
      status: 'active',
      displayOrder: 10,
      managerAgentId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  memberships: [
    {
      departmentId: 'marketing',
      workspaceId: 'workspace',
      agentId: 'executive',
      membershipType: 'primary',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      departmentId: 'marketing',
      workspaceId: 'workspace',
      agentId: 'marketing-manager',
      membershipType: 'primary',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      departmentId: 'marketing',
      workspaceId: 'workspace',
      agentId: 'researcher',
      membershipType: 'primary',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      departmentId: 'sales',
      workspaceId: 'workspace',
      agentId: 'shared-specialist',
      membershipType: 'primary',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      departmentId: 'marketing',
      workspaceId: 'workspace',
      agentId: 'shared-specialist',
      membershipType: 'shared',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ],
  agents: [
    {
      id: 'researcher',
      name: 'Ari Research',
      role: 'Researcher',
      status: 'paused',
      avatar: {},
      activeWorkCount: 0,
      apiToolCount: 0,
      mcpConnectionCount: 1,
    },
    {
      id: 'shared-specialist',
      name: 'Sam Specialist',
      role: 'Analyst',
      status: 'active',
      avatar: {},
      activeWorkCount: 2,
      apiToolCount: 1,
      mcpConnectionCount: 1,
    },
    {
      id: 'marketing-manager',
      name: 'Morgan Lead',
      role: 'Manager',
      status: 'active',
      avatar: {},
      activeWorkCount: 1,
      apiToolCount: 0,
      mcpConnectionCount: 0,
    },
    {
      id: 'executive',
      name: 'Eli Executive',
      role: 'Chief of Staff',
      status: 'active',
      avatar: {},
      activeWorkCount: 0,
      apiToolCount: 0,
      mcpConnectionCount: 0,
    },
    {
      id: 'unassigned',
      name: 'Una Assigned',
      role: 'Writer',
      status: 'draft',
      avatar: {},
      activeWorkCount: 0,
      apiToolCount: 1,
      mcpConnectionCount: 0,
    },
  ],
};

describe('Department graph layout', () => {
  it('always includes the workspace and keeps Department ordering deterministic', () => {
    const graph = buildDepartmentGraph(organizationFixture, {
      view: 'org',
      workspaceName: 'Acme',
    });

    expect(graph.nodes.find((node) => node.data.kind === 'workspace')?.data.name).toBe('Acme');
    const sales = graph.nodes.find((node) => node.id === 'department:sales');
    const marketing = graph.nodes.find((node) => node.id === 'department:marketing');
    expect(sales?.position.x).toBeLessThan(marketing?.position.x ?? 0);
  });

  it('renders each agent once and places shared agents in the shared rail', () => {
    const graph = buildDepartmentGraph(organizationFixture, { view: 'org' });

    expect(graph.nodes.filter((node) => node.data.agentId === 'shared-specialist')).toHaveLength(1);
    expect(graph.nodes.find((node) => node.data.agentId === 'shared-specialist')?.data.kind).toBe('shared-agent');
    expect(graph.nodes.filter((node) => node.data.agentId === 'executive')).toHaveLength(1);
    expect(graph.nodes.find((node) => node.data.agentId === 'executive')?.data.kind).toBe('executive');
  });

  it('places the manager ahead of the other primary Department members', () => {
    const graph = buildDepartmentGraph(organizationFixture, { view: 'org' });
    const manager = graph.nodes.find((node) => node.data.agentId === 'marketing-manager');
    const member = graph.nodes.find((node) => node.data.agentId === 'researcher');

    expect(manager?.position.y).toBeLessThan(member?.position.y ?? 0);
  });

  it('summarizes Department membership and active work without extra requests', () => {
    const graph = buildDepartmentGraph(organizationFixture, { view: 'org' });
    const marketing = graph.nodes.find((node) => node.id === 'department:marketing');

    expect(marketing?.data.memberCount).toBe(4);
    expect(marketing?.data.activeWorkCount).toBe(3);
  });

  it('shows shared edges only in collaboration view or focus mode', () => {
    expect(buildDepartmentGraph(organizationFixture, { view: 'org' }).edges.some((edge) => edge.data?.kind === 'shared')).toBe(false);
    expect(buildDepartmentGraph(organizationFixture, { view: 'collaboration' }).edges.some((edge) => edge.data?.kind === 'shared')).toBe(true);
    expect(buildDepartmentGraph(organizationFixture, { view: 'org', focusId: 'agent:shared-specialist' }).edges.some((edge) => edge.data?.kind === 'shared')).toBe(true);
  });

  it('keeps the workspace while focus mode hides unrelated Departments', () => {
    const graph = buildDepartmentGraph(organizationFixture, {
      view: 'collaboration',
      focusId: 'department:marketing',
    });

    expect(graph.nodes.some((node) => node.data.kind === 'workspace')).toBe(true);
    expect(graph.nodes.some((node) => node.id === 'department:marketing')).toBe(true);
    expect(graph.nodes.some((node) => node.id === 'department:sales')).toBe(false);
  });
});

describe('Department view state and filters', () => {
  it('places Department immediately after Agents in primary navigation', () => {
    const destinations = primaryNavigation.map((item) => item.label);
    expect(destinations.slice(
      destinations.indexOf('Agents'),
      destinations.indexOf('Agents') + 2,
    )).toEqual(['Agents', 'Department']);
  });

  it('keeps org view as the default and collaboration view explicit', () => {
    expect(initialDepartmentView()).toBe('org');
    expect(nextDepartmentView('org', 'show-collaboration')).toBe('collaboration');
    expect(nextDepartmentView('collaboration', 'show-org')).toBe('org');
  });

  it('defaults small screens to the accessible list while preserving an explicit user choice', () => {
    expect(initialDepartmentCanvasMode(true)).toBe('list');
    expect(initialDepartmentCanvasMode(false)).toBe('graph');
    expect(nextDepartmentCanvasMode('list', 'show-graph')).toBe('graph');
  });

  it('combines Department, role, status, work, MCP, and API Tool filters', () => {
    const filters: DepartmentFilters = {
      departmentId: 'marketing',
      role: 'Analyst',
      status: 'active',
      activeWork: 'yes',
      mcpAccess: 'yes',
      apiToolAccess: 'yes',
    };

    expect(filteredDepartmentAgentIds(organizationFixture, filters)).toEqual(new Set(['shared-specialist']));
  });
});

describe('Department mutation policy', () => {
  it('allows structural edits only for owners and admins', () => {
    expect(canEditDepartmentStructure('owner')).toBe(true);
    expect(canEditDepartmentStructure('admin')).toBe(true);
    expect(canEditDepartmentStructure('member')).toBe(false);
    expect(canEditDepartmentStructure('viewer')).toBe(false);
    expect(canEditDepartmentStructure(undefined)).toBe(false);
  });

  it('requires confirmation before moving a primary membership', () => {
    expect(requiresPrimaryMoveConfirmation({
      currentPrimaryDepartmentId: 'marketing',
      nextDepartmentId: 'sales',
    })).toBe(true);
    expect(requiresPrimaryMoveConfirmation({
      currentPrimaryDepartmentId: 'sales',
      nextDepartmentId: 'sales',
    })).toBe(false);
    expect(requiresPrimaryMoveConfirmation({
      currentPrimaryDepartmentId: null,
      nextDepartmentId: 'sales',
    })).toBe(false);
  });

  it('refreshes stale organization state and preserves a specific conflict message', () => {
    const failure = departmentMutationFailure(new DepartmentApiError(
      'DEPARTMENT_REVISION_CONFLICT',
      409,
      9,
    ));

    expect(failure).toEqual({
      refresh: true,
      message: 'The organization changed in another session. Woody refreshed the latest structure; review it and try again.',
    });
  });
});
