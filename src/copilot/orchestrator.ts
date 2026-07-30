import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import type { WoodyChatMessage } from '../routes/copilot.js';
import { copilotGeneratedTurnSchema, copilotProposalKindSchema } from './contracts.js';
import { runCopilotGraph } from './graph/graph.js';
import {
  createCopilotModelAdapter,
  type CopilotModelAdapter,
} from './graph/model.js';
import type {
  CopilotGraphResult,
  LoadedCopilotTurn,
} from './graph/state.js';
import { createCopilotProposal } from './repository.js';
import type {
  CopilotContextSnapshot,
  CopilotContextSnapshotRecord,
  CopilotGeneratedTurn,
} from './types.js';

export type CopilotTurnGenerator = (input: {
  messages: WoodyChatMessage[];
  context: CopilotContextSnapshotRecord;
  outputContent: string;
  clarificationRound: number;
}) => Promise<CopilotGeneratedTurn>;

export type CopilotOrchestratorDependencies = {
  loadTurnContext: (input: {
    workspaceId: string;
    actorId: string;
    threadId: string;
  }) => Promise<LoadedCopilotTurn>;
  createProposal: typeof createCopilotProposal;
  model?: CopilotModelAdapter;
  generator?: CopilotTurnGenerator;
};

type ContextRow = {
  id: string;
  thread_id: string;
  snapshot: CopilotContextSnapshot;
  captured_at: Date | string;
  content: string;
  clarification_round: number;
  outstanding_proposal_kind: string | null;
};

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function loadCopilotTurnContext(input: {
  workspaceId: string;
  actorId: string;
  threadId: string;
}): Promise<LoadedCopilotTurn> {
  const row = (await db.query<ContextRow>(
    `SELECT snapshot.id,snapshot.thread_id,snapshot.snapshot,snapshot.captured_at,version.content,
            (SELECT count(*)::integer
               FROM chat_messages message
              WHERE message.thread_id=snapshot.thread_id
                AND message.workspace_id=snapshot.workspace_id
                AND message.context_snapshot_id=snapshot.id
                AND message.metadata->'event'->>'type'='clarification') clarification_round,
            (SELECT CASE
                      WHEN message.metadata->'event'->>'type'='clarification'
                        THEN message.metadata->'event'->>'proposalKind'
                      ELSE NULL
                    END
               FROM chat_messages message
              WHERE message.thread_id=snapshot.thread_id
                AND message.workspace_id=snapshot.workspace_id
                AND message.context_snapshot_id=snapshot.id
                AND message.role='assistant'
                AND message.metadata->'event'->>'type' IS DISTINCT FROM 'proposal_error'
              ORDER BY message.created_at DESC,message.id DESC
              LIMIT 1) outstanding_proposal_kind
       FROM copilot_context_snapshots snapshot
       JOIN output_document_versions version
         ON version.id=snapshot.output_version_id AND version.workspace_id=snapshot.workspace_id
      WHERE snapshot.thread_id=$1 AND snapshot.workspace_id=$2 AND snapshot.actor_id=$3
      ORDER BY snapshot.captured_at DESC,snapshot.id DESC LIMIT 1`,
    [input.threadId, input.workspaceId, input.actorId],
  )).rows[0];
  if (!row) throw Object.assign(new Error('COPILOT_CONTEXT_NOT_FOUND'), { statusCode: 404 });
  return {
    context: {
      id: row.id,
      threadId: row.thread_id,
      snapshot: row.snapshot,
      createdAt: iso(row.captured_at),
    },
    outputContent: row.content,
    clarificationRound: Number(row.clarification_round),
    outstandingProposalKind: copilotProposalKindSchema.nullable().parse(row.outstanding_proposal_kind),
  };
}

function intentForGeneratedTurn(turn: CopilotGeneratedTurn) {
  switch (turn.type) {
    case 'message':
      return 'answer_question' as const;
    case 'clarification':
      return 'clarify' as const;
    case 'refinement_candidate':
      return 'refine_output' as const;
    case 'draft_agent_candidate':
      return 'create_draft_agent' as const;
    case 'unsupported':
      return 'unsupported' as const;
  }
}

function generatorModelAdapter(
  generator: CopilotTurnGenerator,
  loaded: LoadedCopilotTurn,
  messages: WoodyChatMessage[],
): CopilotModelAdapter {
  let classifiedTurn: CopilotGeneratedTurn | undefined;
  const generate = async (messages: WoodyChatMessage[]) => copilotGeneratedTurnSchema.parse(
    await generator({
      messages,
      context: loaded.context,
      outputContent: loaded.outputContent,
      clarificationRound: loaded.clarificationRound,
    }),
  );
  const next = async (messages: WoodyChatMessage[]) => {
    if (classifiedTurn) {
      const turn = classifiedTurn;
      classifiedTurn = undefined;
      return turn;
    }
    return generate(messages);
  };
  return {
    async classify(input) {
      classifiedTurn = await generate(input.messages);
      return classifiedTurn.type === 'clarification'
        ? classifiedTurn
        : intentForGeneratedTurn(classifiedTurn);
    },
    async answer(input) {
      const turn = await next(input.messages);
      if (turn.type !== 'message') throw new SyntaxError('Expected a message turn');
      return turn.content;
    },
    async generateProposal(input) {
      return next(input.messages);
    },
    async repairProposal() {
      return generate(messages);
    },
  };
}

const defaultDependencies: CopilotOrchestratorDependencies = {
  loadTurnContext: loadCopilotTurnContext,
  createProposal: createCopilotProposal,
  model: createCopilotModelAdapter(),
};

export async function orchestrateCopilotTurn(
  input: {
    workspaceId: string;
    actorId: string;
    threadId: string;
    messages: WoodyChatMessage[];
    attachmentContext?: string;
    generator?: CopilotTurnGenerator;
  },
  dependencies: CopilotOrchestratorDependencies = defaultDependencies,
): Promise<CopilotGraphResult> {
  const loaded = await dependencies.loadTurnContext(input);
  const generator = input.generator ?? dependencies.generator;
  const model = generator
    ? generatorModelAdapter(generator, loaded, input.messages)
    : dependencies.model ?? createCopilotModelAdapter();
  return runCopilotGraph({
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    threadId: input.threadId,
    messages: input.messages,
    ...(input.attachmentContext ? { attachmentContext: input.attachmentContext } : {}),
    loaded,
    traceId: randomUUID(),
  }, {
    model,
    createProposal: dependencies.createProposal,
  });
}
