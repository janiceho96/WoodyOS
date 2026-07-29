import { describe, expect, it, vi } from 'vitest';
import type { CopilotContextSnapshotRecord, CopilotGeneratedTurn } from '../src/copilot/types.js';
import {
  orchestrateCopilotTurn,
  type CopilotOrchestratorDependencies,
  type CopilotTurnGenerator,
} from '../src/copilot/orchestrator.js';

const workspaceId = '0c46a071-6933-4de1-a602-e5310982a947';
const actorId = '2a55d226-97a7-4de5-aa8c-258f79fdb824';
const threadId = 'f50ef45a-7488-44aa-b3e8-7b39b092ad42';
const contextSnapshotId = 'd1f58c9a-1681-4a65-8949-9ae2956945bb';

const context: CopilotContextSnapshotRecord = {
  id: contextSnapshotId,
  threadId,
  createdAt: '2026-07-29T10:00:00.000Z',
  snapshot: {
    schemaVersion: 1,
    workspaceId,
    actorId,
    workflow: null,
    run: null,
    task: { id: '0d37888d-0f0b-4d87-aed1-a4a453d212f9', status: 'completed' },
    output: {
      documentId: '45f0429e-a911-492e-96cd-62fa17276211',
      versionId: '6f4d43a5-28dd-4123-b99a-97f9a366aa00',
      versionNumber: 1,
      contentHash: 'a'.repeat(64),
    },
    capturedAt: '2026-07-29T10:00:00.000Z',
  },
};

function dependencies(turn: unknown, clarificationRound = 0) {
  const createProposal = vi.fn(async (input: { kind: 'output_refinement' | 'draft_agent' }) => ({
    id: '6688bb45-a4f8-4261-8e71-ee8bd43dfe81',
    kind: input.kind,
    status: 'ready_for_review' as const,
    contextSnapshotId,
    payload: input.kind === 'output_refinement'
      ? {
        documentId: context.snapshot.output.documentId,
        baseVersionId: context.snapshot.output.versionId,
        baseVersionNumber: 1,
        baseContentHash: context.snapshot.output.contentHash,
        proposedContent: '# Improved result',
        proposedContentHash: 'b'.repeat(64),
        changeSummary: ['Clarified the conclusion'],
      }
      : {
        name: 'Draft Writer',
        role: 'Writer',
        goal: 'Draft a useful response',
        instructions: 'Use the approved output.',
        personality: null,
        model: 'test-model',
        modelConfig: { temperature: 0.2, maxTokens: 1000, topP: 1 },
        capabilities: { webBrowser: false as const, codeInterpreter: false as const, knowledgeBase: false },
        memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: false },
        status: 'draft' as const,
        toolIds: [] as [],
      },
    payloadHash: 'c'.repeat(64),
    dependsOnOutputVersion: true,
    expiresAt: '2026-07-30T10:00:00.000Z',
    createdAt: '2026-07-29T10:00:00.000Z',
    appliedAt: null,
    errorCode: null,
  }));
  const generator = vi.fn(async () => turn as CopilotGeneratedTurn);
  const deps: CopilotOrchestratorDependencies = {
    loadTurnContext: vi.fn(async () => ({ context, outputContent: '# Original', clarificationRound })),
    createProposal: createProposal as never,
    generator,
  };
  return { deps, createProposal, generator };
}

const input = {
  workspaceId,
  actorId,
  threadId,
  messages: [{ role: 'user' as const, content: 'Please improve this output.' }],
};

