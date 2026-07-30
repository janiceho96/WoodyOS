import {
  Annotation,
  END,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { CallbackManager } from '@langchain/core/callbacks/manager';
import { traceable } from 'langsmith/traceable';
import type { WoodyChatMessage } from '../../routes/copilot.js';
import type {
  CopilotEvent,
  CopilotProposalKind,
} from '../types.js';
import {
  answerQuestionNode,
  clarificationNode,
  classifyIntentNode,
  compileDraftAgentNode,
  compileRefinementNode,
  finalizeTurnNode,
  loadIntentNode,
  persistProposalNode,
  repairCandidateNode,
  schemaFailureNode,
  unsupportedNode,
  validateCandidateNode,
  type CopilotGraphDependencies,
} from './nodes.js';
import type {
  CopilotGraphInput,
  CopilotGraphResult,
  CopilotIntent,
  LoadedCopilotTurn,
  SafeValidationIssue,
} from './state.js';

const CopilotState = Annotation.Root({
  workspaceId: Annotation<string>,
  actorId: Annotation<string>,
  threadId: Annotation<string>,
  messages: Annotation<WoodyChatMessage[]>,
  attachmentContext: Annotation<string | undefined>,
  loaded: Annotation<LoadedCopilotTurn>,
  traceId: Annotation<string>,
  intent: Annotation<CopilotIntent | undefined>,
  proposalKind: Annotation<CopilotProposalKind | undefined>,
  answer: Annotation<string | undefined>,
  candidate: Annotation<unknown>,
  validationIssues: Annotation<SafeValidationIssue[]>({
    default: () => [],
    reducer: (_current, update) => update,
  }),
  repairCount: Annotation<0 | 1>({
    default: () => 0,
    reducer: (_current, update) => update,
  }),
  proposalId: Annotation<string | undefined>,
  event: Annotation<CopilotEvent | undefined>,
  path: Annotation<string[]>({
    default: () => [],
    reducer: (current, update) => current.concat(update),
  }),
  repairAttempted: Annotation<boolean>({
    default: () => false,
    reducer: (_current, update) => update,
  }),
  repairSucceeded: Annotation<boolean>({
    default: () => false,
    reducer: (_current, update) => update,
  }),
});

type GraphState = typeof CopilotState.State;

class LangSmithTracingDisabledHandler extends BaseCallbackHandler {
  name = 'langchain_tracer';

  constructor() {
    super({
      ignoreLLM: true,
      ignoreChain: true,
      ignoreAgent: true,
      ignoreRetriever: true,
      ignoreCustomEvent: true,
    });
  }

  copyWithTracingConfig() {
    return this;
  }

  getRunTreeWithTracingConfig() {
    return undefined;
  }
}

function routeIntent(state: GraphState) {
  if (state.event) return 'finalize_turn';
  switch (state.intent) {
    case 'answer_question':
      return 'answer_question';
    case 'refine_output':
      return 'compile_refinement';
    case 'create_draft_agent':
      return 'compile_draft_agent';
    case 'clarify':
      return 'clarification';
    case 'unsupported':
      return 'unsupported';
    default:
      return 'classify_intent';
  }
}

function routeAfterProviderCall(state: GraphState) {
  return state.event ? 'finalize_turn' : 'validate_candidate';
}

function routeAfterRepair(state: GraphState) {
  return state.event ? 'finalize_turn' : 'validate_candidate';
}

function routeAfterValidation(state: GraphState) {
  if (state.event) return 'finalize_turn';
  if (state.validationIssues.length === 0) return 'persist_proposal';
  return state.repairCount === 0 ? 'repair_candidate' : 'schema_failure';
}

function contentForEvent(event: CopilotEvent): string {
  switch (event.type) {
    case 'message':
      return event.content;
    case 'clarification':
      return event.questions.map((question) => question.question).join('\n');
    case 'refinement_preview':
      return 'Review the proposed output refinement before accepting it.';
    case 'agent_proposal':
      return 'Review the proposed Draft agent before creating it.';
    case 'proposal_error':
      return event.message;
    case 'execution_receipt':
      return 'The approved proposal has been applied.';
  }
}

export function createCopilotGraph(dependencies: CopilotGraphDependencies) {
  return new StateGraph(CopilotState)
    .addNode('load_intent', loadIntentNode())
    .addNode('classify_intent', classifyIntentNode(dependencies.model))
    .addNode('answer_question', answerQuestionNode(dependencies.model))
    .addNode('clarification', clarificationNode())
    .addNode('compile_refinement', compileRefinementNode(dependencies.model))
    .addNode('compile_draft_agent', compileDraftAgentNode(dependencies.model))
    .addNode('validate_candidate', validateCandidateNode())
    .addNode('repair_candidate', repairCandidateNode(dependencies.model))
    .addNode('persist_proposal', persistProposalNode(dependencies.createProposal))
    .addNode('unsupported', unsupportedNode())
    .addNode('schema_failure', schemaFailureNode())
    .addNode('finalize_turn', finalizeTurnNode())
    .addEdge(START, 'load_intent')
    .addConditionalEdges('load_intent', routeIntent)
    .addConditionalEdges('classify_intent', routeIntent)
    .addEdge('answer_question', 'finalize_turn')
    .addEdge('clarification', 'finalize_turn')
    .addConditionalEdges('compile_refinement', routeAfterProviderCall)
    .addConditionalEdges('compile_draft_agent', routeAfterProviderCall)
    .addConditionalEdges('validate_candidate', routeAfterValidation)
    .addConditionalEdges('repair_candidate', routeAfterRepair)
    .addEdge('persist_proposal', 'finalize_turn')
    .addEdge('unsupported', 'finalize_turn')
    .addEdge('schema_failure', 'finalize_turn')
    .addEdge('finalize_turn', END)
    .compile();
}

const invokeCopilotGraphWithoutTracing = traceable(
  async (input: CopilotGraphInput, dependencies: CopilotGraphDependencies) => {
    const callbacks = new CallbackManager();
    callbacks.addHandler(new LangSmithTracingDisabledHandler(), true);
    return createCopilotGraph(dependencies).invoke(input, { callbacks });
  },
  {
    name: 'CopilotGraphLocal',
    tracingEnabled: false,
  },
);

export async function runCopilotGraph(
  input: CopilotGraphInput,
  dependencies: CopilotGraphDependencies,
): Promise<CopilotGraphResult> {
  if (input.loaded.context.threadId !== input.threadId
    || input.loaded.context.snapshot.workspaceId !== input.workspaceId
    || input.loaded.context.snapshot.actorId !== input.actorId) {
    throw Object.assign(new Error('COPILOT_CONTEXT_NOT_FOUND'), { statusCode: 404 });
  }
  const state = await invokeCopilotGraphWithoutTracing(input, dependencies);
  if (!state.event) throw new Error('COPILOT_GRAPH_EVENT_MISSING');
  return {
    content: contentForEvent(state.event),
    event: state.event,
    contextSnapshotId: input.loaded.context.id,
    ...(state.proposalId ? { proposalId: state.proposalId } : {}),
    traceId: input.traceId,
    path: state.path,
    repairAttempted: state.repairAttempted,
    repairSucceeded: state.repairSucceeded,
  };
}
