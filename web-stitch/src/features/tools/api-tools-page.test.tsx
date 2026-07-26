import { describe, expect, it } from 'vitest';
import { primaryNavigation, resolveLegacyResourcePath } from '../../app/navigation';

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
});
