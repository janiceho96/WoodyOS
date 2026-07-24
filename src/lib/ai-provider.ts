import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { query } from '../db/client.js';
import { decryptJsonWithContext, type EncryptedPayload } from './crypto.js';
import { createSafeProviderFetch, normalizeCompatibleBaseUrl } from './safe-provider-fetch.js';

export type AiProviderName = 'anthropic' | 'openai-compatible' | 'unknown';

export type AiProviderRuntime = {
  provider: AiProviderName;
  defaultModel: string;
  anthropic: Anthropic | null;
  openAiCompatible: OpenAI | null;
};

export type WorkspaceAiProviderConfig = {
  workspace_id: string;
  provider: Exclude<AiProviderName, 'unknown'>;
  base_url: string | null;
  default_model: string;
  encrypted_api_key: EncryptedPayload;
  api_key_hint: string;
  status: 'untested' | 'healthy' | 'error';
  last_tested_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  updated_at: string;
};

export function aiProviderCredentialContext(workspaceId: string) {
  return `ai-provider:${workspaceId}`;
}

export function aiProviderRuntime(input: { provider: Exclude<AiProviderName, 'unknown'>; defaultModel: string; apiKey: string; baseUrl?: string | null }): AiProviderRuntime {
  if (input.provider === 'anthropic') return {
    provider: input.provider,
    defaultModel: input.defaultModel,
    anthropic: new Anthropic({ apiKey: input.apiKey }),
    openAiCompatible: null,
  };
  const baseURL = normalizeCompatibleBaseUrl(input.baseUrl ?? '');
  return {
    provider: input.provider,
    defaultModel: input.defaultModel,
    anthropic: null,
    openAiCompatible: new OpenAI({ apiKey: input.apiKey, baseURL, fetch: createSafeProviderFetch(baseURL) }),
  };
}

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

export async function workspaceAiProviderConfig(workspaceId: string) {
  return (await query<WorkspaceAiProviderConfig>(
    `SELECT workspace_id,provider,base_url,default_model,encrypted_api_key,api_key_hint,status,
     last_tested_at,last_error_code,last_error_message,updated_at
     FROM workspace_ai_provider_configs WHERE workspace_id=$1`,
    [workspaceId],
  )).rows[0] ?? null;
}

export async function configuredAiProviderForWorkspace(workspaceId: string): Promise<AiProviderRuntime> {
  const stored = await workspaceAiProviderConfig(workspaceId);
  if (!stored) return configuredAiProvider();
  const credentials = decryptJsonWithContext(stored.encrypted_api_key, aiProviderCredentialContext(workspaceId));
  const apiKey = typeof credentials.apiKey === 'string' ? credentials.apiKey : '';
  if (!apiKey) return { provider: stored.provider, defaultModel: stored.default_model, anthropic: null, openAiCompatible: null };
  return aiProviderRuntime({ provider: stored.provider, defaultModel: stored.default_model, apiKey, baseUrl: stored.base_url });
}

export function assertConfiguredAiProvider(runtime: AiProviderRuntime) {
  if (!runtime.anthropic && !runtime.openAiCompatible) {
    throw Object.assign(new Error('AI_NOT_CONFIGURED'), { statusCode: 503, code: 'AI_NOT_CONFIGURED' });
  }
  return runtime;
}
