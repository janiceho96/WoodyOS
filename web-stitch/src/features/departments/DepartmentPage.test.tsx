// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DepartmentApiError, type Session } from '../../api';
import { api } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { DepartmentPage } from './DepartmentPage';
import { organizationFixture } from './departmentTestFixture';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return {
    ...actual,
    api: {
      departments: vi.fn(),
      createDepartment: vi.fn(),
      updateDepartment: vi.fn(),
      archiveDepartment: vi.fn(),
      setDepartmentMembership: vi.fn(),
      removeDepartmentMembership: vi.fn(),
      setExecutiveAgent: vi.fn(),
    },
  };
});

function workspace(role: NonNullable<Session['workspace']['role']>): WorkspaceContextValue {
  return {
    session: {
      accessToken: 'token',
      user: {
        id: 'user',
        email: 'person@example.com',
        displayName: 'Person',
        onboarding: {
          version: 1,
          completed: true,
          lastStep: 1,
          completedAt: null,
          skippedAt: null,
        },
      },
      workspace: { id: 'workspace', name: 'Acme', role },
    },
    data: { agents: [], tasks: [], workflows: [], documents: [], tools: [] },
    loading: false,
    refresh: vi.fn(),
    notice: '',
    error: '',
    report: vi.fn(),
    reportError: vi.fn(),
    clearMessage: vi.fn(),
    signOut: vi.fn(),
    openOnboarding: vi.fn(),
  };
}

function renderPage(role: NonNullable<Session['workspace']['role']> = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <WorkspaceContext.Provider value={workspace(role)}>
          <DepartmentPage/>
        </WorkspaceContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.mocked(api.departments).mockResolvedValue(organizationFixture);
  vi.mocked(api.createDepartment).mockResolvedValue({
    revision: 8,
    department: organizationFixture.departments[0],
  });
  vi.mocked(api.updateDepartment).mockResolvedValue({ revision: 8 });
  vi.mocked(api.archiveDepartment).mockResolvedValue({ revision: 8 });
  vi.mocked(api.setDepartmentMembership).mockResolvedValue({ revision: 8 });
  vi.mocked(api.removeDepartmentMembership).mockResolvedValue({ revision: 8 });
  vi.mocked(api.setExecutiveAgent).mockResolvedValue({ revision: 8 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('requires an explicit confirmation before calling a primary move mutation', async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Edit Marketing' }));
  const drawer = screen.getByRole('dialog', { name: 'Edit Marketing' });
  await user.click(within(drawer).getByRole('button', {
    name: 'Make Sam Specialist primary in Marketing',
  }));

  expect(api.setDepartmentMembership).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('dialog', { name: 'Move primary Department' });
  await user.click(within(confirmation).getByRole('button', { name: 'Move to Marketing' }));

  expect(api.setDepartmentMembership).toHaveBeenCalledWith(
    'marketing',
    'shared-specialist',
    { membershipType: 'primary', expectedRevision: 7 },
  );
});

it('refreshes after a stale revision and keeps the editor open with actionable feedback', async () => {
  const user = userEvent.setup();
  vi.mocked(api.createDepartment).mockRejectedValueOnce(new DepartmentApiError(
    'DEPARTMENT_REVISION_CONFLICT',
    409,
    8,
  ));
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Create Department' }));
  const drawer = screen.getByRole('dialog', { name: 'Create Department' });
  await user.type(within(drawer).getByRole('textbox', { name: 'Department name' }), 'Finance');
  await user.click(within(drawer).getByRole('button', { name: 'Create Department' }));

  expect((await within(drawer).findByRole('alert')).textContent).toContain('organization changed in another session');
  expect(api.departments).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('dialog', { name: 'Create Department' })).toBeTruthy();
});

it('renders members and viewers as read-only while preserving the list hierarchy', async () => {
  renderPage('viewer');

  expect(await screen.findByRole('navigation', { name: 'Department hierarchy' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create Department' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Edit Marketing/ })).toBeNull();
  expect(screen.getByText('Read-only organization')).toBeTruthy();
});
