import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  requestSignals: [] as Array<AbortSignal | undefined>,
}));
const requestMock = vi.hoisted(() => vi.fn(
  async (_url: string, options: { signal?: AbortSignal } = {}) => {
    state.requestSignals.push(options.signal);
    if (!options.signal) throw new Error('caller cancellation signal was discarded');
    return new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error('aborted'));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  },
));

vi.mock('../src/tools/web/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/web/http.js')>();
  return {
    ...actual,
    safeHttpRequest: requestMock,
  };
});

import { encryptJson } from '../src/lib/crypto.js';
import { invokeTool, type ToolRecord } from '../src/tools/runtime.js';

const previousEncryptionKey = process.env.ENCRYPTION_KEY;

function internalTool(config: Record<string, unknown>, permissions: string[]): ToolRecord {
  return {
    id: crypto.randomUUID(),
    name: 'internal lookup',
    kind: 'internal',
    config: encryptJson(config),
    permissions,
  };
}

describe('internal tool active cancellation', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    state.requestSignals = [];
    requestMock.mockClear();
  });

  afterEach(() => {
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  });

  it('aborts an active internal web request with the task caller signal', async () => {
    const controller = new AbortController();
    const outcome = invokeTool(internalTool({
      adapter: 'web.search',
      provider: 'tavily',
      apiKey: 'test-key',
      readOnly: true,
    }, ['web.read', 'web.search']), { query: 'distributed cancellation' }, false, controller.signal)
      .catch((error: unknown) => error);

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledOnce());
    controller.abort(new Error('task cancelled'));
    await outcome;

    expect(state.requestSignals).toEqual([controller.signal]);
    expect(state.requestSignals[0]?.aborted).toBe(true);
  });

  it('aborts an active internal job request with the task caller signal', async () => {
    const controller = new AbortController();
    const outcome = invokeTool(internalTool({
      adapter: 'jobs.search',
      provider: 'adzuna',
      appId: 'test-app',
      appKey: 'test-key',
      country: 'sg',
      readOnly: true,
    }, ['web.read', 'jobs.read']), { query: 'platform engineer' }, false, controller.signal)
      .catch((error: unknown) => error);

    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledOnce());
    controller.abort(new Error('task cancelled'));
    await outcome;

    expect(state.requestSignals).toEqual([controller.signal]);
    expect(state.requestSignals[0]?.aborted).toBe(true);
  });
});
