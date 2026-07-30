import { describe, expect, it } from 'vitest';
import {
  assertProposalTransition,
  clarificationSchema,
  clarificationQuestionsSchema,
  copilotIntentClassificationSchema,
  copilotGeneratedTurnSchema,
  draftAgentCandidateSchema,
  normalMessageSchema,
  refinementCandidateSchema,
  normalizeDraftAgentPayload,
  outputRefinementPayloadSchema,
  proposalPayloadHash,
  safeReceiptError,
} from '../src/copilot/contracts.js';

const draftCandidate = {
  name: 'Result Refiner',
  role: 'Editorial reviewer',
  goal: 'Improve completed answers without changing their meaning.',
  instructions: 'Preserve evidence and make the answer clearer.',
  personality: 'calm',
  model: 'test-model',
  modelConfig: { temperature: 0.2, maxTokens: 4096, topP: 1 },
  capabilities: { webBrowser: true, codeInterpreter: true, knowledgeBase: true },
  memoryConfig: { shortTerm: true, longTerm: false, knowledgeBase: true },
  status: 'active',
  toolIds: ['0c46a071-6933-4de1-a602-e5310982a947'],
};

describe('Copilot contracts', () => {
  it('forces every generated agent into the safe Draft boundary', () => {
    expect(normalizeDraftAgentPayload(draftCandidate)).toEqual({
      ...draftCandidate,
      status: 'draft',
      toolIds: [],
      capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: true },
    });
  });

  it('rejects incomplete agent candidates instead of filling consequential fields', () => {
    expect(() => normalizeDraftAgentPayload({ name: 'Only a name' })).toThrow();
  });

  it('permits only documented proposal transitions', () => {
    expect(() => assertProposalTransition('ready_for_review', 'approved')).not.toThrow();
    expect(() => assertProposalTransition('approved', 'applying')).not.toThrow();
    expect(() => assertProposalTransition('applying', 'applied')).not.toThrow();
    expect(() => assertProposalTransition('applied', 'approved')).toThrow('COPILOT_PROPOSAL_TRANSITION_INVALID');
  });

  it('hashes equivalent payloads identically regardless of key order', () => {
    const left = { documentId: 'doc', proposedContent: '# Refined', changeSummary: ['Clearer'] };
    const right = { changeSummary: ['Clearer'], proposedContent: '# Refined', documentId: 'doc' };
    expect(proposalPayloadHash(left as never)).toBe(proposalPayloadHash(right as never));
    expect(proposalPayloadHash(left as never)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('bounds clarification questions to one through three', () => {
    expect(clarificationQuestionsSchema.safeParse([]).success).toBe(false);
    expect(clarificationQuestionsSchema.safeParse([{ id: 'goal', question: 'What should improve?' }]).success).toBe(true);
    expect(clarificationQuestionsSchema.safeParse([
      { id: 'a', question: 'A?' },
      { id: 'b', question: 'B?' },
      { id: 'c', question: 'C?' },
      { id: 'd', question: 'D?' },
    ]).success).toBe(false);
  });

  it('validates bounded refinement content and generated turns', () => {
    const valid = {
      documentId: '0c46a071-6933-4de1-a602-e5310982a947',
      baseVersionId: '2a55d226-97a7-4de5-aa8c-258f79fdb824',
      baseVersionNumber: 1,
      baseContentHash: 'a'.repeat(64),
      proposedContent: '# Refined',
      proposedContentHash: 'b'.repeat(64),
      changeSummary: ['Clearer conclusion'],
    };
    expect(outputRefinementPayloadSchema.safeParse(valid).success).toBe(true);
    expect(outputRefinementPayloadSchema.safeParse({ ...valid, proposedContent: ' '.repeat(3) }).success).toBe(false);
    expect(copilotGeneratedTurnSchema.safeParse({
      type: 'clarification',
      proposalKind: 'output_refinement',
      questions: [{ id: 'goal', question: 'What should improve?' }],
    }).success).toBe(true);
    expect(copilotGeneratedTurnSchema.safeParse({ type: 'publish_workflow' }).success).toBe(false);
  });

  it('keeps generated intent and refinement contracts strict and free of immutable output fields', () => {
    expect(copilotIntentClassificationSchema.safeParse({ intent: 'answer_question' }).success).toBe(true);
    expect(copilotIntentClassificationSchema.safeParse({ intent: 'publish_agent' }).success).toBe(false);
    expect(refinementCandidateSchema.safeParse({
      type: 'refinement_candidate',
      proposedContent: '# Refined',
      changeSummary: ['Clearer conclusion'],
    }).success).toBe(true);
    expect(refinementCandidateSchema.safeParse({
      type: 'refinement_candidate',
      proposedContent: '# Refined',
      changeSummary: ['Clearer conclusion'],
      documentId: 'application-owned',
    }).success).toBe(false);
  });

  it('exports strict generated-turn schemas for every model response shape', () => {
    expect(clarificationSchema.safeParse({
      type: 'clarification',
      proposalKind: 'draft_agent',
      questions: [{ id: 'goal', question: 'What should this agent do?' }],
      outputContent: 'application-owned context',
    }).success).toBe(false);
    expect(draftAgentCandidateSchema.safeParse({
      type: 'draft_agent_candidate',
      candidate: { name: 'Researcher' },
      dependsOnOutputVersion: false,
      status: 'draft',
    }).success).toBe(false);
    expect(normalMessageSchema.safeParse({
      type: 'message',
      content: 'Here is the requested explanation.',
      proposal: {},
    }).success).toBe(false);
  });

  it('reduces failures to stable safe receipt codes', () => {
    expect(safeReceiptError(Object.assign(new Error('COPILOT_CONTEXT_STALE'), { statusCode: 409 }))).toEqual({
      errorCode: 'COPILOT_CONTEXT_STALE',
    });
    expect(safeReceiptError(new Error('database password secret-value'))).toEqual({
      errorCode: 'COPILOT_APPLICATION_FAILED',
    });
  });
});
