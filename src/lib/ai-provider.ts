import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type AiProviderName = 'anthropic' | 'openai-compatible' | 'unknown';

export type AiProviderRuntime = {
  provider: AiProviderName;
  defaultModel: string;
  anthropic: Anthropic | null;
  openAiCompatible: OpenAI | null;
};

export function configuredAiProvider(): AiProviderRuntime {
  const configured = process.env.LLM_PROVIDER ?? 'anthropic';
  const provider: AiProviderName = configured === 'anthropic' || configured === 'openai-compatible'
    ? configured
    : 'unknown';
  const compatibleBaseUrl = (process.env.LLM_BASE_URL ?? '')
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/$/, '');
  return {
    provider,
    defaultModel: process.env.LLM_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514',
    anthropic: provider === 'anthropic' && process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null,
    openAiCompatible: provider === 'openai-compatible' && process.env.LLM_API_KEY && compatibleBaseUrl
      ? new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: compatibleBaseUrl })
      : null,
  };
}

export function assertConfiguredAiProvider(runtime: AiProviderRuntime) {
  if (!runtime.anthropic && !runtime.openAiCompatible) {
    throw Object.assign(new Error('AI_NOT_CONFIGURED'), { statusCode: 503, code: 'AI_NOT_CONFIGURED' });
  }
  return runtime;
}

