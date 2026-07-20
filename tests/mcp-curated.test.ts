import { describe, expect, it } from 'vitest';
import { CURATED_MCP_APPS, curatedMcpApp } from '../src/mcp/registry/curated.js';

describe('curated MCP app catalog', () => {
  it('uses unique IDs and HTTPS endpoints for every installable app', () => {
    expect(new Set(CURATED_MCP_APPS.map((app) => app.id)).size).toBe(CURATED_MCP_APPS.length);
    for (const app of CURATED_MCP_APPS.filter((entry) => entry.installable)) {
      expect(app.endpointUrl).toMatch(/^https:\/\//);
      expect(app.authModes).toContain(app.defaultAuth);
    }
  });

  it('keeps unsupported local-only apps visible without pretending they can install', () => {
    expect(curatedMcpApp('obsidian')).toMatchObject({
      availability: 'desktop_bridge',
      installable: false,
      endpointUrl: null,
    });
  });

  it('pins recognizable providers to their documented first-party domains', () => {
    expect(curatedMcpApp('notion')?.endpointUrl).toBe('https://mcp.notion.com/mcp');
    expect(curatedMcpApp('github')?.endpointUrl).toBe('https://api.githubcopilot.com/mcp/');
    expect(curatedMcpApp('google-drive')?.endpointUrl).toBe('https://drivemcp.googleapis.com/mcp/v1');
  });
});
