import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createCopilotModelAdapter, parseJsonObject, safeZodIssues } from '../src/copilot/graph/model.js';
import { runCopilotGraph } from '../src/copilot/graph/graph.js';
import type { CopilotGraphDependencies } from '../src/copilot/graph/nodes.js';
import type {
  CopilotContextSnapshotRecord,
  CopilotProposalView,
} from '../src/copilot/types.js';

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

  it('states the closed intent and complete Draft-agent contracts in provider prompts', async () => {
    const complete = vi.fn(async () => ({
      message: '{"intent":"answer_question"}',
      provider: 'test',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    }));
    const adapter = createCopilotModelAdapter(complete as never);

    await adapter.classify({ workspaceId: 'workspace', messages: [] });
    await adapter.generateProposal({ workspaceId: 'workspace', messages: [], proposalKind: 'draft_agent' });
    await adapter.repairProposal({
      workspaceId: 'workspace',
      proposalKind: 'draft_agent',
      candidate: {},
      issues: [],
    });

    const classificationPrompt = complete.mock.calls[0]?.[0]?.system ?? '';
    for (const intent of ['answer_question', 'refine_output', 'create_draft_agent', 'clarify', 'unsupported']) {
      expect(classificationPrompt).toContain(intent);
    }
    for (const prompt of [complete.mock.calls[1]?.[0]?.system ?? '', complete.mock.calls[2]?.[0]?.system ?? '']) {
      expect(prompt).toContain('draft_agent_candidate');
      expect(prompt).toContain('"name":"string (2-120)"');
      expect(prompt).toContain('"modelConfig"');
      expect(prompt).toContain('"capabilities"');
      expect(prompt).toContain('"memoryConfig"');
      expect(prompt).not.toContain('"candidate":{}');
    }
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

const workspaceId = '0c46a071-6933-4de1-a602-e5310982a947';
const actorId = '2a55d226-97a7-4de5-aa8c-258f79fdb824';
const threadId = 'f50ef45a-7488-44aa-b3e8-7b39b092ad42';
const contextSnapshotId = 'd1f58c9a-1681-4a65-8949-9ae2956945bb';
const proposalId = '6688bb45-a4f8-4261-8e71-ee8bd43dfe81';

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
      versionNumber: 7,
      contentHash: 'a'.repeat(64),
    },
    capturedAt: '2026-07-29T10:00:00.000Z',
  },
};

const refinementInput = {
  workspaceId,
  actorId,
  threadId,
  messages: [{ role: 'user' as const, content: 'Rewrite this for an executive audience.' }],
  loaded: { context, outputContent: '# Original', clarificationRound: 0 },
  traceId: 'request-task-4',
};

const questionInput = {
  ...refinementInput,
  messages: [{ role: 'user' as const, content: 'Is there any execution error?' }],
};

const ambiguousInput = {
  ...refinementInput,
  messages: [{ role: 'user' as const, content: 'Make it better.' }],
};

