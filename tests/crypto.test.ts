import { beforeEach, describe, expect, it } from 'vitest';
import { decryptJson, encryptJson } from '../src/lib/crypto.js';
import { definitionFor, toolRequiresApproval } from '../src/tools/runtime.js';

beforeEach(() => { process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); });

describe('encrypted tool configuration', () => {
  it('round-trips configuration without exposing the plaintext', () => {
    const config = { endpoint: 'https://api.example.com/run', token: 'secret-value' };
    const encrypted = encryptJson(config);
    expect(JSON.stringify(encrypted)).not.toContain('secret-value');
    expect(decryptJson(encrypted)).toEqual(config);
  });

  it('creates a valid Claude tool definition from encrypted configuration', () => {
    const config = encryptJson({ agentDescription: 'Look up customer data', inputSchema: { type: 'object', properties: { customerId: { type: 'string' } }, required: ['customerId'] } });
    expect(definitionFor({ id: '11111111-1111-1111-1111-111111111111', name: 'CRM', kind: 'api', config, permissions: ['crm.read'] })).toMatchObject({ name: 'tool_11111111_1111_1111_1111_111111111111', input_schema: { type: 'object' } });
  });

  it('requires human approval for write-like tools and conservatively handles unreadable configuration', () => {
    const base = { id: '11111111-1111-1111-1111-111111111111', name: 'CRM', kind: 'api' as const };
    expect(toolRequiresApproval({ ...base, config: encryptJson({ endpoint: 'https://api.example.com/customers', method: 'GET', readOnly: true }), permissions: ['crm.read'] })).toBe(false);
    expect(toolRequiresApproval({ ...base, config: encryptJson({ endpoint: 'https://api.example.com/customers', method: 'POST' }), permissions: ['crm.write'] })).toBe(true);
    expect(toolRequiresApproval({ ...base, config: { version: 1, iv: '', tag: '', data: '' }, permissions: [] })).toBe(true);
  });
});
