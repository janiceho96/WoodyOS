import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptJson } from '../src/lib/crypto.js';
import {
  apiToolManifestEntry,
  mcpActionManifestEntry,
} from '../src/runtime/manifest.js';

const previousEncryptionKey = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
});

describe('canonical action manifest identities', () => {
  it('changes API identity for schema, method, permissions, or derived risk drift', () => {
    const source = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'lookup',
      kind: 'api' as const,
      config: encryptJson({
        endpoint: 'https://api.example.test/lookup',
        method: 'GET',
        readOnly: true,
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }),
      permissions: ['records:read'],
    };
    const pinned = apiToolManifestEntry(source);

    expect(apiToolManifestEntry({
      ...source,
      config: encryptJson({
        endpoint: 'https://api.example.test/lookup',
        method: 'POST',
        readOnly: true,
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }),
    })).not.toEqual(pinned);
    expect(apiToolManifestEntry({
      ...source,
      config: encryptJson({
        endpoint: 'https://api.example.test/lookup',
        method: 'GET',
        readOnly: true,
        inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      }),
    })).not.toEqual(pinned);
    expect(apiToolManifestEntry({ ...source, permissions: ['records:write'] })).not.toEqual(pinned);
    expect(pinned).toMatchObject({ toolId: source.id, riskLevel: 'read' });
  });

  it('binds MCP identity to connection, remote schema, permissions, risk, and agent allowlist', () => {
    const source = [{
      id: '00000000-0000-4000-8000-000000000001',
      agent_id: '00000000-0000-4000-8000-000000000002',
      connection_id: '00000000-0000-4000-8000-000000000003',
      remote_name: 'lookup',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      transport: 'streamable-http',
      endpoint_url: 'https://mcp.example.test',
      risk_level: 'read',
      connection_permission: 'read',
      tool_permission: 'read',
    }];
    const pinned = mcpActionManifestEntry(source);

    for (const changed of [
      [{ ...source[0], connection_id: '00000000-0000-4000-8000-000000000004' }],
      [{ ...source[0], remote_name: 'changed' }],
      [{ ...source[0], input_schema: { type: 'object', properties: { changed: { type: 'boolean' } } } }],
      [{ ...source[0], transport: 'sse' }],
      [{ ...source[0], endpoint_url: 'https://changed.example.test' }],
      [{ ...source[0], risk_level: 'write' }],
      [{ ...source[0], connection_permission: 'read_write' }],
      [{ ...source[0], tool_permission: 'read_write' }],
      [{ ...source[0], agent_id: '00000000-0000-4000-8000-000000000005' }],
    ]) {
      expect(mcpActionManifestEntry(changed)).not.toEqual(pinned);
    }
    expect(pinned).toMatchObject({
      connectionId: source[0].connection_id,
      toolId: source[0].id,
      riskLevel: 'read',
    });
  });
});
