// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Agent, Session, Tool } from '../../api';
import { api } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { WebResearchPanel } from './ToolsPage';

vi.mock('../../api', () => ({
  api: {
    webResearchCatalog: vi.fn(),
    installWebResearchTool: vi.fn(),
    updateAgent: vi.fn(),
  },
  isApiTool: (tool: { kind: string }) => tool.kind === 'api' || tool.kind === 'plugin' || tool.kind === 'internal',
}));

const enabledTool = {
  id: 'enabled-api',
  name: 'Existing API',
  kind: 'api',
  description: 'Enabled API',
  permissions: ['data.read'],
  enabled: true,
  created_at: '2026-01-01T00:00:00.000Z',
} as Tool;

const disabledTool = { ...enabledTool, id: 'disabled-api', name: 'Disabled API', enabled: false } as Tool;
const legacyMcpTool = { ...enabledTool, id: 'legacy-mcp', name: 'Legacy MCP', kind: 'mcp' } as Tool;
const installedTool = {
  ...enabledTool,
  id: 'new-web-tool',
  name: 'Tavily Web Search',
  permissions: ['web.read', 'web.search'],
} as Tool;
const agent = {
  id: 'agent-1',
  name: 'Researcher',
  role: 'Researcher',
  status: 'active',
  capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: true },
  tool_ids: ['enabled-api', 'disabled-api', 'legacy-mcp'],
} as Agent;

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const report = vi.fn();
  const workspace: WorkspaceContextValue = {
    session: {} as Session,
    data: { agents: [agent], tasks: [], workflows: [], documents: [], tools: [enabledTool, disabledTool, legacyMcpTool] },
    loading: false,
    refresh: vi.fn(),
    notice: '',
    error: '',
    report,
    reportError: vi.fn(),
    clearMessage: vi.fn(),
    signOut: vi.fn(),
    openOnboarding: vi.fn(),
  };
  render(<MemoryRouter><QueryClientProvider client={queryClient}><WorkspaceContext.Provider value={workspace}><WebResearchPanel/></WorkspaceContext.Provider></QueryClientProvider></MemoryRouter>);
  return { report };
}

beforeEach(() => {
  vi.mocked(api.webResearchCatalog).mockResolvedValue({
    data: [{
      id: 'tavily',
      title: 'Tavily',
      description: 'Search the web',
      category: 'Search',
      credential: 'API key',
      recommended: true,
      installed: false,
    }],
  });
  vi.mocked(api.installWebResearchTool).mockResolvedValue(installedTool);
  vi.mocked(api.updateAgent).mockResolvedValue(agent);
});

afterEach(cleanup);

describe('AgentToolAssignment API Tool boundary', () => {
  it('assigns the new tool without resending disabled or legacy IDs and reports cleanup', async () => {
    const user = userEvent.setup();
    const { report } = renderPanel();

    await user.click(await screen.findByRole('button', { name: /Configure/ }));
    await user.type(screen.getByLabelText('API key'), 'test-api-key');
    await user.click(screen.getByRole('button', { name: 'Install read-only tool' }));
    await user.click(await screen.findByRole('button', { name: /Assign/ }));

    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      toolIds: ['enabled-api', 'new-web-tool'],
    })));
    expect(report).toHaveBeenCalledWith('Tavily Web Search assigned to Researcher. Removed 2 unavailable tool assignments.');
  });
});
