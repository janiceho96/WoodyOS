// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, within } from '@testing-library/react';
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

it('labels the read-only organization with the actual workspace role', async () => {
  renderPage('member');

  expect(await screen.findByText('member')).toBeTruthy();
});

it('keeps the unassigned drawer open and exposes mutation errors', async () => {
  const user = userEvent.setup();
  vi.mocked(api.setDepartmentMembership).mockRejectedValueOnce(new Error('Assignment failed'));
  renderPage();

  await user.click(await screen.findByRole('button', { name: /Unassigned/ }));
  const drawer = screen.getByRole('dialog', { name: 'Unassigned agents' });
  await user.selectOptions(within(drawer).getByRole('combobox', { name: 'Primary Department for Una Assigned' }), 'marketing');
  await user.click(within(drawer).getByRole('button', { name: 'Assign primary' }));

  expect((await within(drawer).findByRole('alert')).textContent).toContain('Assignment failed');
  expect(screen.getByRole('dialog', { name: 'Unassigned agents' })).toBeTruthy();
});

it('keeps the archive confirmation and suspended editor open when archival fails', async () => {
  const user = userEvent.setup();
  vi.mocked(api.archiveDepartment).mockRejectedValueOnce(new Error('Archive failed'));
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Edit Marketing' }));
  const drawer = screen.getByRole('dialog', { name: 'Edit Marketing' });
  await user.click(within(drawer).getByRole('button', { name: 'Archive' }));
  const confirmation = screen.getByRole('dialog', { name: 'Archive Marketing' });
  expect(drawer.getAttribute('aria-modal')).toBe('false');
  await user.click(within(confirmation).getByRole('button', { name: 'Archive Department' }));

  expect((await within(confirmation).findByRole('alert')).textContent).toContain('Archive failed');
  expect(screen.getByRole('dialog', { name: 'Archive Marketing' })).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Edit Marketing' })).toBeTruthy();
});

it('closes only the topmost confirmation on Escape and preserves the editor draft', async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Edit Marketing' }));
  const drawer = screen.getByRole('dialog', { name: 'Edit Marketing' });
  const name = within(drawer).getByRole('textbox', { name: 'Department name' });
  await user.clear(name);
  await user.type(name, 'Marketing Draft');
  await user.click(within(drawer).getByRole('button', { name: 'Archive' }));
  expect(screen.getByRole('dialog', { name: 'Archive Marketing' })).toBeTruthy();

  await user.keyboard('{Escape}');

  expect(screen.queryByRole('dialog', { name: 'Archive Marketing' })).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Edit Marketing' })).toBeTruthy();
  expect((within(drawer).getByRole('textbox', { name: 'Department name' }) as HTMLInputElement).value).toBe('Marketing Draft');
});

it('adapts at the shared 760px breakpoint until a presentation mode is chosen', async () => {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  let listener: ((event: MediaQueryListEvent) => void) | undefined;
  const media = {
    matches: false,
    addEventListener: vi.fn((_type: string, next: (event: MediaQueryListEvent) => void) => { listener = next; }),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => media) });
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('button', { name: 'Accessible list' });

  expect(document.querySelector('.department-organization-panel')?.className).toContain('graph');
  await act(async () => {
    media.matches = true;
    listener?.({ matches: true } as MediaQueryListEvent);
  });
  expect(document.querySelector('.department-organization-panel')?.className).toContain('list');

  await user.click(screen.getByRole('button', { name: 'Graph' }));
  await act(async () => {
    media.matches = false;
    listener?.({ matches: false } as MediaQueryListEvent);
  });
  expect(document.querySelector('.department-organization-panel')?.className).toContain('graph');
});
