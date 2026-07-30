import { z } from 'zod';
import type { WoodyChatMessage } from '../../routes/copilot.js';
import type {
  CopilotContextSnapshotRecord,
  CopilotEvent,
  CopilotProposalKind,
} from '../types.js';

export const copilotIntentSchema = z.enum([
  'answer_question',
  'refine_output',
  'create_draft_agent',
  'clarify',
  'unsupported',
]);
export type CopilotIntent = z.infer<typeof copilotIntentSchema>;

export const safeValidationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number()])).max(12),
  code: z.string().trim().min(1).max(80),
}).strict();
export type SafeValidationIssue = z.infer<typeof safeValidationIssueSchema>;

export type LoadedCopilotTurn = {
  context: CopilotContextSnapshotRecord;
  outputContent: string;
  clarificationRound: number;
  outstandingProposalKind?: CopilotProposalKind | null;
};

export type CopilotGraphInput = {
  workspaceId: string;
  actorId: string;
  threadId: string;
  messages: WoodyChatMessage[];
  loaded: LoadedCopilotTurn;
  traceId: string;
};

export type CopilotGraphState = CopilotGraphInput & {
  intent?: CopilotIntent;
  proposalKind?: CopilotProposalKind;
  answer?: string;
  candidate?: unknown;
  validationIssues: SafeValidationIssue[];
  repairCount: 0 | 1;
  proposalId?: string;
  event?: CopilotEvent;
  path: string[];
  repairAttempted: boolean;
  repairSucceeded: boolean;
};

export type CopilotGraphResult = {
  content: string;
  event: CopilotEvent;
  contextSnapshotId: string;
  proposalId?: string;
  traceId: string;
  path: string[];
  repairAttempted: boolean;
  repairSucceeded: boolean;
};
