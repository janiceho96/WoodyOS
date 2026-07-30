import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCopilotModelAdapter, parseJsonObject, safeZodIssues } from '../src/copilot/graph/model.js';

describe('Copilot graph model adapter', () => {
  it('parses a fenced structured intent response', async () => {
    const complete = vi.fn(async () => ({
      message: '```json\n{"intent":"answer_question"}\n```',
      provider: 'test',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    }));
    const adapter = createCopilotModelAdapter(complete as never);

    await expect(adapter.classify({ workspaceId: 'workspace', messages: [] } as never))
      .resolves.toBe('answer_question');
  });

  it('returns only safe validation paths and codes', () => {
    const parsed = z.object({ goal: z.string().min(2) }).safeParse({ goal: '' });
    if (parsed.success) throw new Error('expected invalid fixture');

    expect(safeZodIssues(parsed.error)).toEqual([
      { path: ['goal'], code: 'too_small' },
    ]);
  });

  it('rejects structured responses surrounded by prose', () => {
    expect(() => parseJsonObject('Here is the result: {"intent":"answer_question"}')).toThrow(SyntaxError);
  });

  it('sends repair diagnostics without conversation, output, or attachment text', async () => {
    const complete = vi.fn(async () => ({
      message: '{"type":"refinement_candidate","proposedContent":"# Improved","changeSummary":["Clarified"]}',
      provider: 'test',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    }));
    const adapter = createCopilotModelAdapter(complete as never);

    await adapter.answer({
      workspaceId: 'workspace',
      messages: [{ role: 'user', content: 'conversation history that must stay private' }],
      outputContent: 'private output that must stay private',
      attachmentContext: 'private attachment that must stay private',
    });
    await adapter.repairProposal({
      workspaceId: 'workspace',
      proposalKind: 'output_refinement',
      candidate: { type: 'refinement_candidate', proposedContent: '', changeSummary: [] },
      issues: [{ path: ['proposedContent'], code: 'too_small' }],
    });

    const request = complete.mock.calls[1]?.[0];
    const prompt = JSON.stringify(request);
    expect(prompt).toContain('proposedContent');
    expect(prompt).toContain('too_small');
    expect(prompt).not.toContain('conversation history that must stay private');
    expect(prompt).not.toContain('private output that must stay private');
    expect(prompt).not.toContain('private attachment that must stay private');
  });

  it('returns answer output as text without parsing it as a proposal', async () => {
    const complete = vi.fn(async () => ({
      message: 'This is an answer, not JSON.',
      provider: 'test',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    }));
    const adapter = createCopilotModelAdapter(complete as never);

    await expect(adapter.answer({
      workspaceId: 'workspace',
      messages: [{ role: 'user', content: 'conversation history that must stay private' }],
      outputContent: 'private output that must stay private',
      attachmentContext: 'private attachment that must stay private',
    })).resolves.toBe('This is an answer, not JSON.');
  });

  it('includes attachment extracts only in answer and proposal generation calls', async () => {
    const complete = vi.fn(async () => ({
      message: '{"intent":"answer_question"}',
      provider: 'test',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    }));
    const adapter = createCopilotModelAdapter(complete as never);
    const input = {
      workspaceId: 'workspace',
      messages: [{ role: 'user' as const, content: 'Classify this request.' }],
      attachmentContext: 'attachment extract only for grounded responses',
    };

    await adapter.classify(input);
    await adapter.generateProposal({ ...input, proposalKind: 'output_refinement' });

    expect(JSON.stringify(complete.mock.calls[0]?.[0])).not.toContain(input.attachmentContext);
    expect(JSON.stringify(complete.mock.calls[1]?.[0])).toContain(input.attachmentContext);
  });

  it('rejects classification intents outside the five supported values', async () => {
    const complete = vi.fn(async () => ({
      message: '{"intent":"publish_agent"}',
      provider: 'test',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    }));
    const adapter = createCopilotModelAdapter(complete as never);

    await expect(adapter.classify({ workspaceId: 'workspace', messages: [] }))
      .rejects.toThrow();
  });

  it.each([
    'answer_question',
    'refine_output',
    'create_draft_agent',
    'clarify',
    'unsupported',
  ] as const)('accepts supported classification intent %s', async (intent) => {
    const complete = vi.fn(async () => ({
      message: JSON.stringify({ intent }),
      provider: 'test',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    }));
    const adapter = createCopilotModelAdapter(complete as never);

    await expect(adapter.classify({ workspaceId: 'workspace', messages: [] })).resolves.toBe(intent);
  });
});
