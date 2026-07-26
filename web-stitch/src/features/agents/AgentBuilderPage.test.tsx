// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../../api';
import type { Agent, Session, Tool, WorkflowResources } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { legacyMcpTools } from '../mcp/McpMarketplacePage';
import { AgentBuilderPage } from './AgentBuilderPage';

vi.mock('../../api', () => ({
  api: {
    updateAgent: vi.fn(),
    createAgent: vi.fn(),
    generateAgentPrompt: vi.fn(),
    workflowResources: vi.fn(),
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

const mcpResources = {
  version: 1,
  agents: [],
  apiTools: [],
  mcpTools: [
    {
      id: 'mcp-action',
      connectionId: 'docs-mcp',
      connectionName: 'Docs MCP',
      remoteName: 'search_docs',
      title: 'Search docs',
      description: 'Search the documentation',
      inputSchema: {},
      riskLevel: 'read',
      agentId: 'agent-1',
      connectionPermission: 'read',
      toolPermission: 'read',
    },
  ],
  knowledge: { scope: 'workspace', total: 0, ready: 0, processing: 0, failed: 0 },
} as WorkflowResources;

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
  vi.mocked(api.workflowResources).mockResolvedValue(mcpResources);
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
    expect(await within(review as HTMLElement).findByText('Docs MCP · Search docs')).toBeTruthy();
    expect(within(review as HTMLElement).queryByText('Integrations')).toBeNull();
  });
});
