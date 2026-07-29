import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import {
  aiProviderCredentialContext,
  configuredAiProvider,
  configuredAiProviderForWorkspace,
  workspaceAiProviderConfig,
  type AiProviderName,
} from '../lib/ai-provider.js';
import { encryptJsonWithContext } from '../lib/crypto.js';
import { asyncRoute, parse } from '../lib/http.js';
import { normalizeCompatibleBaseUrl } from '../lib/safe-provider-fetch.js';
import { enforceWorkspaceAgentModel } from '../agents/versions.js';
import { db, query } from '../db/client.js';

const providerInput = z.object({
  provider: z.enum(['anthropic', 'openai-compatible']),
  defaultModel: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(2_000).optional().nullable(),
  apiKey: z.string().trim().min(8).max(20_000).optional(),
});

function keyHint(value: string) {
  return `•••• ${value.slice(-4)}`;
}

function environmentBaseUrl(provider: AiProviderName) {
  if (provider !== 'openai-compatible' || !process.env.LLM_BASE_URL) return null;
  try { return normalizeCompatibleBaseUrl(process.env.LLM_BASE_URL); }
  catch { return null; }
}

async function publicRuntimeConfig(workspaceId: string) {
  const stored = await workspaceAiProviderConfig(workspaceId);
  if (stored) return {
    provider: stored.provider,
    defaultModel: stored.default_model,
    source: 'workspace' as const,
    configured: true,
    baseUrl: stored.base_url,
    apiKeyHint: stored.api_key_hint,
    status: stored.status,
    lastTestedAt: stored.last_tested_at,
    lastErrorCode: stored.last_error_code,
    lastErrorMessage: stored.last_error_message,
    updatedAt: stored.updated_at,
  };
  const runtime = configuredAiProvider();
  const environmentKey = runtime.provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.LLM_API_KEY;
  return {
    provider: runtime.provider,
    defaultModel: runtime.defaultModel,
    source: environmentKey ? 'environment' as const : 'unconfigured' as const,
    configured: Boolean(runtime.anthropic || runtime.openAiCompatible),
    baseUrl: environmentBaseUrl(runtime.provider),
    apiKeyHint: environmentKey ? keyHint(environmentKey) : null,
    status: environmentKey ? 'environment' as const : 'error' as const,
    lastTestedAt: null,
    lastErrorCode: environmentKey ? null : 'AI_NOT_CONFIGURED',
    lastErrorMessage: environmentKey ? null : 'Add a provider API key to use agents, Prompt-to-Agent, and Woody chat.',
    updatedAt: null,
  };
}

function safeProviderFailure(cause: unknown) {
  const status = cause && typeof cause === 'object' && 'status' in cause ? Number((cause as { status?: unknown }).status) : 0;
  const reportedCode = cause && typeof cause === 'object' && 'code' in cause && typeof (cause as { code?: unknown }).code === 'string'
    ? String((cause as { code: string }).code)
    : '';
  const code = reportedCode.startsWith('AI_PROVIDER_') ? reportedCode
    : status === 401 || status === 403 ? 'AI_PROVIDER_AUTH_FAILED'
      : status === 404 ? 'AI_PROVIDER_MODEL_NOT_FOUND'
        : status === 429 ? 'AI_PROVIDER_RATE_LIMITED'
          : 'AI_PROVIDER_REQUEST_FAILED';
  const message = code === 'AI_PROVIDER_AUTH_FAILED' ? 'The provider rejected the API key.'
    : code === 'AI_PROVIDER_MODEL_NOT_FOUND' ? 'The configured model was not found.'
      : code === 'AI_PROVIDER_RATE_LIMITED' ? 'The provider rate limit was reached.'
        : code.startsWith('AI_PROVIDER_ENDPOINT') || code === 'AI_PROVIDER_REDIRECT_BLOCKED' ? (cause instanceof Error ? cause.message : 'The provider endpoint is not allowed.')
          : 'Woody could not complete a test request to this provider.';
  return { code, message };
}

