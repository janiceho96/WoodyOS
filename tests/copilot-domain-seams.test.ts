import { describe, expect, it } from 'vitest';
import { createDraftAgentWithClient } from '../src/agents/service.js';
import { insertAuditEvent } from '../src/lib/audit.js';
import { saveOutputVersionWithClient } from '../src/outputs/service.js';

type RecordedQuery = { text: string; values: unknown[] | undefined };

function fakeClient(handler: (text: string, values?: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    client: {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values });
        const result = handler(text, values);
        return { command: '', fields: [], oid: 0, rowCount: result.rowCount ?? result.rows?.length ?? 0, rows: result.rows ?? [] };
      },
    },
  };
}

const workspaceId = '0c46a071-6933-4de1-a602-e5310982a947';
const actorId = '2a55d226-97a7-4de5-aa8c-258f79fdb824';

describe('Copilot transaction-aware domain seams', () => {
  it('inserts audit events through the supplied query runner and returns the event id', async () => {
    const runner = fakeClient(() => ({ rows: [{ id: 'f50ef45a-7488-44aa-b3e8-7b39b092ad42' }] }));
    await expect(insertAuditEvent(runner.client as never, {
      workspaceId,
      actorId,
      action: 'copilot.proposal.applied',
      entityType: 'copilot_proposal',
      entityId: null,
      metadata: { proposalId: 'safe' },
    })).resolves.toBe('f50ef45a-7488-44aa-b3e8-7b39b092ad42');
    expect(runner.queries).toHaveLength(1);
    expect(runner.queries[0].text).toContain('RETURNING id');
  });

  it('creates Draft agents with no executable capabilities through the supplied client', async () => {
    const runner = fakeClient((_text, values) => ({
      rows: [{
        id: '6688bb45-a4f8-4261-8e71-ee8bd43dfe81',
        status: values?.[9],
        tool_ids: JSON.parse(String(values?.[10])),
        capabilities: JSON.parse(String(values?.[8])),
      }],
    }));
    const created = await createDraftAgentWithClient(runner.client as never, {
      workspaceId,
      actorId,
      payload: {
        name: 'Refiner',
        role: 'Editor',
        goal: 'Improve completed results.',
        instructions: 'Keep evidence intact.',
        personality: null,
        model: 'test-model',
        modelConfig: { temperature: 0.2, maxTokens: 4096, topP: 1 },
        capabilities: { webBrowser: true, codeInterpreter: true, knowledgeBase: true },
        memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: true },
        status: 'active',
        toolIds: ['forbidden'],
      } as never,
    });
    expect(created).toMatchObject({
      status: 'draft',
      tool_ids: [],
      capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: true },
    });
    expect(runner.queries).toHaveLength(1);
  });

  it('creates a new output version entirely through the supplied transaction client', async () => {
    const now = new Date().toISOString();
    const document = {
      id: 'd1f58c9a-1681-4a65-8949-9ae2956945bb',
      workspace_id: workspaceId,
      task_id: '45f0429e-a911-492e-96cd-62fa17276211',
      current_version_number: 1,
      created_by: actorId,
      created_at: now,
      updated_at: now,
    };
    const runner = fakeClient((text) => {
      if (text.includes('FROM output_documents') && text.includes('FOR UPDATE')) return { rows: [document] };
      if (text.includes('UPDATE output_documents')) return { rows: [{ ...document, current_version_number: 2 }] };
      if (text.includes('FROM output_document_versions')) {
        return {
          rows: [{
            id: '6f4d43a5-28dd-4123-b99a-97f9a366aa00',
            workspace_id: workspaceId,
            document_id: document.id,
            version_number: 2,
            content: '# Refined',
            content_hash: 'a'.repeat(64),
            created_by: actorId,
            created_at: now,
          }],
        };
      }
      return { rows: [] };
    });

    const detail = await saveOutputVersionWithClient(runner.client as never, {
      workspaceId,
      documentId: document.id,
      actorId,
      content: '# Refined',
      baseVersionNumber: 1,
    });
    expect(detail.current_version_number).toBe(2);
    expect(detail.currentVersion.content).toBe('# Refined');
    expect(runner.queries.some((entry) => entry.text.includes('BEGIN'))).toBe(false);
    expect(runner.queries.some((entry) => entry.text.includes('COMMIT'))).toBe(false);
  });

  it('rejects stale output writes before inserting a version', async () => {
    const runner = fakeClient((text) => text.includes('FROM output_documents')
      ? {
        rows: [{
          id: 'd1f58c9a-1681-4a65-8949-9ae2956945bb',
          workspace_id: workspaceId,
          task_id: '45f0429e-a911-492e-96cd-62fa17276211',
          current_version_number: 2,
          created_by: actorId,
          created_at: new Date(),
          updated_at: new Date(),
        }],
      }
      : { rows: [] });
    await expect(saveOutputVersionWithClient(runner.client as never, {
      workspaceId,
      documentId: 'd1f58c9a-1681-4a65-8949-9ae2956945bb',
      actorId,
      content: '# Refined',
      baseVersionNumber: 1,
    })).rejects.toMatchObject({ message: 'OUTPUT_VERSION_CONFLICT', statusCode: 409 });
    expect(runner.queries.some((entry) => entry.text.includes('INSERT INTO output_document_versions'))).toBe(false);
  });
});
