import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  encryptedPlaintext: null as Record<string, unknown> | null,
}));

const client = {
  async query(sql: string) {
    if (sql.includes('SELECT workflow_run_id FROM tasks')) {
      return { rowCount: 1, rows: [{ workflow_run_id: null }] };
    }
    if (sql.includes('SELECT status FROM tasks')) {
      return { rowCount: 1, rows: [{ status: 'running' }] };
    }
    if (sql.includes('INSERT INTO mcp_tool_calls')) {
      return { rowCount: 1, rows: [{ id: '00000000-0000-4000-8000-000000000020' }] };
    }
    return { rowCount: 1, rows: [] };
  },
  release() {},
};

vi.mock('../src/db/client.js', () => ({
  db: { connect: vi.fn(async () => client) },
  query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
}));
vi.mock('../src/lib/crypto.js', () => ({
  encryptJsonWithContext: vi.fn((value: Record<string, unknown>) => {
    state.encryptedPlaintext = structuredClone(value);
    return { version: 2, iv: 'iv', authTag: 'tag', ciphertext: 'ciphertext' };
  }),
  decryptJsonWithContext: vi.fn(),
}));

import { pauseForActionConfirmation } from '../src/mcp/checkpoints.js';

describe('checkpoint redaction', () => {
  it('removes an earlier raw action failure before a later approval state is encrypted', async () => {
    await pauseForActionConfirmation({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      taskId: '00000000-0000-4000-8000-000000000002',
      agentId: '00000000-0000-4000-8000-000000000003',
      requestedBy: '00000000-0000-4000-8000-000000000004',
      authorizationId: '00000000-0000-4000-8000-000000000005',
      trace: {
        traceId: '00000000-0000-4000-8000-000000000006',
        spanId: '00000000-0000-4000-8000-000000000007',
        parentSpanId: null,
      },
      state: {
        provider: 'openai-compatible',
        system: 'Be helpful',
        messages: [
          { role: 'tool', tool_call_id: 'failed-call', content: 'provider body {"apiKey":"raw-action-secret"}' },
          { role: 'assistant', content: null, tool_calls: [] },
        ],
        finalText: '',
        inputTokens: 10,
        outputTokens: 5,
        toolCallCount: 2,
        nextTurn: 2,
        pending: {
          adapter: 'api',
          toolId: '00000000-0000-4000-8000-000000000008',
          providerCallId: 'approval-call',
          arguments: { query: 'safe operation input' },
          authorizationId: '00000000-0000-4000-8000-000000000005',
        },
      },
    });

    expect(JSON.stringify(state.encryptedPlaintext)).not.toContain('raw-action-secret');
    expect(state.encryptedPlaintext).toMatchObject({
      pending: {
        authorizationId: '00000000-0000-4000-8000-000000000005',
        arguments: { query: 'safe operation input' },
      },
    });
  });
});
