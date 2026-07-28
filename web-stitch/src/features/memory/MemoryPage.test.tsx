// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ManagedMemory, Session } from '../../api';
import { api } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { MemoryPage } from './MemoryPage';

vi.mock('../../api', () => ({
  api: {
    managedMemories: vi.fn(),
    agents: vi.fn(),
    updateMemory: vi.fn(),
    confirmMemory: vi.fn(),
    disputeMemory: vi.fn(),
    expireMemory: vi.fn(),
    supersedeMemory: vi.fn(),
    deleteMemory: vi.fn(),
  },
}));

const memory: ManagedMemory = {
  id: 'memory-1', agent_id: null, user_id: null, kind: 'knowledge', content: 'A disputed preference', importance: 0.5,
  metadata: {}, memory_type: 'preference', scope: 'workspace', source_type: 'agent', source_id: 'agent-1',
  confidence: 0.5, verification_status: 'disputed', expires_at: null, superseded_by: null,
  last_accessed_at: null, access_count: 2, created_at: '2026-07-26T00:00:00.000Z', updated_at: '2026-07-26T00:00:00.000Z',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const workspace: WorkspaceContextValue = {
    session: { workspace: { role: 'member' } } as Session,
    data: { agents: [], tasks: [], workflows: [], documents: [], tools: [] }, loading: false,
    refresh: vi.fn(), notice: '', error: '', report: vi.fn(), reportError: vi.fn(), clearMessage: vi.fn(), signOut: vi.fn(), openOnboarding: vi.fn(),
  };
  return render(<MemoryRouter><QueryClientProvider client={client}><WorkspaceContext.Provider value={workspace}><MemoryPage/></WorkspaceContext.Provider></QueryClientProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(api.managedMemories).mockResolvedValue({ data: [memory], pagination: { limit: 50, offset: 0, nextOffset: null } });
  vi.mocked(api.agents).mockResolvedValue({ data: [] });
});
afterEach(cleanup);

it('labels filters and clearly marks a disputed memory as unavailable for retrieval', async () => {
  renderPage();

  expect(screen.getByRole('heading', { name: 'Memory management' })).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Lifecycle status' })).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Expiry' })).toBeTruthy();
  expect(await screen.findByText('A disputed preference')).toBeTruthy();
  expect(screen.getByText('Not eligible for retrieval')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete memory' })).toBeTruthy();
});
