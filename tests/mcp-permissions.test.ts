import { describe, expect, it } from 'vitest';
import {
  assertMcpPermission,
  mcpRequiresConfirmation,
  mcpToolRuntimeName,
  safeArgumentsSummary,
  type AuthorizedMcpTool,
} from '../src/mcp/runtime.js';

function tool(overrides: Partial<AuthorizedMcpTool> = {}): AuthorizedMcpTool {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    remote_name: 'search',
    title: 'Search',
    description: '',
    input_schema: { type: 'object' },
    risk_level: 'read',
    connection_id: '22222222-2222-4222-8222-222222222222',
    connection_name: 'Example',
    workspace_id: '33333333-3333-4333-8333-333333333333',
    transport: 'streamable-http',
    endpoint_url: 'https://example.test/mcp',
    auth_type: 'none',
    encrypted_credentials: null,
    connection_permission: 'read',
    tool_permission: 'read',
    ...overrides,
  };
}

describe('MCP agent permissions', () => {
  it('allows read tools at read permission and blocks writes', () => {
    expect(() => assertMcpPermission(tool())).not.toThrow();
    expect(() => assertMcpPermission(tool({ risk_level: 'write' }))).toThrowError(/read-only access/);
  });

  it('requires confirmation for destructive, external-write and unknown tools', () => {
    expect(mcpRequiresConfirmation(tool({ risk_level: 'read' }))).toBe(false);
    expect(mcpRequiresConfirmation(tool({ risk_level: 'write' }))).toBe(false);
    expect(mcpRequiresConfirmation(tool({ risk_level: 'external_write', connection_permission: 'read_write', tool_permission: 'read_write' }))).toBe(true);
    expect(mcpRequiresConfirmation(tool({ risk_level: 'destructive', connection_permission: 'read_write', tool_permission: 'read_write' }))).toBe(true);
    expect(mcpRequiresConfirmation(tool({ risk_level: 'unknown', connection_permission: 'read_write', tool_permission: 'read_write' }))).toBe(true);
  });

  it('redacts likely secrets from audit summaries', () => {
    expect(safeArgumentsSummary({
      query: 'quarterly report',
      password: 'never-log-this',
      nested: { apiKey: 'also-secret', visible: 'safe' },
    })).toEqual({
      query: 'quarterly report',
      password: '[redacted]',
      nested: { apiKey: '[redacted]', visible: 'safe' },
    });
  });

  it('uses stable UUID-derived runtime names instead of untrusted server names', () => {
    expect(mcpToolRuntimeName(tool().id)).toBe('mcp_11111111_1111_4111_8111_111111111111');
  });
});
