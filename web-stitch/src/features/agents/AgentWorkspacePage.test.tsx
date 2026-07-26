// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Agent, Session, Tool, WorkflowResources } from '../../api';
import { api } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { AgentWorkspacePage } from './AgentWorkspacePage';

vi.mock('../../api', () => ({
  api: {
    workflowResources: vi.fn(),
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
  status: 'active',
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

const resources = {
  version: 1,
  agents: [],
  apiTools: [],
  mcpTools: [
    {
      id: 'search-docs',
      connectionId: 'docs',
      connectionName: 'Docs MCP',
      remoteName: 'search_docs',
      title: 'Search docs',
      description: 'Search docs',
      inputSchema: {},
      riskLevel: 'read',
      agentId: 'agent-1',
      connectionPermission: 'read',
      toolPermission: 'read',
    },
    {
      id: 'create-page',
      connectionId: 'docs',
      connectionName: 'Docs MCP',
      remoteName: 'create_page',
      title: 'Create page',
      description: 'Create a page',
      inputSchema: {},
      riskLevel: 'external_write',
      agentId: 'agent-1',
      connectionPermission: 'read_write',
      toolPermission: 'read_write',
    },
    {
      id: 'other-agent-action',
      connectionId: 'crm',
      connectionName: 'CRM MCP',
      remoteName: 'search_crm',
      title: 'Search CRM',
      description: 'Search CRM',
      inputSchema: {},
      riskLevel: 'read',
      agentId: 'agent-2',
      connectionPermission: 'read',
      toolPermission: 'read',
    },
  ],
  knowledge: { scope: 'workspace', total: 0, ready: 0, processing: 0, failed: 0 },
} as WorkflowResources;

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  vi.mocked(api.workflowResources).mockResolvedValue(resources);
});

afterEach(cleanup);

describe('AgentWorkspacePage resource projection', () => {
  it('renders assigned MCP connections and actions separately from API Tools', async () => {
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
    expect(within(mcpSection as HTMLElement).queryByText('CRM MCP')).toBeNull();
    expect(within(mcpSection as HTMLElement).getByRole('button', { name: 'Manage MCP access' })).toBeTruthy();
  });
});