export async function runtimeRoutes(app: FastifyInstance) {
  app.get('/config', { preHandler: app.authenticate }, asyncRoute(async (request) => publicRuntimeConfig(request.user.workspaceId)));

  app.put('/config', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const input = parse(providerInput, request.body, reply); if (!input) return;
    const existing = await workspaceAiProviderConfig(request.user.workspaceId);
    const providerChanged = existing?.provider !== input.provider;
    const apiKey = input.apiKey;
    if (!apiKey && (!existing || providerChanged)) return reply.code(400).send({ error: 'AI_PROVIDER_API_KEY_REQUIRED', message: 'Enter the API key for the selected provider.' });
    const baseUrl = input.provider === 'openai-compatible' ? normalizeCompatibleBaseUrl(input.baseUrl ?? '') : null;
    const encrypted = apiKey
      ? encryptJsonWithContext({ apiKey }, aiProviderCredentialContext(request.user.workspaceId))
      : existing!.encrypted_api_key;
    const hint = apiKey ? keyHint(apiKey) : existing!.api_key_hint;
    const changed = !existing || providerChanged || existing.base_url !== baseUrl || existing.default_model !== input.defaultModel || Boolean(apiKey);
    const providerOrModelChanged = !existing || providerChanged || existing.default_model !== input.defaultModel;
    const modelEnforcement = { agentsUpdated: 0, versionsPublished: 0 };
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO workspace_ai_provider_configs(
           workspace_id,provider,base_url,default_model,encrypted_api_key,api_key_hint,status,created_by,updated_by
         ) VALUES($1,$2,$3,$4,$5,$6,'untested',$7,$7)
         ON CONFLICT(workspace_id) DO UPDATE SET
           provider=EXCLUDED.provider,base_url=EXCLUDED.base_url,default_model=EXCLUDED.default_model,
           encrypted_api_key=EXCLUDED.encrypted_api_key,api_key_hint=EXCLUDED.api_key_hint,
           status=CASE WHEN $8 THEN 'untested' ELSE workspace_ai_provider_configs.status END,
           last_tested_at=CASE WHEN $8 THEN NULL ELSE workspace_ai_provider_configs.last_tested_at END,
           last_error_code=CASE WHEN $8 THEN NULL ELSE workspace_ai_provider_configs.last_error_code END,
           last_error_message=CASE WHEN $8 THEN NULL ELSE workspace_ai_provider_configs.last_error_message END,
           updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [request.user.workspaceId, input.provider, baseUrl, input.defaultModel, JSON.stringify(encrypted), hint, request.user.sub, changed],
      );
      if (providerOrModelChanged) {
        Object.assign(modelEnforcement, await enforceWorkspaceAgentModel(client, {
          workspaceId: request.user.workspaceId,
          actorId: request.user.sub,
          model: input.defaultModel,
        }));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await audit(request.user.workspaceId, request.user.sub, 'runtime.provider.updated', 'workspace', request.user.workspaceId, {
      provider: input.provider,
      model: input.defaultModel,
      baseUrl,
      credentialChanged: Boolean(apiKey),
      modelEnforcement,
    });
    return { ...await publicRuntimeConfig(request.user.workspaceId), modelEnforcement };
  }));

  app.post('/config/test', { preHandler: (request) => app.authorize(request, ['owner', 'admin']) }, asyncRoute(async (request, reply) => {
    const runtime = await configuredAiProviderForWorkspace(request.user.workspaceId);
    const checkedAt = new Date().toISOString();
    try {
      if (runtime.anthropic) await runtime.anthropic.messages.create({ model: runtime.defaultModel, max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }] });
      else if (runtime.openAiCompatible) await runtime.openAiCompatible.chat.completions.create({ model: runtime.defaultModel, max_tokens: 1, messages: [{ role: 'user', content: 'Reply OK.' }] });
      else throw Object.assign(new Error('No configured AI provider is available.'), { code: 'AI_NOT_CONFIGURED' });
      await query("UPDATE workspace_ai_provider_configs SET status='healthy',last_tested_at=now(),last_error_code=NULL,last_error_message=NULL,updated_at=now() WHERE workspace_id=$1", [request.user.workspaceId]);
      await audit(request.user.workspaceId, request.user.sub, 'runtime.provider.tested', 'workspace', request.user.workspaceId, { provider: runtime.provider, model: runtime.defaultModel, result: 'healthy' });
      return { ok: true, status: 'healthy', provider: runtime.provider, model: runtime.defaultModel, checkedAt };
    } catch (cause) {
      const failure = safeProviderFailure(cause);
      await query("UPDATE workspace_ai_provider_configs SET status='error',last_tested_at=now(),last_error_code=$1,last_error_message=$2,updated_at=now() WHERE workspace_id=$3", [failure.code, failure.message, request.user.workspaceId]);
      await audit(request.user.workspaceId, request.user.sub, 'runtime.provider.tested', 'workspace', request.user.workspaceId, { provider: runtime.provider, model: runtime.defaultModel, result: 'error', errorCode: failure.code });
      return reply.code(failure.code === 'AI_PROVIDER_AUTH_FAILED' ? 401 : 502).send({ error: failure.code, message: failure.message });
    }
  }));
}
