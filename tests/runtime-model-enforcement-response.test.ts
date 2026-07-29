import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  auditWithClient: vi.fn(),
  clientQuery: vi.fn(),
  enforceWorkspaceAgentModel: vi.fn(),
  release: vi.fn(),
  workspaceAiProviderConfig: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => ({ query: state.clientQuery, release: state.release })) },
  query: vi.fn(),
}));

vi.mock('../src/agents/versions.js', () => ({
  enforceWorkspaceAgentModel: state.enforceWorkspaceAgentModel,
}));

vi.mock('../src/lib/audit.js', () => ({
  audit: vi.fn(),
  auditWithClient: state.auditWithClient,
}));

vi.mock('../src/lib/ai-provider.js', () => ({
  aiProviderCredentialContext: vi.fn(() => 'ai-provider:workspace-id'),
  configuredAiProvider: vi.fn(),
  configuredAiProviderForWorkspace: vi.fn(),
  workspaceAiProviderConfig: state.workspaceAiProviderConfig,
}));

vi.mock('../src/lib/crypto.js', () => ({
  encryptJsonWithContext: vi.fn(() => ({ ciphertext: 'encrypted-provider-key' })),
}));

vi.mock('../src/lib/safe-provider-fetch.js', () => ({
  normalizeCompatibleBaseUrl: vi.fn((value: string) => value),
}));

import { runtimeRoutes } from '../src/routes/runtime.js';

describe('runtime provider save response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.enforceWorkspaceAgentModel.mockResolvedValue({ agentsUpdated: 2, versionsPublished: 1 });
    state.workspaceAiProviderConfig.mockRejectedValue(new Error('post-commit configuration read'));
    state.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.includes('SELECT id FROM workspaces')) return { rowCount: 1, rows: [{ id: 'workspace-id' }] };
      if (sql.includes('FROM workspace_ai_provider_configs') && sql.includes('FOR UPDATE')) {
        return {
          rowCount: 1,
          rows: [{
            workspace_id: 'workspace-id',
            provider: 'openai-compatible',
            base_url: 'https://example.com/v1',
            default_model: 'model-before-save',
            encrypted_api_key: { ciphertext: 'old-encrypted-provider-key' },
            api_key_hint: '•••• -key',
            status: 'healthy',
            last_tested_at: '2026-07-29T00:00:00.000Z',
            last_error_code: null,
            last_error_message: null,
            updated_at: '2026-07-29T00:00:00.000Z',
          }],
        };
      }
      if (sql.includes('INSERT INTO workspace_ai_provider_configs')) {
        return {
          rowCount: 1,
          rows: [{
            provider: 'openai-compatible',
            base_url: 'https://example.com/v1',
            default_model: 'model-after-save',
            api_key_hint: '•••• -key',
            status: 'untested',
            last_tested_at: null,
            last_error_code: null,
            last_error_message: null,
            updated_at: '2026-07-29T01:00:00.000Z',
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it('returns the transaction-local provider configuration without a post-commit read', async () => {
    const app = Fastify();
    app.decorate('authorize', async () => {});
    app.addHook('preHandler', async (request) => {
      (request as typeof request & { user: { sub: string; workspaceId: string } }).user = {
        sub: 'actor-id',
        workspaceId: 'workspace-id',
      };
    });
    await runtimeRoutes(app);

    const response = await app.inject({
      method: 'PUT',
      url: '/config',
      payload: {
        provider: 'openai-compatible',
        defaultModel: 'model-after-save',
        baseUrl: 'https://example.com/v1',
      },
    });
    await app.close();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      provider: 'openai-compatible',
      defaultModel: 'model-after-save',
      source: 'workspace',
      configured: true,
      baseUrl: 'https://example.com/v1',
      status: 'untested',
      modelEnforcement: { agentsUpdated: 2, versionsPublished: 1 },
    });
    expect(response.body).not.toContain('encrypted-provider-key');
    expect(state.workspaceAiProviderConfig).not.toHaveBeenCalled();
  });
});
