import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson } from '../src/lib/crypto.js';
import { toolConfigurationError } from '../src/routes/tools.js';
import { demoApiCatalog, publicDemoApi } from '../src/tools/demo-catalog.js';
import { invokeTool } from '../src/tools/runtime.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const previousEncryptionKey = process.env.ENCRYPTION_KEY;
beforeEach(() => {
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  vi.restoreAllMocks();
});

describe('tool configuration validation', () => {
  it('requires a valid HTTPS execution endpoint for API tools', () => {
    expect(toolConfigurationError('api', {})).toBe('endpoint is required');
    expect(toolConfigurationError('api', { endpoint: 'http://api.example.test' })).toBe('endpoint must use HTTPS');
    expect(toolConfigurationError('api', { endpoint: 'https://api.example.test/run' })).toBeNull();
  });

  it('validates the optional health-check endpoint independently', () => {
    expect(toolConfigurationError('api', { endpoint: 'https://api.example.test/run', healthCheckUrl: 'not-a-url' })).toBe('healthCheckUrl must be a valid HTTPS URL');
    expect(toolConfigurationError('api', { endpoint: 'https://api.example.test/run', healthCheckUrl: 'https://api.example.test/health' })).toBeNull();
  });

  it('does not apply remote endpoint rules to internal tools', () => {
    expect(toolConfigurationError('internal', {})).toBeNull();
  });

  it('keeps starter APIs keyless, HTTPS-only, GET-only and read-only', () => {
    expect(demoApiCatalog).toHaveLength(3);
    for (const demo of demoApiCatalog) {
      expect(demo.config).toMatchObject({ method: 'GET', readOnly: true });
      expect(new URL(String(demo.config.endpoint)).protocol).toBe('https:');
      expect(new URL(String(demo.config.healthCheckUrl)).protocol).toBe('https:');
      expect(JSON.stringify(demo.config)).not.toMatch(/api[-_]?key|authorization|bearer|password|secret/i);
      const publicDefinition = publicDemoApi(demo);
      expect(publicDefinition).not.toHaveProperty('config');
      expect(JSON.stringify(publicDefinition)).not.toMatch(/encrypted_credentials|api.?key|authorization/i);
    }
  });

  it('combines caller cancellation with the API tool timeout', async () => {
    let requestSignal: AbortSignal | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      return Response.json({ ok: true });
    });
    const controller = new AbortController();

    await invokeTool({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'lookup',
      kind: 'api',
      config: encryptJson({
        endpoint: 'https://api.example.test/lookup',
        method: 'GET',
        readOnly: true,
      }),
      permissions: ['read'],
    }, {}, false, controller.signal);
    controller.abort();

    expect(requestSignal?.aborted).toBe(true);
  });
});
