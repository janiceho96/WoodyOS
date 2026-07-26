// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { McpConnection, Session, Tool } from '../../api';
import { api } from '../../api';
import { resourceSearchKind } from '../../app/AppShell';
import { primaryNavigation, resolveLegacyResourcePath } from '../../app/navigation';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';

vi.mock('../../api', () => ({
  api: {
    webResearchCatalog: vi.fn(),
    jobToolCatalog: vi.fn(),
    demoApis: vi.fn(),
  },
  isApiTool: (tool: { kind: string }) => tool.kind === 'api' || tool.kind === 'plugin' || tool.kind === 'internal',
}));

import { ApiToolsPage, API_TOOL_SECTIONS } from './ApiToolsPage';
import { legacyMcpTools, mcpRouteState, MCP_SECTIONS, selectMcpConnection } from '../mcp/McpMarketplacePage';

function renderApiTools(entry = '/api-tools') {
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
  return render(<MemoryRouter initialEntries={[entry]}><QueryClientProvider client={queryClient}><WorkspaceContext.Provider value={workspace}><ApiToolsPage openConnect={vi.fn()}/></WorkspaceContext.Provider></QueryClientProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(api.webResearchCatalog).mockResolvedValue({ data: [] });
  vi.mocked(api.jobToolCatalog).mockResolvedValue({ data: [] });
  vi.mocked(api.demoApis).mockResolvedValue({ data: [] });
});

afterEach(cleanup);

describe('resource navigation', () => {
  it('classifies resources by user-facing domain', () => {
    expect(resourceSearchKind({ domain: 'api' })).toBe('API Tool');
    expect(resourceSearchKind({ domain: 'mcp-connection' })).toBe('MCP Connection');
    expect(resourceSearchKind({ domain: 'mcp-action' })).toBe('MCP Action');
  });

  it('exposes MCP and API Tools as separate primary destinations', () => {
    expect(primaryNavigation.map((item) => [item.label, item.path])).toEqual(
      expect.arrayContaining([
        ['MCP', '/mcp'],
        ['API Tools', '/api-tools'],
      ]),
    );
  });

  it('redirects the legacy tools path', () => {
    expect(resolveLegacyResourcePath('/tools')).toBe('/api-tools');
  });

  it('preserves legacy tool-section queries', () => {
    expect(resolveLegacyResourcePath('/tools?section=web')).toBe('/api-tools?section=web');
  });

  it('defines API-only sections', () => {
    expect(API_TOOL_SECTIONS.map((section) => section.id)).toEqual([
      'installed',
      'add',
      'providers',
      'activity',
    ]);
    expect(API_TOOL_SECTIONS.map((section) => section.label)).not.toContain('MCP');
  });

  it('defines first-class MCP sections', () => {
    expect(MCP_SECTIONS.map((section) => section.id)).toEqual([
      'discover',
      'connected',
      'access',
      'activity',
    ]);
  });

  it('selects the requested connection for Agent Access', () => {
    const connection = { id: 'connection-2', name: 'Docs' } as McpConnection;

    expect(selectMcpConnection([
      { id: 'connection-1', name: 'CRM' } as McpConnection,
      connection,
    ], 'connection-2')).toBe(connection);
    expect(selectMcpConnection([connection], 'missing')).toBeNull();
  });

  it('opens MCP Agent Access routes on the requested connection', () => {
    expect(mcpRouteState(new URLSearchParams('tab=access&connection=connection-2'))).toEqual({
      tab: 'access',
      connectionId: 'connection-2',
    });
  });

  it('keeps legacy connection deep links on the Connected tab', () => {
    expect(mcpRouteState(new URLSearchParams('connection=connection-2'))).toEqual({
      tab: 'connected',
      connectionId: 'connection-2',
    });
  });

  it('keeps legacy MCP workspace tools out of API Tools and available for compatibility controls', () => {
    expect(legacyMcpTools([
      { id: 'legacy-mcp', kind: 'mcp', name: 'Legacy server' },
      { id: 'api-tool', kind: 'api', name: 'Company API' },
    ] as Tool[]).map((tool) => tool.id)).toEqual(['legacy-mcp']);
  });

  it('keeps every API Tool tab connected to an existing labelled panel', async () => {
    const user = userEvent.setup();
    renderApiTools();

    const tabs = within(screen.getByRole('tablist', { name: 'API Tool sections' })).getAllByRole('tab');
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);

      await user.click(tab);
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(document.getElementById(tab.getAttribute('aria-controls') ?? '')?.hasAttribute('hidden')).toBe(false);
    }
  });

  it('maps the legacy apps section to Add API', () => {
    renderApiTools('/api-tools?section=apps');

    expect(screen.getByRole('tab', { name: 'Add API' }).getAttribute('aria-selected')).toBe('true');
  });

  it('renders provider content inside the single Providers panel without nested tab semantics', async () => {
    renderApiTools('/api-tools?section=providers');

    const providerPanel = screen.getByRole('tabpanel', { name: 'Providers' });
    expect(await within(providerPanel).findByRole('heading', { name: 'Give selected agents safe internet eyes' })).toBeTruthy();
    expect(within(providerPanel).getByRole('heading', { name: 'Search roles without giving an agent application authority' })).toBeTruthy();
    expect(within(providerPanel).queryAllByRole('tabpanel')).toEqual([]);
  });
});
