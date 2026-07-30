import { z } from 'zod';
import { createOutputContentHash } from '../../outputs/types.js';
import {
  clarificationQuestionsSchema,
  draftAgentCandidateSchema,
  refinementCandidateSchema,
} from '../contracts.js';
import { createCopilotProposal } from '../repository.js';
import type {
  ClarificationQuestion,
  CopilotEvent,
  CopilotProposalKind,
} from '../types.js';
import { detectDeterministicIntent } from './intent.js';
import {
  safeZodIssues,
  type CopilotModelAdapter,
  type ModelTurnInput,
} from './model.js';
import type {
  CopilotGraphState,
  SafeValidationIssue,
} from './state.js';

export type CopilotGraphDependencies = {
  model: CopilotModelAdapter;
  createProposal: typeof createCopilotProposal;
};

type CopilotNodeUpdate = Partial<CopilotGraphState>;
type CopilotNode = (state: CopilotGraphState) => Promise<CopilotNodeUpdate> | CopilotNodeUpdate;
type ProposalErrorCode = Extract<CopilotEvent, { type: 'proposal_error' }>['code'];

const providerFailureMessage = 'I could not complete this request with the configured model. Please try again.';
const schemaFailureMessage = 'I could not create a safe proposal. Please try again.';

function proposalError(
  state: CopilotGraphState,
  code: ProposalErrorCode,
  message: string,
): CopilotEvent {
  return {
    type: 'proposal_error',
    code,
    message,
    requestId: state.traceId,
    retryable: true,
  };
}

function proposalKindForIntent(intent: CopilotGraphState['intent']): CopilotProposalKind | undefined {
  if (intent === 'refine_output') return 'output_refinement';
  if (intent === 'create_draft_agent') return 'draft_agent';
  return undefined;
}

function boundedModelInput(state: CopilotGraphState): ModelTurnInput {
  const snapshot = state.loaded.context.snapshot;
  return {
    workspaceId: state.workspaceId,
    messages: state.messages,
    context: {
      snapshotId: state.loaded.context.id,
      workflow: snapshot.workflow,
      run: snapshot.run,
      task: snapshot.task,
      output: snapshot.output,
      clarificationRound: state.loaded.clarificationRound,
    },
    outputContent: state.loaded.outputContent,
  };
}

function invalidCandidateUpdate(error: z.ZodError<unknown>): CopilotNodeUpdate {
  return {
    validationIssues: safeZodIssues(error),
    path: ['validate_candidate'],
  };
}

function candidateIssues(
  proposalKind: CopilotProposalKind | undefined,
  candidate: unknown,
): { success: true; candidate: unknown } | { success: false; issues: SafeValidationIssue[] } {
  if (!proposalKind) {
    return {
      success: false,
      issues: [{ path: ['proposalKind'], code: 'invalid_type' }],
    };
  }
  const parsed = proposalKind === 'output_refinement'
    ? refinementCandidateSchema.safeParse(candidate)
    : draftAgentCandidateSchema.safeParse(candidate);
  if (!parsed.success) return { success: false, issues: safeZodIssues(parsed.error) };
  return { success: true, candidate: parsed.data };
}

export function loadIntentNode(): CopilotNode {
  return (state) => {
    const decision = detectDeterministicIntent(
      state.messages,
      state.loaded.outstandingProposalKind ?? null,
    );
    return {
      ...(decision.intent ? { intent: decision.intent } : {}),
      ...(decision.proposalKind ? { proposalKind: decision.proposalKind } : {}),
      path: ['load_intent'],
    };
  };
}

export function classifyIntentNode(
  model: CopilotModelAdapter,
): CopilotNode {
  return async (state) => {
    try {
      const intent = await model.classify(boundedModelInput(state));
      const proposalKind = proposalKindForIntent(intent);
      return {
        intent,
        ...(proposalKind ? { proposalKind } : {}),
        path: ['classify_intent'],
      };
    } catch {
      return {
        event: proposalError(
          state,
          'COPILOT_INTENT_CLASSIFICATION_FAILED',
          'I could not determine how to handle this request. Please try again.',
        ),
        path: ['classify_intent'],
      };
    }
  };
}

export function answerQuestionNode(
  model: CopilotModelAdapter,
): CopilotNode {
  return async (state) => {
    try {
      const content = await model.answer(boundedModelInput(state));
      return {
        answer: content,
        event: { type: 'message', content },
        path: ['answer_question'],
      };
    } catch {
      return {
        event: proposalError(state, 'COPILOT_PROVIDER_FAILED', providerFailureMessage),
        path: ['answer_question'],
      };
    }
  };
}

export function clarificationNode(): CopilotNode {
  return (state) => {
    if (state.loaded.clarificationRound >= 3) {
      const content = 'I still do not have enough information to create a safe proposal.';
      return {
        event: { type: 'message', content },
        path: ['clarification'],
      };
    }
    const proposalKind = state.proposalKind ?? 'output_refinement';
    const questions: ClarificationQuestion[] = clarificationQuestionsSchema.parse([
      {
        id: 'desiredOutcome',
        question: proposalKind === 'draft_agent'
          ? 'What outcome should the Draft agent achieve?'
          : 'What outcome should the refinement achieve?',
      },
    ]);
    return {
      proposalKind,
      event: { type: 'clarification', proposalKind, questions },
      path: ['clarification'],
    };
  };
}

