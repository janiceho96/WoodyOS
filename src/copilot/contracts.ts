import { createHash } from 'node:crypto';
import { z } from 'zod';
import { outputContentSchema } from '../outputs/types.js';
import { copilotIntentSchema } from './graph/state.js';
import type {
  CopilotGeneratedTurn,
  CopilotContextSnapshot,
  CopilotProposalStatus,
  DraftAgentPayload,
  OutputRefinementPayload,
} from './types.js';

const uuidSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const copilotProposalKindSchema = z.enum(['output_refinement', 'draft_agent']);

export const copilotContextSnapshotSchema: z.ZodType<CopilotContextSnapshot> = z.object({
  schemaVersion: z.literal(1),
  workspaceId: uuidSchema,
  actorId: uuidSchema,
  workflow: z.object({
    id: uuidSchema,
    publishedVersionId: uuidSchema.nullable(),
    draftRevision: z.number().int().min(0),
  }).strict().nullable(),
  run: z.object({
    id: uuidSchema,
    status: z.string().trim().min(1).max(80),
    workflowVersionId: uuidSchema.nullable(),
  }).strict().nullable(),
  task: z.object({
    id: uuidSchema,
    status: z.string().trim().min(1).max(80),
  }).strict(),
  output: z.object({
    documentId: uuidSchema,
    versionId: uuidSchema,
    versionNumber: z.number().int().min(1),
    contentHash: hashSchema,
  }).strict(),
  capturedAt: z.string().datetime({ offset: true }),
}).strict();

export const copilotProposalStatusSchema = z.enum([
  'ready_for_review',
  'approved',
  'applying',
  'applied',
  'rejected',
  'expired',
  'superseded',
  'failed',
]);

export const clarificationQuestionSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  question: z.string().trim().min(2).max(500),
}).strict();
export const clarificationQuestionsSchema = z.array(clarificationQuestionSchema).min(1).max(3);

export const copilotIntentClassificationSchema = z.object({
  intent: copilotIntentSchema,
}).strict();

export const clarificationSchema = z.object({
  type: z.literal('clarification'),
  proposalKind: copilotProposalKindSchema,
  questions: clarificationQuestionsSchema,
}).strict();

export const refinementCandidateSchema = z.object({
  type: z.literal('refinement_candidate'),
  proposedContent: outputContentSchema,
  changeSummary: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
}).strict();

export const normalMessageSchema = z.object({
  type: z.literal('message'),
  content: z.string().trim().min(1).max(8_000),
}).strict();

const modelConfigSchema = z.object({
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(128).max(128_000),
  topP: z.number().min(0).max(1),
}).strict();

const candidateCapabilitiesSchema = z.object({
  webBrowser: z.boolean(),
  codeInterpreter: z.boolean(),
  knowledgeBase: z.boolean(),
}).strict();

const memoryConfigSchema = z.object({
  shortTerm: z.boolean(),
  longTerm: z.boolean(),
  knowledgeBase: z.boolean(),
}).strict();

const draftAgentNormalizationCandidateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  role: z.string().trim().min(2).max(240),
  goal: z.string().trim().min(2).max(5_000),
  instructions: z.string().max(20_000),
  personality: z.string().max(80).nullable(),
  model: z.string().trim().min(2).max(160),
  modelConfig: modelConfigSchema,
  capabilities: candidateCapabilitiesSchema,
  memoryConfig: memoryConfigSchema,
  status: z.unknown().optional(),
  toolIds: z.unknown().optional(),
}).passthrough();

export const draftAgentCandidateSchema = z.object({
  type: z.literal('draft_agent_candidate'),
  candidate: z.object({
    name: z.string().trim().min(2).max(120),
    role: z.string().trim().min(2).max(240),
    goal: z.string().trim().min(2).max(5_000),
    instructions: z.string().max(20_000),
    personality: z.string().max(80).nullable(),
    model: z.string().trim().min(2).max(160),
    modelConfig: modelConfigSchema,
    capabilities: candidateCapabilitiesSchema,
    memoryConfig: memoryConfigSchema,
  }).strict(),
  dependsOnOutputVersion: z.boolean(),
}).strict();

export const draftAgentPayloadSchema = z.object({
  name: z.string().trim().min(2).max(120),
  role: z.string().trim().min(2).max(240),
  goal: z.string().trim().min(2).max(5_000),
  instructions: z.string().max(20_000),
  personality: z.string().max(80).nullable(),
  model: z.string().trim().min(2).max(160),
  modelConfig: modelConfigSchema,
  capabilities: z.object({
    webBrowser: z.literal(false),
    codeInterpreter: z.literal(false),
    knowledgeBase: z.boolean(),
  }).strict(),
  memoryConfig: memoryConfigSchema,
  status: z.literal('draft'),
  toolIds: z.tuple([]),
}).strict();

export const outputRefinementPayloadSchema = z.object({
  documentId: uuidSchema,
  baseVersionId: uuidSchema,
  baseVersionNumber: z.number().int().min(1),
  baseContentHash: hashSchema,
  proposedContent: outputContentSchema,
  proposedContentHash: hashSchema,
  changeSummary: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
}).strict();

export const copilotGeneratedTurnSchema: z.ZodType<CopilotGeneratedTurn> = z.discriminatedUnion('type', [
  clarificationSchema,
  refinementCandidateSchema,
  draftAgentCandidateSchema,
  normalMessageSchema,
  z.object({ type: z.literal('unsupported'), content: z.string().trim().min(1).max(2_000) }).strict(),
]);

const transitions: Record<CopilotProposalStatus, ReadonlySet<CopilotProposalStatus>> = {
  ready_for_review: new Set(['approved', 'rejected', 'expired', 'superseded', 'failed']),
  approved: new Set(['applying', 'expired']),
  applying: new Set(['applied', 'failed']),
  applied: new Set(),
  rejected: new Set(),
  expired: new Set(),
  superseded: new Set(),
  failed: new Set(),
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizeDraftAgentPayload(candidate: unknown): DraftAgentPayload {
  const parsed = draftAgentNormalizationCandidateSchema.parse(candidate);
  return draftAgentPayloadSchema.parse({
    name: parsed.name,
    role: parsed.role,
    goal: parsed.goal,
    instructions: parsed.instructions,
    personality: parsed.personality,
    model: parsed.model,
    modelConfig: parsed.modelConfig,
    capabilities: {
      webBrowser: false,
      codeInterpreter: false,
      knowledgeBase: parsed.capabilities.knowledgeBase,
    },
    memoryConfig: parsed.memoryConfig,
    status: 'draft',
    toolIds: [],
  });
}

export function proposalPayloadHash(payload: OutputRefinementPayload | DraftAgentPayload): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

export function assertProposalTransition(from: CopilotProposalStatus, to: CopilotProposalStatus): void {
  if (!transitions[from]?.has(to)) throw new Error('COPILOT_PROPOSAL_TRANSITION_INVALID');
}

const safeReceiptCodes = new Set([
  'COPILOT_CONTEXT_STALE',
  'COPILOT_CONTEXT_NOT_FOUND',
  'COPILOT_PROPOSAL_INVALID',
  'COPILOT_PROPOSAL_EXPIRED',
  'COPILOT_PROPOSAL_SUPERSEDED',
  'COPILOT_IDEMPOTENCY_CONFLICT',
  'OUTPUT_VERSION_CONFLICT',
  'FORBIDDEN',
]);

export function safeReceiptError(error: unknown): { errorCode: string } {
  const message = error instanceof Error ? error.message : '';
  return { errorCode: safeReceiptCodes.has(message) ? message : 'COPILOT_APPLICATION_FAILED' };
}
