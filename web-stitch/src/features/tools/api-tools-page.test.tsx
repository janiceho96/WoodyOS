import { describe, expect, it, vi } from 'vitest';
import type { McpConnection, Tool } from '../../api';
import { resourceSearchKind } from '../../app/AppShell';
import { primaryNavigation, resolveLegacyResourcePath } from '../../app/navigation';
import providers from './ToolsPage.tsx?raw';

vi.mock('../../api', () => ({ api: {} }));

import { API_TOOL_SECTIONS } from './ApiToolsPage';
import { legacyMcpTools, mcpRouteState, MCP_SECTIONS, selectMcpConnection } from '../mcp/McpMarketplacePage';

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

  it('does not nest provider panels under removed integration tabs', () => {
    expect(providers).not.toContain('role="tabpanel"');
    expect(providers).not.toMatch(/integrations-(panel|tab)-(web|jobs)/);
  });
});
