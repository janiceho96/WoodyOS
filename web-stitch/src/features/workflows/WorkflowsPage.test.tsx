// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workflow, WorkflowNode, WorkflowNodeCatalogEntry, WorkflowResources } from '../../api';
import { api } from '../../api';
import { WorkspaceContext, type WorkspaceContextValue } from '../../app/workspace';
import { WorkflowsPage } from './WorkflowsPage';

vi.mock('./WorkflowCanvas', () => ({
  WorkflowCanvas: () => <div aria-label="Workflow canvas"/>,
}));

vi.mock('../../api', () => ({
  api: {
    workflowNodeCatalog: vi.fn(),
    workflowResources: vi.fn(),
    workflowLayout: vi.fn(),
    workflowRun: vi.fn(),
  },
}));

const nodes: WorkflowNode[] = [
  { id: 'trigger', type: 'trigger', config: { event: 'manual' } },
  { id: 'api', type: 'api_action', config: { toolId: 'company-api' } },
  { id: 'mcp', type: 'mcp_action', config: { agentId: 'agent-1', mcpToolId: 'search-docs' } },
  { id: 'output', type: 'output', config: {} },
];

const workflow = {
  id: 'workflow-1',
  name: 'Mixed resource workflow',
  description: 'Uses API and MCP resources',
  definition: {
    nodes,
    edges: [
      { source: 'trigger', target: 'api' },
      { source: 'api', target: 'mcp' },
      { source: 'mcp', target: 'output' },
    ],
  },
  enabled: false,
  status: 'draft',
  draft_revision: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as Workflow;

const resources = {
  version: 1,
  agents: [],
  apiTools: [{
    id: 'company-api',
    name: 'Company API',
    kind: 'api',
    description: 'Read companies',
    permissions: ['company.read'],
  }],
  mcpTools: [{
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
  }],
  knowledge: { scope: 'workspace', total: 0, ready: 0, processing: 0, failed: 0 },
} as WorkflowResources;

function catalogEntry(type: WorkflowNode['type']): WorkflowNodeCatalogEntry {
  return {
    type,
    category: type === 'trigger' ? 'trigger' : type === 'output' ? 'output' : 'integration',
    title: type.replaceAll('_', ' '),
    description: type,
    icon: type,
    adapter: type === 'mcp_action' ? 'mcp' : type === 'api_action' ? 'api' : 'logic',
    risk: 'read',
    available: true,
    retryable: false,
    inspectorSections: [],
    supportsInputMapping: false,
    supportsStructuredOutput: false,
    supportsDynamicHandles: false,
    inputPorts: type === 'trigger' ? [] : [{ id: 'input', label: 'Input', dataType: 'any' }],
    outputPorts: type === 'output' ? [] : [{ id: 'output', label: 'Output', dataType: 'any' }],
    configFields: [],
  };
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  vi.mocked(api.workflowNodeCatalog).mockResolvedValue({ version: 1, data: ['trigger', 'api_action', 'mcp_action', 'output'].map((type) => catalogEntry(type as WorkflowNode['type'])) });
  vi.mocked(api.workflowResources).mockResolvedValue(resources);
  vi.mocked(api.workflowLayout).mockResolvedValue({
    workflowId: 'workflow-1',
    schemaVersion: 1,
    positions: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  });
});

afterEach(cleanup);

describe('WorkflowsPage pre-publish review', () => {
  it('renders API Tools and MCP Actions as distinct resource rows', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const workspace: WorkspaceContextValue = {
      session: {} as Session,
      data: { agents: [], tasks: [], workflows: [workflow], documents: [], tools: [] },
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
    const user = userEvent.setup();
    render(<QueryClientProvider client={queryClient}><WorkspaceContext.Provider value={workspace}><WorkflowsPage/></WorkspaceContext.Provider></QueryClientProvider>);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const review = screen.getByRole('heading', { name: 'Pre-publish review' }).parentElement;
    expect(review).toBeTruthy();
    expect(within(review as HTMLElement).getByText('API Tools')).toBeTruthy();
    expect(within(review as HTMLElement).getByText('Company API')).toBeTruthy();
    expect(within(review as HTMLElement).getByText('MCP Actions')).toBeTruthy();
    expect(within(review as HTMLElement).getByText('Docs MCP · Search docs')).toBeTruthy();
    expect(within(review as HTMLElement).queryByText('Integrations')).toBeNull();
  });
});