describe('Copilot turn orchestration', () => {
  it('keeps clarification in the same thread without creating a proposal', async () => {
    const { deps, createProposal } = dependencies({
      type: 'clarification',
      proposalKind: 'output_refinement',
      questions: [{ id: 'audience', question: 'Who is the audience?' }],
    });

    const result = await orchestrateCopilotTurn(input, deps);

    expect(result).toMatchObject({
      contextSnapshotId,
      event: { type: 'clarification', proposalKind: 'output_refinement' },
    });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('creates a reviewable refinement proposal from authoritative output context', async () => {
    const { deps, createProposal } = dependencies({
      type: 'refinement_candidate',
      proposedContent: '# Improved result',
      changeSummary: ['Clarified the conclusion'],
    });

    const result = await orchestrateCopilotTurn(input, deps);

    expect(result.event.type).toBe('refinement_preview');
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      actorId,
      threadId,
      contextSnapshotId,
      kind: 'output_refinement',
      dependsOnOutputVersion: true,
      candidate: expect.objectContaining({
        documentId: context.snapshot.output.documentId,
        baseVersionId: context.snapshot.output.versionId,
        baseContentHash: context.snapshot.output.contentHash,
        proposedContent: '# Improved result',
      }),
    }));
  });

  it('normalizes a draft candidate through the proposal service', async () => {
    const candidate = {
      name: 'Draft Writer',
      role: 'Writer',
      goal: 'Draft a useful response',
      instructions: 'Use the approved output.',
      personality: null,
      model: 'test-model',
      modelConfig: { temperature: 0.2, maxTokens: 1000, topP: 1 },
      capabilities: { webBrowser: true, codeInterpreter: true, knowledgeBase: false },
      memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: false },
    };
    const { deps, createProposal } = dependencies({
      type: 'draft_agent_candidate',
      candidate,
      dependsOnOutputVersion: true,
    });

    const result = await orchestrateCopilotTurn(input, deps);

    expect(result.event.type).toBe('agent_proposal');
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'draft_agent',
      candidate,
      dependsOnOutputVersion: true,
    }));
  });

  it('fails closed when structured output is invalid', async () => {
    const { deps, createProposal } = dependencies({
      type: 'refinement_candidate',
      proposedContent: '',
      changeSummary: [],
    });

    const result = await orchestrateCopilotTurn(input, deps);

    expect(result.event).toEqual({
      type: 'message',
      content: 'I could not create a safe proposal. Please try again.',
    });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('fails closed when a draft candidate cannot be normalized', async () => {
    const { deps, createProposal } = dependencies({
      type: 'draft_agent_candidate',
      candidate: { name: 'Missing required fields' },
      dependsOnOutputVersion: false,
    });
    createProposal.mockRejectedValueOnce(new (await import('zod')).z.ZodError([]) as never);

    const result = await orchestrateCopilotTurn(input, deps);

    expect(result.event).toEqual({
      type: 'message',
      content: 'I could not create a safe proposal. Please try again.',
    });
  });

  it('fails closed for unsupported operations', async () => {
    const { deps, createProposal } = dependencies({
      type: 'unsupported',
      content: 'I cannot change workflow graphs from this conversation.',
    });

    const result = await orchestrateCopilotTurn(input, deps);

    expect(result.event).toEqual({
      type: 'message',
      content: 'COPILOT_OPERATION_UNSUPPORTED: I cannot change workflow graphs from this conversation.',
    });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('stops after three clarification rounds without invoking the model', async () => {
    const { deps, generator, createProposal } = dependencies({
      type: 'clarification',
      proposalKind: 'draft_agent',
      questions: [{ id: 'goal', question: 'What should it do?' }],
    }, 3);

    const result = await orchestrateCopilotTurn(input, deps);

    expect(result.event).toEqual({
      type: 'message',
      content: 'I still do not have enough information to create a safe proposal.',
    });
    expect(generator).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('passes only the bounded authoritative context to the generator', async () => {
    const generator: CopilotTurnGenerator = vi.fn(async () => ({ type: 'message', content: 'Ready.' }));
    const { deps } = dependencies({ type: 'message', content: 'unused' }, 1);
    deps.generator = generator;

    await orchestrateCopilotTurn(input, deps);

    expect(generator).toHaveBeenCalledWith({
      messages: input.messages,
      context,
      outputContent: '# Original',
      clarificationRound: 1,
    });
  });
});
