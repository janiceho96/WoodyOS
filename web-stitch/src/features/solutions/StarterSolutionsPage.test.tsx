// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type AgentSolution, type AgentSolutionInstallation, type Session } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { StarterSolutionsPage } from './StarterSolutionsPage';

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>();
  return { ...actual, api: { ...actual.api, starterSolutions: vi.fn(), agentSolutionInstallations: vi.fn() } };
});

const solution: AgentSolution = {
  slug: 'research-draft', version: 1, source: 'starter', name: 'Research Draft', description: 'A focused research draft for review.', category: 'Research', difficulty: 'beginner', estimatedModelCalls: 1,
  estimatedTokenRange: { minimum: 128, maximum: 256 }, requiredInputs: [{ key: 'topic', label: 'Topic', description: 'Research topic', required: true }],
  agents: [{ key: 'agent_1', name: 'Researcher', role: 'Researcher', goal: 'Research the topic', instructions: 'Return evidence for review.', personality: 'Careful', modelConfig: { temperature: 0.2, maxTokens: 4096, topP: 1 }, capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: true }, toolRequirements: [] }],
  team: { name: 'Research Team', description: '' }, workflow: { name: 'Research', description: 'Research workflow', nodes: [{ id: 'trigger', type: 'trigger', config: {} }, { id: 'stage', type: 'agent', agentKey: 'agent_1', config: {} }, { id: 'output', type: 'output', config: {} }], edges: [{ source: 'trigger', target: 'stage' }, { source: 'stage', target: 'output' }] },
  expectedMarkdownOutput: '## Evidence', recommendedIntegrations: [], requiredPermissions: [], humanApprovalRequirements: [], missingQuestions: [], warnings: [],
};

function workspace(role: NonNullable<Session['workspace']['role']>): WorkspaceContextValue {
  return { session: { accessToken: 'token', user: { id: 'user', email: 'person@example.com', displayName: 'Person', onboarding: { version: 1, completed: true, lastStep: 1, completedAt: null, skippedAt: null } }, workspace: { id: 'workspace', name: 'Acme', role } }, data: { agents: [], tasks: [], workflows: [], documents: [], tools: [] }, loading: false, refresh: vi.fn(), notice: '', error: '', report: vi.fn(), reportError: vi.fn(), clearMessage: vi.fn(), signOut: vi.fn(), openOnboarding: vi.fn() };
}

function renderPage(role: NonNullable<Session['workspace']['role']>, path = '/solutions') {
  return render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WorkspaceContext.Provider value={workspace(role)}><StarterSolutionsPage/></WorkspaceContext.Provider></QueryClientProvider></MemoryRouter>);
}

const installedDraft: AgentSolutionInstallation = {
  id: 'installed-draft', source_type: 'starter', solution_slug: solution.slug, solution_version: 1,
  solution_name: solution.name, status: 'draft', solution, resources: { agentIds: {} }, last_test_status: 'completed',
};

beforeEach(() => {
  vi.mocked(api.starterSolutions).mockResolvedValue({ data: [solution] });
  vi.mocked(api.agentSolutionInstallations).mockResolvedValue({ data: [] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each(['owner', 'admin'] as const)('offers installation to %s roles', async (role) => {
  renderPage(role);
  expect((await screen.findByRole('button', { name: 'Install draft' }) as HTMLButtonElement).disabled).toBe(false);
});

it.each(['member', 'viewer'] as const)('keeps %s roles in a clear read-only solution state', async (role) => {
  renderPage(role);
  expect(await screen.findByText('Only workspace owners and administrators can install or save solution drafts.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Install draft' })).toBeNull();
});

it('lets members test and activate existing drafts without offering installation', async () => {
  vi.mocked(api.agentSolutionInstallations).mockResolvedValue({ data: [installedDraft] });
  renderPage('member', '/solutions?tab=installed');

  expect(await screen.findByRole('button', { name: /Run test/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Activate solution' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Install draft' })).toBeNull();
});

it('keeps viewers from mutating existing drafts', async () => {
  vi.mocked(api.agentSolutionInstallations).mockResolvedValue({ data: [installedDraft] });
  renderPage('viewer', '/solutions?tab=installed');

  await screen.findByText('Administrator access required to change this draft.');
  expect(screen.queryByRole('button', { name: /Run test/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Activate solution' })).toBeNull();
});
