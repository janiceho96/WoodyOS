import { describe, expect, it, vi } from 'vitest';
import { primaryNavigation, resolveLegacyResourcePath } from '../../app/navigation';

vi.mock('../../api', () => ({ api: {} }));

import { API_TOOL_SECTIONS } from './ApiToolsPage';

describe('resource navigation', () => {
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
});
