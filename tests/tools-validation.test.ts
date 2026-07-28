import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptJson } from '../src/lib/crypto.js';
import { toolConfigurationError } from '../src/routes/tools.js';
import { demoApiCatalog, publicDemoApi } from '../src/tools/demo-catalog.js';
import { invokeTool } from '../src/tools/runtime.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

const previousEncryptionKey = process.env.ENCRYPTION_KEY;

function readTool() {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'lookup',
    kind: 'api' as const,
    config: encryptJson({
      endpoint: 'https://api.example.test/lookup',
      method: 'GET',
      readOnly: true,
    }),
    permissions: ['read'],
  };
}
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

describe('tool runtime error classification', () => {
  it.each([
    ['DNS lookup failure', Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test token=do-not-leak'), { code: 'ENOTFOUND' })],
    ['connection reset', Object.assign(new Error('read ECONNRESET authorization=Bearer do-not-leak'), { code: 'ECONNRESET' })],
    ['connection refused', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['fetch transport failure', new TypeError('fetch failed')],
  ])('classifies a read-tool %s as retryable transient without exposing transport details', async (_name, failure) => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(failure);

    let error: unknown;
    try {
      await invokeTool(readTool(), {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'TOOL_TRANSPORT_FAILURE',
      category: 'transient',
      retryable: true,
      message: 'Tool endpoint could not be reached',
    });
    expect(JSON.stringify(error)).not.toContain('do-not-leak');
  });

  it('classifies bounded transport timeouts as retryable without confusing caller cancellation', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('provider timeout', 'TimeoutError'));
    await expect(invokeTool(readTool(), {})).rejects.toMatchObject({
      code: 'TOOL_TIMEOUT',
      category: 'timeout',
      retryable: true,
      message: 'Tool request timed out',
    });

    const controller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      controller.abort(new Error('cancelled with token=do-not-leak'));
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(invokeTool(readTool(), {}, false, controller.signal)).rejects.toMatchObject({
      code: 'RUNTIME_CANCELLED',
      category: 'cancelled',
      retryable: false,
    });
  });

  it('does not start a tool request after distributed cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled with token=do-not-leak'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    await expect(invokeTool(readTool(), {}, false, controller.signal)).rejects.toMatchObject({
      code: 'RUNTIME_CANCELLED',
      category: 'cancelled',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [429, { 'retry-after': '2' }, { code: 'TOOL_RATE_LIMITED', category: 'rate_limited', retryable: true, details: { retryAfterMs: 2_000 } }],
    [408, {}, { code: 'TOOL_HTTP_TRANSIENT', category: 'transient', retryable: true }],
    [425, {}, { code: 'TOOL_HTTP_TRANSIENT', category: 'transient', retryable: true }],
    [500, {}, { code: 'TOOL_HTTP_TRANSIENT', category: 'transient', retryable: true }],
    [502, {}, { code: 'TOOL_HTTP_TRANSIENT', category: 'transient', retryable: true }],
    [503, {}, { code: 'TOOL_HTTP_TRANSIENT', category: 'transient', retryable: true }],
    [504, {}, { code: 'TOOL_HTTP_TRANSIENT', category: 'transient', retryable: true }],
    [401, {}, { code: 'TOOL_AUTHENTICATION_FAILED', category: 'authentication', retryable: false }],
    [403, {}, { code: 'TOOL_AUTHENTICATION_FAILED', category: 'authentication', retryable: false }],
    [422, {}, { code: 'TOOL_HTTP_VALIDATION_FAILED', category: 'validation', retryable: false }],
  ])('classifies HTTP %s without exposing a response body', async (status, headers, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('token=do-not-leak', { status, headers }));

    let error: unknown;
    try {
      await invokeTool(readTool(), {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject(expected);
    expect(JSON.stringify(error)).not.toContain('do-not-leak');
  });

  it('bounds valid Retry-After values and ignores malformed ones', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '999' } }))
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': 'not-a-delay' } }));

    await expect(invokeTool(readTool(), {})).rejects.toMatchObject({
      code: 'TOOL_RATE_LIMITED',
      details: { retryAfterMs: 60_000 },
    });
    await expect(invokeTool(readTool(), {})).rejects.toMatchObject({
      code: 'TOOL_RATE_LIMITED',
      details: undefined,
    });
  });
});
