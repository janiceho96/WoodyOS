import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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

function dependencies(
  turn: unknown,
  clarificationRound = 0,
  outstandingProposalKind: 'output_refinement' | 'draft_agent' | null = null,
) {
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
    loadTurnContext: vi.fn(async () => ({
      context,
      outputContent: '# Original',
      clarificationRound,
      outstandingProposalKind,
    })),
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
      proposalKind: 'draft_agent',
      questions: [
        { id: 'goal', question: 'What outcome should the Draft agent achieve?' },
        { id: 'audience', question: 'Who should the Draft agent serve?' },
      ],
    });

    const result = await orchestrateCopilotTurn({
      ...input,
      messages: [{ role: 'user', content: 'Make it better.' }],
    }, deps);

    expect(result).toMatchObject({
      contextSnapshotId,
      content: 'What outcome should the Draft agent achieve?\nWho should the Draft agent serve?',
      event: {
        type: 'clarification',
        proposalKind: 'draft_agent',
        questions: [
          { id: 'goal', question: 'What outcome should the Draft agent achieve?' },
          { id: 'audience', question: 'Who should the Draft agent serve?' },
        ],
      },
    });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it.each([
    { content: 'Please improve this output.', proposalKind: 'output_refinement' as const },
    { content: 'Create a new writing agent.', proposalKind: 'draft_agent' as const },
  ])('preserves an exact injected $proposalKind clarification on a deterministic request', async ({
    content,
    proposalKind,
  }) => {
    const questions = [
      { id: 'constraint', question: 'Which constraint should I preserve?' },
      { id: 'tone', question: 'Which tone should I use?' },
    ];
    const { deps, createProposal } = dependencies({
      type: 'clarification',
      proposalKind,
      questions,
    });

    const result = await orchestrateCopilotTurn({
      ...input,
      messages: [{ role: 'user', content }],
    }, deps);

    expect(result.event).toEqual({ type: 'clarification', proposalKind, questions });
    expect(result.content).toBe('Which constraint should I preserve?\nWhich tone should I use?');
    expect(result.proposalId).toBeUndefined();
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

    const result = await orchestrateCopilotTurn({
      ...input,
      messages: [{ role: 'user', content: 'Create a new writing agent.' }],
    }, deps);

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

    expect(result.event).toMatchObject({
      type: 'proposal_error',
      code: 'COPILOT_PROPOSAL_SCHEMA_INVALID',
      retryable: true,
    });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('fails closed when a draft candidate cannot be normalized', async () => {
    const { deps, createProposal } = dependencies({
      type: 'draft_agent_candidate',
      candidate: {
        name: 'Draft Writer',
        role: 'Writer',
        goal: 'Draft a useful response',
        instructions: 'Use the approved output.',
        personality: null,
        model: 'test-model',
        modelConfig: { temperature: 0.2, maxTokens: 1000, topP: 1 },
        capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: false },
        memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: false },
      },
      dependsOnOutputVersion: true,
    });
    createProposal.mockRejectedValueOnce(new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['candidate'],
      message: 'private repository validation detail',
    }]) as never);

    const result = await orchestrateCopilotTurn({
      ...input,
      messages: [{ role: 'user', content: 'Create a new writing agent.' }],
    }, deps);

    expect(result.event).toMatchObject({
      type: 'proposal_error',
      code: 'COPILOT_PROPOSAL_SCHEMA_INVALID',
      retryable: true,
    });
    expect(result.proposalId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private repository validation detail');
    expect(createProposal).toHaveBeenCalledTimes(1);
  });

  it('does not hide unexpected proposal repository failures', async () => {
    const { deps, createProposal } = dependencies({
      type: 'refinement_candidate',
      proposedContent: '# Improved result',
      changeSummary: ['Clarified the conclusion'],
    });
    createProposal.mockRejectedValueOnce(new Error('repository unavailable') as never);

    await expect(orchestrateCopilotTurn(input, deps)).rejects.toThrow('repository unavailable');
  });

  it('fails closed for unsupported operations', async () => {
    const { deps, createProposal } = dependencies({
      type: 'unsupported',
      content: 'I cannot change workflow graphs from this conversation.',
    });

    const result = await orchestrateCopilotTurn({
      ...input,
      messages: [{ role: 'user', content: 'Publish this agent.' }],
    }, deps);

    expect(result.event).toEqual({
      type: 'message',
      content: 'COPILOT_OPERATION_UNSUPPORTED: This operation is not supported by the Copilot graph.',
    });
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('answers a question while output context is attached', async () => {
    const { deps, createProposal } = dependencies({
      type: 'message',
      content: 'No error was found in the selected output.',
    });

    const result = await orchestrateCopilotTurn({
      ...input,
      messages: [{ role: 'user', content: 'is there any error?' }],
    }, deps);

    expect(result.event).toEqual({
      type: 'message',
      content: 'No error was found in the selected output.',
    });
    expect(result).toMatchObject({
      path: ['load_intent', 'answer_question', 'finalize_turn'],
      repairAttempted: false,
      repairSucceeded: false,
    });
    expect(result.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('resumes the persisted clarification kind without classifying free text', async () => {
    const { deps } = dependencies({
      type: 'draft_agent_candidate',
      candidate: {
        name: 'Draft Writer',
        role: 'Writer',
        goal: 'Draft a useful response',
        instructions: 'Use the approved output.',
        personality: null,
        model: 'test-model',
        modelConfig: { temperature: 0.2, maxTokens: 1000, topP: 1 },
        capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: false },
        memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: false },
      },
      dependsOnOutputVersion: true,
    }, 1, 'draft_agent');

    const result = await orchestrateCopilotTurn({
      ...input,
      messages: [{ role: 'user', content: 'Use senior executives as the audience.' }],
    }, deps);

    expect(result.event.type).toBe('agent_proposal');
    expect(result.path).toEqual([
      'load_intent',
      'compile_draft_agent',
      'validate_candidate',
      'persist_proposal',
      'finalize_turn',
    ]);
  });

  it('stops after three clarification rounds without creating a proposal', async () => {
    const { deps, generator, createProposal } = dependencies({
      type: 'clarification',
      proposalKind: 'draft_agent',
      questions: [{ id: 'goal', question: 'What should it do?' }],
    }, 3);

    const result = await orchestrateCopilotTurn({
      ...input,
      messages: [{ role: 'user', content: 'Make it better.' }],
    }, deps);

    expect(result.event).toEqual({
      type: 'message',
      content: 'I still do not have enough information to create a safe proposal.',
    });
    expect(generator).toHaveBeenCalledTimes(1);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('passes only the bounded authoritative context to the generator', async () => {
    const generated = {
      type: 'refinement_candidate' as const,
      proposedContent: '# Improved result',
      changeSummary: ['Clarified the conclusion'],
    };
    const generator: CopilotTurnGenerator = vi.fn(async () => generated);
    const { deps } = dependencies(generated, 1);
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
