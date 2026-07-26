// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../../api';
import type { Agent, AgentMcpAccess, Session, Tool } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { legacyMcpTools } from '../mcp/McpMarketplacePage';
import { AgentBuilderPage } from './AgentBuilderPage';

vi.mock('../../api', () => ({
  api: {
    updateAgent: vi.fn(),
    createAgent: vi.fn(),
    generateAgentPrompt: vi.fn(),
    agentMcpAccess: vi.fn(),
  },
  isApiTool: (tool: { kind: string }) => tool.kind === 'api' || tool.kind === 'plugin' || tool.kind === 'internal',
}));

const agent = {
  id: 'agent-1',
  name: 'Legacy-aware reviewer',
  role: 'Reviewer',
  goal: 'Review documents for accuracy.',
  personality: null,
  instructions: 'Review the source material and report precise findings.',
  model: 'gpt-5',
  status: 'draft',
  model_config: { temperature: 0.2, maxTokens: 4096, topP: 1 },
  capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: true },
  tool_ids: ['api-tool', 'disabled-api-tool', 'legacy-mcp'],
  avatar_config: {},
} as Agent;

const apiTool = {
  id: 'api-tool',
  name: 'Company API',
  kind: 'api',
  description: 'Read company data',
  permissions: ['company.read'],
  enabled: true,
  created_at: '2026-01-01T00:00:00.000Z',
} as Tool;

const legacyMcpTool = {
  id: 'legacy-mcp',
  name: 'Legacy MCP server',
  kind: 'mcp',
  description: 'Compatibility connection',
  permissions: [],
  enabled: true,
  created_at: '2026-01-01T00:00:00.000Z',
} as Tool;

const disabledApiTool = {
  ...apiTool,
  id: 'disabled-api-tool',
  name: 'Paused company API',
  enabled: false,
} as Tool;

const savedMcpAccess: AgentMcpAccess = {
  agentId: 'agent-1',
  agentStatus: 'draft',
  connections: [{
    id: 'docs-mcp',
    name: 'Docs MCP',
    permissionLevel: 'read',
    assignmentEnabled: true,
    availability: {
      available: false,
      status: 'agent_inactive',
      connectionEnabled: false,
      healthStatus: 'unhealthy',
    },
    tools: [{
      id: 'mcp-action',
      remoteName: 'search_docs',
      title: 'Search docs',
      riskLevel: 'read',
      permissionLevel: 'read',
      assignmentEnabled: false,
      availability: { available: false, status: 'agent_inactive', toolEnabled: false },
    }],
  }],
};

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workspace: WorkspaceContextValue = {
    session: {} as Session,
    data: { agents: [agent], tasks: [], workflows: [], documents: [], tools: [apiTool, disabledApiTool, legacyMcpTool], runtime: { defaultModel: 'gpt-5' } as WorkspaceContextValue['data']['runtime'] },
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
  return render(<MemoryRouter initialEntries={['/agents/agent-1/edit']}><QueryClientProvider client={queryClient}><WorkspaceContext.Provider value={workspace}><Routes><Route path="/agents/:agentId/edit" element={<AgentBuilderPage/>}/></Routes></WorkspaceContext.Provider></QueryClientProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(api.agentMcpAccess).mockResolvedValue(savedMcpAccess);
});

afterEach(cleanup);

describe('AgentBuilderPage API Tool boundary', () => {
  it('submits only enabled API Tool IDs and warns about stale assignments', async () => {
    vi.mocked(api.updateAgent).mockResolvedValue(agent);
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByText('2 unavailable tool assignments will be removed when you save.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(api.updateAgent).toHaveBeenCalled());
    expect(api.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ toolIds: ['api-tool'] }));
    expect(legacyMcpTools([apiTool, legacyMcpTool]).map((tool) => tool.id)).toEqual(['legacy-mcp']);
  });

  it('renders API-only assignments separately from the agent MCP access summary', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /Review/ }));

    const review = screen.getByRole('heading', { name: 'Review before publishing' }).closest('.guided-section');
    expect(review).toBeTruthy();
    expect(within(review as HTMLElement).getByText('API Tools')).toBeTruthy();
    expect(within(review as HTMLElement).getByText('Company API')).toBeTruthy();
    expect(within(review as HTMLElement).getByText('MCP access')).toBeTruthy();
    expect(await within(review as HTMLElement).findByText('Docs MCP · Search docs (Unavailable · agent draft)')).toBeTruthy();
    expect(within(review as HTMLElement).getByLabelText('MCP access review status: warning')).toBeTruthy();
    expect(within(review as HTMLElement).queryByText('Integrations')).toBeNull();
  });

  it('renders MCP loading as neutral instead of success', async () => {
    vi.mocked(api.agentMcpAccess).mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /Review/ }));

    const review = screen.getByRole('heading', { name: 'Review before publishing' }).closest('.guided-section');
    expect(review).toBeTruthy();
    expect(await within(review as HTMLElement).findByText('Loading MCP access…')).toBeTruthy();
    expect(within(review as HTMLElement).getByLabelText('MCP access review status: neutral')).toBeTruthy();
    expect(within(review as HTMLElement).queryByLabelText('MCP access review status: success')).toBeNull();
  });

  it('renders an MCP loading error as warning instead of success', async () => {
    vi.mocked(api.agentMcpAccess).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /Review/ }));

    const review = screen.getByRole('heading', { name: 'Review before publishing' }).closest('.guided-section');
    expect(review).toBeTruthy();
    expect(await within(review as HTMLElement).findByText('MCP access could not be loaded')).toBeTruthy();
    expect(within(review as HTMLElement).getByLabelText('MCP access review status: warning')).toBeTruthy();
    expect(within(review as HTMLElement).queryByLabelText('MCP access review status: success')).toBeNull();
  });
});