export function compileRefinementNode(
  model: CopilotModelAdapter,
): CopilotNode {
  return async (state) => {
    try {
      const candidate = await model.generateProposal({
        ...boundedModelInput(state),
        proposalKind: 'output_refinement',
      });
      return {
        proposalKind: 'output_refinement',
        candidate,
        validationIssues: [],
        path: ['compile_refinement'],
      };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return {
          proposalKind: 'output_refinement',
          candidate: null,
          validationIssues: [],
          path: ['compile_refinement'],
        };
      }
      return {
        event: proposalError(state, 'COPILOT_PROVIDER_FAILED', providerFailureMessage),
        path: ['compile_refinement'],
      };
    }
  };
}

export function compileDraftAgentNode(
  model: CopilotModelAdapter,
): CopilotNode {
  return async (state) => {
    try {
      const candidate = await model.generateProposal({
        ...boundedModelInput(state),
        proposalKind: 'draft_agent',
      });
      return {
        proposalKind: 'draft_agent',
        candidate,
        validationIssues: [],
        path: ['compile_draft_agent'],
      };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return {
          proposalKind: 'draft_agent',
          candidate: null,
          validationIssues: [],
          path: ['compile_draft_agent'],
        };
      }
      return {
        event: proposalError(state, 'COPILOT_PROVIDER_FAILED', providerFailureMessage),
        path: ['compile_draft_agent'],
      };
    }
  };
}

export function validateCandidateNode(): CopilotNode {
  return (state) => {
    const parsed = candidateIssues(state.proposalKind, state.candidate);
    if (!parsed.success) {
      return {
        validationIssues: parsed.issues,
        path: ['validate_candidate'],
      };
    }
    return {
      candidate: parsed.candidate,
      validationIssues: [],
      path: ['validate_candidate'],
    };
  };
}

export function repairCandidateNode(
  model: CopilotModelAdapter,
): CopilotNode {
  return async (state) => {
    if (state.repairCount >= 1) {
      return {
        repairAttempted: state.repairAttempted,
        path: ['repair_candidate'],
      };
    }
    if (!state.proposalKind) {
      return {
        repairCount: 1,
        repairAttempted: false,
        path: ['repair_candidate'],
      };
    }
    try {
      const candidate = await model.repairProposal({
        workspaceId: state.workspaceId,
        proposalKind: state.proposalKind,
        candidate: state.candidate,
        issues: state.validationIssues,
      });
      return {
        candidate,
        validationIssues: [],
        repairCount: 1,
        repairAttempted: true,
        path: ['repair_candidate'],
      };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        return {
          candidate: null,
          validationIssues: [],
          repairCount: 1,
          repairAttempted: true,
          path: ['repair_candidate'],
        };
      }
      return {
        repairCount: 1,
        repairAttempted: true,
        event: proposalError(state, 'COPILOT_PROVIDER_FAILED', providerFailureMessage),
        path: ['repair_candidate'],
      };
    }
  };
}

export function persistProposalNode(
  createProposal: typeof createCopilotProposal,
): CopilotNode {
  return async (state) => {
    if (state.proposalKind === 'output_refinement') {
      const parsed = refinementCandidateSchema.safeParse(state.candidate);
      if (!parsed.success) {
        return invalidCandidateUpdate(parsed.error);
      }
      const output = state.loaded.context.snapshot.output;
      const proposal = await createProposal({
        workspaceId: state.workspaceId,
        actorId: state.actorId,
        threadId: state.threadId,
        contextSnapshotId: state.loaded.context.id,
        kind: 'output_refinement',
        candidate: {
          documentId: output.documentId,
          baseVersionId: output.versionId,
          baseVersionNumber: output.versionNumber,
          baseContentHash: output.contentHash,
          proposedContent: parsed.data.proposedContent,
          proposedContentHash: createOutputContentHash(parsed.data.proposedContent),
          changeSummary: parsed.data.changeSummary,
        },
        dependsOnOutputVersion: true,
      });
      return {
        proposalId: proposal.id,
        event: { type: 'refinement_preview', proposal },
        repairSucceeded: state.repairAttempted,
        path: ['persist_proposal'],
      };
    }

    const parsed = draftAgentCandidateSchema.safeParse(state.candidate);
    if (!parsed.success) {
      return invalidCandidateUpdate(parsed.error);
    }
    const proposal = await createProposal({
      workspaceId: state.workspaceId,
      actorId: state.actorId,
      threadId: state.threadId,
      contextSnapshotId: state.loaded.context.id,
      kind: 'draft_agent',
      candidate: parsed.data.candidate,
      dependsOnOutputVersion: parsed.data.dependsOnOutputVersion,
    });
    return {
      proposalId: proposal.id,
      event: { type: 'agent_proposal', proposal },
      repairSucceeded: state.repairAttempted,
      path: ['persist_proposal'],
    };
  };
}

export function unsupportedNode(): CopilotNode {
  return () => {
    const content = 'COPILOT_OPERATION_UNSUPPORTED: This operation is not supported by the Copilot graph.';
    return {
      event: { type: 'message', content },
      path: ['unsupported'],
    };
  };
}

export function schemaFailureNode(): CopilotNode {
  return (state) => ({
    event: proposalError(state, 'COPILOT_PROPOSAL_SCHEMA_INVALID', schemaFailureMessage),
    repairSucceeded: false,
    path: ['schema_failure'],
  });
}

export function finalizeTurnNode(): CopilotNode {
  return (state) => ({
    ...(!state.event
      ? { event: proposalError(state, 'COPILOT_PROVIDER_FAILED', providerFailureMessage) }
      : {}),
    path: ['finalize_turn'],
  });
}
