import { afterEach, describe, expect, it, vi } from 'vitest';
import { embeddingFor } from '../src/lib/embeddings.js';

describe('embedding facility', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('forwards the caller abort signal to the embedding request', async () => {
    vi.stubEnv('EMBEDDING_API_URL', 'https://embedding.example.test');
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: Array.from({ length: 1_536 }, () => 0.1) }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await embeddingFor('bounded memory embedding', { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://embedding.example.test',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
