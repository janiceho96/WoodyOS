import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { encryptJson } from '../src/lib/crypto.js';
import { toolConfigurationError } from '../src/routes/tools.js';
import { demoApiCatalog, publicDemoApi } from '../src/tools/demo-catalog.js';
import { invokeTool } from '../src/tools/runtime.js';
import { retryDecision } from '../src/runtime/errors.js';

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
    ['a BigInt POST body', { method: 'POST', input: { count: 1n } }],
    ['a circular GET query value', { method: 'GET', input: (() => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return { circular };
    })() }],
  ])('rejects %s before dispatch as non-retryable validation', async (_name, request) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));
    const tool = readTool();
    tool.config = encryptJson({
      endpoint: 'https://api.example.test/lookup',
      method: request.method,
      readOnly: true,
    });

    let error: unknown;
    try {
      await invokeTool(tool, request.input);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: 'TOOL_REQUEST_INVALID',
      category: 'validation',
      retryable: false,
    });
    expect(retryDecision(error, {
      attempt: 1,
      nodeRetryable: true,
      policy: { maxAttempts: 3, initialDelayMs: 250, multiplier: 2, maxDelayMs: 1_000 },
      actionRisk: 'read',
    })).toMatchObject({ retry: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('classifies DNS resolution failure from safeEndpoint without dispatching fetch', async () => {
    vi.mocked(lookup).mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test token=do-not-leak'), { code: 'ENOTFOUND' }),
    );
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));

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
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an invalid URL', 'not-a-url'],
    ['a non-HTTPS URL', 'http://api.example.test/lookup'],
  ])('keeps %s non-retryable at the endpoint boundary', async (_name, endpoint) => {
    const tool = readTool();
    tool.config = encryptJson({ endpoint, method: 'GET', readOnly: true });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));

    await expect(invokeTool(tool, {})).rejects.toMatchObject({
      code: 'TOOL_ENDPOINT_INVALID',
      category: 'validation',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a DNS-resolved private endpoint non-retryable without dispatching fetch', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }));

    await expect(invokeTool(readTool(), {})).rejects.toMatchObject({
      code: 'TOOL_ENDPOINT_INVALID',
      category: 'validation',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
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
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeout.signal);
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      timeout.abort(new DOMException('provider timeout', 'TimeoutError'));
      throw new DOMException('aborted', 'AbortError');
    });
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

  it('honors a bounded Retry-After HTTP date', async () => {
    const now = Date.parse('2026-07-28T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', {
      status: 429,
      headers: { 'retry-after': new Date(now + 5_000).toUTCString() },
    }));

    await expect(invokeTool(readTool(), {})).rejects.toMatchObject({
      code: 'TOOL_RATE_LIMITED',
      details: { retryAfterMs: 5_000 },
    });
  });
});
