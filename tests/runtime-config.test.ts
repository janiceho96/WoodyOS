import { describe, expect, it } from 'vitest';
import { aiProviderCredentialContext, aiProviderRuntime } from '../src/lib/ai-provider.js';
import { normalizeCompatibleBaseUrl } from '../src/lib/safe-provider-fetch.js';

describe('workspace AI provider configuration', () => {
  it('normalizes OpenAI-compatible completion URLs into SDK base URLs', () => {
    expect(normalizeCompatibleBaseUrl('https://api.silra.cn/v1/chat/completions')).toBe('https://api.silra.cn/v1');
    expect(normalizeCompatibleBaseUrl('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1');
  });

  it('rejects provider URLs that could expose credentials or reach insecure endpoints', () => {
    expect(() => normalizeCompatibleBaseUrl('http://localhost:11434/v1')).toThrow('must use HTTPS');
    expect(() => normalizeCompatibleBaseUrl('https://user:secret@example.com/v1')).toThrow('Do not place credentials');
    expect(() => normalizeCompatibleBaseUrl('https://example.com/v1?key=secret')).toThrow('cannot contain query strings');
  });

  it('constructs only the selected provider client and uses workspace-bound credential context', () => {
    const anthropic = aiProviderRuntime({ provider: 'anthropic', defaultModel: 'claude-test', apiKey: 'test-anthropic-key' });
    expect(anthropic).toMatchObject({ provider: 'anthropic', defaultModel: 'claude-test', openAiCompatible: null });
    expect(anthropic.anthropic).toBeTruthy();
    const compatible = aiProviderRuntime({ provider: 'openai-compatible', defaultModel: 'model-test', apiKey: 'test-compatible-key', baseUrl: 'https://example.com/v1/chat/completions' });
    expect(compatible).toMatchObject({ provider: 'openai-compatible', defaultModel: 'model-test', anthropic: null });
    expect(compatible.openAiCompatible).toBeTruthy();
    expect(aiProviderCredentialContext('workspace-one')).toBe('ai-provider:workspace-one');
  });
});
