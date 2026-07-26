// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { DepartmentHierarchyList } from './DepartmentGraph';
import { organizationFixture } from './departmentTestFixture';

afterEach(cleanup);

it('provides a keyboard-operable hierarchy with one link per rendered agent', async () => {
  const user = userEvent.setup();
  const onFocus = vi.fn();
  render(
    <MemoryRouter>
      <DepartmentHierarchyList
        snapshot={organizationFixture}
        workspaceName="Acme"
        focusId={null}
        visibleAgentIds={new Set(organizationFixture.agents.map((agent) => agent.id))}
        onFocus={onFocus}
        onEditDepartment={vi.fn()}
        canEdit
      />
    </MemoryRouter>,
  );

  const hierarchy = screen.getByRole('navigation', { name: 'Department hierarchy' });
  expect(within(hierarchy).getByRole('heading', { name: 'Acme' })).toBeTruthy();
  expect(within(hierarchy).getAllByRole('link', { name: /Sam Specialist/ })).toHaveLength(1);
  expect(within(hierarchy).getByRole('link', { name: /Sam Specialist/ }).getAttribute('href')).toBe('/agents/shared-specialist');

  await user.tab();
  await user.keyboard('{Enter}');
  expect(onFocus).toHaveBeenCalled();
});

it('keeps read-only viewers out of Department mutation controls', () => {
  render(
    <MemoryRouter>
      <DepartmentHierarchyList
        snapshot={organizationFixture}
        workspaceName="Acme"
        focusId={null}
        visibleAgentIds={new Set(organizationFixture.agents.map((agent) => agent.id))}
        onFocus={vi.fn()}
        onEditDepartment={vi.fn()}
        canEdit={false}
      />
    </MemoryRouter>,
  );

  expect(screen.queryByRole('button', { name: /Edit Marketing/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Focus Marketing/ })).toBeTruthy();
});

it('uses the graph classification so filtered shared and executive agents render once', () => {
  const snapshot = structuredClone(organizationFixture);
  snapshot.memberships.push({
    departmentId: 'sales', workspaceId: 'workspace', agentId: 'executive', membershipType: 'shared',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
  });
  render(
    <MemoryRouter>
      <DepartmentHierarchyList
        snapshot={snapshot}
        workspaceName="Acme"
        focusId={null}
        visibleAgentIds={new Set(snapshot.agents.map((agent) => agent.id))}
        departmentId="sales"
        onFocus={vi.fn()}
        onEditDepartment={vi.fn()}
        canEdit
      />
    </MemoryRouter>,
  );

  expect(screen.getAllByRole('link', { name: /Sam Specialist/ })).toHaveLength(1);
  expect(screen.getAllByRole('link', { name: /Eli Executive/ })).toHaveLength(1);
});