function proposalView(kind: 'output_refinement' | 'draft_agent'): CopilotProposalView {
  return {
    id: proposalId,
    kind,
    status: 'ready_for_review' as const,
    contextSnapshotId,
    payload: kind === 'output_refinement'
      ? {
        documentId: context.snapshot.output.documentId,
        baseVersionId: context.snapshot.output.versionId,
        baseVersionNumber: context.snapshot.output.versionNumber,
        baseContentHash: context.snapshot.output.contentHash,
        proposedContent: '# Improved',
        proposedContentHash: createHash('sha256').update('# Improved').digest('hex'),
        changeSummary: ['Clarified the result'],
      }
      : {
        name: 'Draft Writer',
        role: 'Writer',
        goal: 'Draft a useful response',
        instructions: 'Use the approved output.',
        personality: null,
        model: 'test-model',
        modelConfig: { temperature: 0.2, maxTokens: 1_000, topP: 1 },
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
  };
}

function fakeDependencies() {
  const model = {
    classify: vi.fn(async () => 'refine_output' as const),
    answer: vi.fn(async () => 'No execution error was found.'),
    generateProposal: vi.fn(async () => ({
      type: 'refinement_candidate',
      proposedContent: '# Improved',
      changeSummary: ['Clarified the result'],
    })),
    repairProposal: vi.fn(async () => ({
      type: 'refinement_candidate',
      proposedContent: '# Improved',
      changeSummary: ['Clarified the result'],
    })),
  };
  const createProposal = vi.fn(async (input: { kind: 'output_refinement' | 'draft_agent' }) =>
    proposalView(input.kind));
  return { model, createProposal } satisfies CopilotGraphDependencies;
}

function providerCallCount(dependencies: ReturnType<typeof fakeDependencies>) {
  return dependencies.model.classify.mock.calls.length
    + dependencies.model.answer.mock.calls.length
    + dependencies.model.generateProposal.mock.calls.length
    + dependencies.model.repairProposal.mock.calls.length;
}

describe('Copilot LangGraph orchestration', () => {
  it('answers a contextual question without generating a proposal', async () => {
    const deps = fakeDependencies();

    const result = await runCopilotGraph(questionInput, deps);

    expect(result.event).toEqual({ type: 'message', content: 'No execution error was found.' });
    expect(deps.model.answer).toHaveBeenCalledTimes(1);
    expect(deps.model.generateProposal).not.toHaveBeenCalled();
    expect(deps.createProposal).not.toHaveBeenCalled();
    expect(providerCallCount(deps)).toBe(1);
    expect(result.path).toEqual(['load_intent', 'answer_question', 'finalize_turn']);
  });

  it('persists a valid deterministic proposal after one generation call', async () => {
    const deps = fakeDependencies();

    const result = await runCopilotGraph(refinementInput, deps);

    expect(result.event.type).toBe('refinement_preview');
    expect(deps.model.classify).not.toHaveBeenCalled();
    expect(deps.model.generateProposal).toHaveBeenCalledTimes(1);
    expect(deps.model.repairProposal).not.toHaveBeenCalled();
    expect(deps.createProposal).toHaveBeenCalledTimes(1);
    expect(providerCallCount(deps)).toBe(1);
    expect(result.path).toEqual([
      'load_intent',
      'compile_refinement',
      'validate_candidate',
      'persist_proposal',
      'finalize_turn',
    ]);
  });

  it('repairs one invalid refinement candidate and persists the repaired proposal', async () => {
    const deps = fakeDependencies();
    deps.model.generateProposal.mockResolvedValue({
      type: 'refinement_candidate',
      proposedContent: '',
      changeSummary: [],
    });

    const result = await runCopilotGraph(refinementInput, deps);

    expect(result.event.type).toBe('refinement_preview');
    expect(deps.model.repairProposal).toHaveBeenCalledTimes(1);
    expect(deps.createProposal).toHaveBeenCalledTimes(1);
    expect(providerCallCount(deps)).toBe(2);
    expect(result.path).toEqual([
      'load_intent',
      'compile_refinement',
      'validate_candidate',
      'repair_candidate',
      'validate_candidate',
      'persist_proposal',
      'finalize_turn',
    ]);
  });

  it('fails with a typed safe event after one unsuccessful repair', async () => {
    const invalidDependencies = fakeDependencies();
    invalidDependencies.model.generateProposal.mockResolvedValue({
      type: 'refinement_candidate',
      proposedContent: '',
      changeSummary: [],
    });
    invalidDependencies.model.repairProposal.mockResolvedValue({
      type: 'refinement_candidate',
      proposedContent: '',
      changeSummary: [],
    });

    const result = await runCopilotGraph(refinementInput, invalidDependencies);

    expect(result.event).toMatchObject({
      type: 'proposal_error',
      code: 'COPILOT_PROPOSAL_SCHEMA_INVALID',
      requestId: refinementInput.traceId,
      retryable: true,
    });
    expect(invalidDependencies.model.repairProposal).toHaveBeenCalledTimes(1);
    expect(invalidDependencies.createProposal).not.toHaveBeenCalled();
    expect(providerCallCount(invalidDependencies)).toBe(2);
    expect(result.path).toEqual([
      'load_intent',
      'compile_refinement',
      'validate_candidate',
      'repair_candidate',
      'validate_candidate',
      'schema_failure',
      'finalize_turn',
    ]);
  });

  it('bounds an ambiguous invalid proposal to classification, generation, and one repair', async () => {
    const deps = fakeDependencies();
    deps.model.generateProposal.mockResolvedValue({
      type: 'refinement_candidate',
      proposedContent: '',
      changeSummary: [],
    });

    const result = await runCopilotGraph(ambiguousInput, deps);

    expect(result.event.type).toBe('refinement_preview');
    expect(deps.model.classify).toHaveBeenCalledTimes(1);
    expect(deps.model.generateProposal).toHaveBeenCalledTimes(1);
    expect(deps.model.repairProposal).toHaveBeenCalledTimes(1);
    expect(providerCallCount(deps)).toBe(3);
    expect(providerCallCount(deps)).toBeLessThan(4);
    expect(result.path).toEqual([
      'load_intent',
      'classify_intent',
      'compile_refinement',
      'validate_candidate',
      'repair_candidate',
      'validate_candidate',
      'persist_proposal',
      'finalize_turn',
    ]);
  });

  it('uses authoritative loaded output identity when persisting a refinement', async () => {
    const deps = fakeDependencies();

    await runCopilotGraph(refinementInput, deps);

    expect(deps.createProposal).toHaveBeenCalledWith({
      workspaceId,
      actorId,
      threadId,
      contextSnapshotId,
      kind: 'output_refinement',
      candidate: {
        documentId: context.snapshot.output.documentId,
        baseVersionId: context.snapshot.output.versionId,
        baseVersionNumber: 7,
        baseContentHash: context.snapshot.output.contentHash,
        proposedContent: '# Improved',
        proposedContentHash: createHash('sha256').update('# Improved').digest('hex'),
        changeSummary: ['Clarified the result'],
      },
      dependsOnOutputVersion: true,
    });
  });

  it('returns a typed safe event when ambiguous intent classification fails', async () => {
    const deps = fakeDependencies();
    deps.model.classify.mockRejectedValue(new Error('private provider failure'));

    const result = await runCopilotGraph(ambiguousInput, deps);

    expect(result.event).toEqual({
      type: 'proposal_error',
      code: 'COPILOT_INTENT_CLASSIFICATION_FAILED',
      message: 'I could not determine how to handle this request. Please try again.',
      requestId: ambiguousInput.traceId,
      retryable: true,
    });
    expect(deps.model.generateProposal).not.toHaveBeenCalled();
    expect(deps.createProposal).not.toHaveBeenCalled();
    expect(result.path).not.toContain('private provider failure');
  });

  it('terminates safely after one malformed intent classification', async () => {
    const deps = fakeDependencies();
    deps.model.classify.mockResolvedValue(undefined as never);

    const result = await runCopilotGraph(ambiguousInput, deps);

    expect(result.event).toEqual({
      type: 'proposal_error',
      code: 'COPILOT_INTENT_CLASSIFICATION_FAILED',
      message: 'I could not determine how to handle this request. Please try again.',
      requestId: ambiguousInput.traceId,
      retryable: true,
    });
    expect(deps.model.classify).toHaveBeenCalledTimes(1);
    expect(providerCallCount(deps)).toBe(1);
    expect(deps.model.generateProposal).not.toHaveBeenCalled();
    expect(deps.createProposal).not.toHaveBeenCalled();
    expect(result.path).toEqual(['load_intent', 'classify_intent', 'finalize_turn']);
  });

  it('resumes the persisted Draft-agent proposal kind after clarification', async () => {
    const deps = fakeDependencies();
    deps.model.generateProposal.mockResolvedValue({
      type: 'draft_agent_candidate',
      candidate: {
        name: 'Draft Writer',
        role: 'Writer',
        goal: 'Draft a useful response',
        instructions: 'Use the approved output.',
        personality: null,
        model: 'test-model',
        modelConfig: { temperature: 0.2, maxTokens: 1_000, topP: 1 },
        capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: false },
        memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: false },
      },
      dependsOnOutputVersion: true,
    });
    const input = {
      ...refinementInput,
      messages: [{ role: 'user' as const, content: 'Use senior executives as the audience.' }],
      loaded: {
        ...refinementInput.loaded,
        outstandingProposalKind: 'draft_agent' as const,
      },
    };

    const result = await runCopilotGraph(input, deps);

    expect(result.event.type).toBe('agent_proposal');
    expect(deps.model.classify).not.toHaveBeenCalled();
    expect(deps.model.generateProposal).toHaveBeenCalledWith(expect.objectContaining({
      proposalKind: 'draft_agent',
    }));
  });

  it('persists a valid Draft-agent candidate without enabling unsupported safety fields', async () => {
    const deps = fakeDependencies();
    deps.model.generateProposal.mockResolvedValue({
      type: 'draft_agent_candidate',
      candidate: {
        name: 'Draft Writer',
        role: 'Writer',
        goal: 'Draft a useful response',
        instructions: 'Use the approved output.',
        personality: null,
        model: 'test-model',
        modelConfig: { temperature: 0.2, maxTokens: 1_000, topP: 1 },
        capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: false },
        memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: false },
      },
      dependsOnOutputVersion: true,
    });
    const input = {
      ...refinementInput,
      messages: [{ role: 'user' as const, content: 'Create a new research agent.' }],
    };

    const result = await runCopilotGraph(input, deps);

    expect(result.event.type).toBe('agent_proposal');
    expect(deps.model.classify).not.toHaveBeenCalled();
    expect(deps.model.generateProposal).toHaveBeenCalledTimes(1);
    expect(deps.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      contextSnapshotId,
      kind: 'draft_agent',
      candidate: {
        name: 'Draft Writer',
        role: 'Writer',
        goal: 'Draft a useful response',
        instructions: 'Use the approved output.',
        personality: null,
        model: 'test-model',
        modelConfig: { temperature: 0.2, maxTokens: 1_000, topP: 1 },
        capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: false },
        memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: false },
      },
      dependsOnOutputVersion: true,
    }));
    expect(providerCallCount(deps)).toBe(1);
  });

  it('ends unsupported deterministic requests without a provider or persistence call', async () => {
    const deps = fakeDependencies();
    const input = {
      ...refinementInput,
      messages: [{ role: 'user' as const, content: 'Publish this agent.' }],
    };

    const result = await runCopilotGraph(input, deps);

    expect(result.event).toEqual({
      type: 'message',
      content: 'COPILOT_OPERATION_UNSUPPORTED: This operation is not supported by the Copilot graph.',
    });
    expect(providerCallCount(deps)).toBe(0);
    expect(deps.createProposal).not.toHaveBeenCalled();
    expect(result.path).toEqual(['load_intent', 'unsupported', 'finalize_turn']);
  });

  it('returns a bounded clarification without creating a proposal', async () => {
    const deps = fakeDependencies();
    deps.model.classify.mockResolvedValue('clarify');

    const result = await runCopilotGraph(ambiguousInput, deps);

    expect(result.event).toEqual({
      type: 'clarification',
      proposalKind: 'output_refinement',
      questions: [{
        id: 'desiredOutcome',
        question: 'What outcome should the refinement achieve?',
      }],
    });
    expect(providerCallCount(deps)).toBe(1);
    expect(deps.createProposal).not.toHaveBeenCalled();
  });

  it('returns a typed safe event when proposal generation fails', async () => {
    const deps = fakeDependencies();
    deps.model.generateProposal.mockRejectedValue(new Error('private generation failure'));

    const result = await runCopilotGraph(refinementInput, deps);

    expect(result.event).toEqual({
      type: 'proposal_error',
      code: 'COPILOT_PROVIDER_FAILED',
      message: 'I could not complete this request with the configured model. Please try again.',
      requestId: refinementInput.traceId,
      retryable: true,
    });
    expect(providerCallCount(deps)).toBe(1);
    expect(deps.model.repairProposal).not.toHaveBeenCalled();
    expect(deps.createProposal).not.toHaveBeenCalled();
    expect(result.path).not.toContain('private generation failure');
  });

  it('rejects a loaded context from another turn identity before any side effect', async () => {
    const deps = fakeDependencies();
    const mismatchedInput = {
      ...refinementInput,
      loaded: {
        ...refinementInput.loaded,
        context: {
          ...context,
          threadId: '8f1f167c-a623-4137-ad38-82662335095e',
        },
      },
    };

    await expect(runCopilotGraph(mismatchedInput, deps)).rejects.toMatchObject({
      message: 'COPILOT_CONTEXT_NOT_FOUND',
      statusCode: 404,
    });
    expect(providerCallCount(deps)).toBe(0);
    expect(deps.createProposal).not.toHaveBeenCalled();
  });
});
