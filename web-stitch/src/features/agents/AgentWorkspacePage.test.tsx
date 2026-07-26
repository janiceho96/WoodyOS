// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Agent, AgentMcpAccess, Session, Tool } from '../../api';
import { api } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { AgentWorkspacePage } from './AgentWorkspacePage';

vi.mock('../../api', () => ({
  api: {
    agentMcpAccess: vi.fn(),
  },
  isApiTool: (tool: { kind: string }) => tool.kind === 'api' || tool.kind === 'plugin' || tool.kind === 'internal',
}));

const agent = {
  id: 'agent-1',
  name: 'Researcher',
  role: 'Research analyst',
  goal: 'Find accurate answers.',
  instructions: 'Verify every source.',
  personality: null,
  status: 'paused',
  model: 'gpt-5',
  model_config: { temperature: 0.2, maxTokens: 4096, topP: 1 },
  capabilities: { webBrowser: true, codeInterpreter: false, knowledgeBase: true },
  tool_ids: ['api-tool'],
  memory_config: {},
  avatar_config: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as Agent;

const apiTool = {
  id: 'api-tool',
  name: 'Company API',
  kind: 'api',
  description: 'Read companies',
  permissions: ['company.read'],
  enabled: true,
  created_at: '2026-01-01T00:00:00.000Z',
} as Tool;

const savedMcpAccess: AgentMcpAccess = {
  agentId: 'agent-1',
  agentStatus: 'paused',
  connections: [{
    id: 'docs',
    name: 'Docs MCP',
    permissionLevel: 'read_write',
    assignmentEnabled: true,
    availability: {
      available: false,
      status: 'agent_inactive',
      connectionEnabled: false,
      healthStatus: 'unhealthy',
    },
    tools: [
      {
        id: 'search-docs',
        remoteName: 'search_docs',
        title: 'Search docs',
        riskLevel: 'read',
        permissionLevel: 'read',
        assignmentEnabled: true,
        availability: { available: false, status: 'agent_inactive', toolEnabled: true },
      },
      {
        id: 'create-page',
        remoteName: 'create_page',
        title: 'Create page',
        riskLevel: 'external_write',
        permissionLevel: 'read_write',
        assignmentEnabled: false,
        availability: { available: false, status: 'agent_inactive', toolEnabled: false },
      },
    ],
  }],
};

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.mocked(api.agentMcpAccess).mockResolvedValue(savedMcpAccess);
});

afterEach(cleanup);

describe('AgentWorkspacePage resource projection', () => {
  it('renders saved MCP assignments for a paused agent and labels availability separately', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const workspace: WorkspaceContextValue = {
      session: {} as Session,
      data: { agents: [agent], tasks: [], workflows: [], documents: [], tools: [apiTool] },
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
    render(<MemoryRouter initialEntries={['/agents/agent-1?section=configure']}><QueryClientProvider client={queryClient}><WorkspaceContext.Provider value={workspace}><Routes><Route path="/agents/:agentId" element={<AgentWorkspacePage/>}/></Routes></WorkspaceContext.Provider></QueryClientProvider></MemoryRouter>);

    const apiSection = screen.getByRole('heading', { name: 'API Tools' }).closest('.resource-group');
    expect(apiSection).toBeTruthy();
    expect(within(apiSection as HTMLElement).getByText('Company API')).toBeTruthy();

    const mcpSection = (await screen.findByRole('heading', { name: 'MCP access' })).closest('.resource-group');
    expect(mcpSection).toBeTruthy();
    expect(await within(mcpSection as HTMLElement).findByText('Assigned connections')).toBeTruthy();
    expect(within(mcpSection as HTMLElement).getByText('Docs MCP')).toBeTruthy();
    expect(within(mcpSection as HTMLElement).getByText('Assigned MCP actions')).toBeTruthy();
    expect(within(mcpSection as HTMLElement).getByText('Search docs')).toBeTruthy();
    expect(within(mcpSection as HTMLElement).getByText('Create page')).toBeTruthy();
    expect(within(mcpSection as HTMLElement).getAllByText('Unavailable · agent paused')).toHaveLength(3);
    expect(within(mcpSection as HTMLElement).queryByText('CRM MCP')).toBeNull();
    expect(within(mcpSection as HTMLElement).getByRole('button', { name: 'Manage MCP access' })).toBeTruthy();
    expect(api.agentMcpAccess).toHaveBeenCalledWith('agent-1');
  });
});
