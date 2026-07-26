// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConnection, Session } from '../../api';
import { api } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { McpMarketplacePage } from './McpMarketplacePage';

vi.mock('../../api', () => ({
  api: {
    featuredMcpApps: vi.fn(),
    mcpConnections: vi.fn(),
    mcpToolCalls: vi.fn(),
    mcpTools: vi.fn(),
    mcpConnectionAgents: vi.fn(),
  },
}));

const connection = {
  id: 'docs-mcp',
  name: 'Docs MCP',
  tool_count: 1,
  agent_count: 1,
  auth_type: 'none',
  enabled: true,
  health_status: 'healthy',
  consecutive_failures: 0,
} as McpConnection;

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workspace: WorkspaceContextValue = {
    session: {} as Session,
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
  return render(<QueryClientProvider client={queryClient}><WorkspaceContext.Provider value={workspace}><McpMarketplacePage/></WorkspaceContext.Provider></QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.featuredMcpApps).mockResolvedValue({ data: [] });
  vi.mocked(api.mcpConnections).mockResolvedValue({ data: [connection] });
  vi.mocked(api.mcpToolCalls).mockResolvedValue({ data: [] });
  vi.mocked(api.mcpTools).mockResolvedValue({ data: [] });
  vi.mocked(api.mcpConnectionAgents).mockResolvedValue({ data: [] });
});

afterEach(cleanup);

describe('MCP workspace tabs', () => {
  it('keeps every tab connected to an existing labelled panel', async () => {
    const user = userEvent.setup();
    renderPage();

    const tabs = within(screen.getByRole('tablist', { name: 'MCP connection sections' })).getAllByRole('tab');
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);

      await user.click(tab);
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(document.getElementById(tab.getAttribute('aria-controls') ?? '')?.hasAttribute('hidden')).toBe(false);
    }
  });

  it('requires a connection selection before rendering Agent Access controls', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('tab', { name: 'Agent Access' }));

    expect(screen.getByText('Choose a connected application server before configuring its agent allowlists.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Agent' })).toBeNull();

    await user.click(await screen.findByRole('button', { name: /Docs MCP/ }));

    expect(await screen.findByRole('combobox', { name: 'Agent' })).toBeTruthy();
  });
});
