import type { WoodyChatMessage } from '../../routes/copilot.js';
import type { CopilotProposalKind } from '../types.js';
import type { CopilotIntent } from './state.js';

type IntentDecision = {
  intent?: CopilotIntent;
  confidence: 'deterministic' | 'ambiguous';
  proposalKind?: CopilotProposalKind;
};

const unsupported = /\b(publish|activate|departments?|connect\s+(?:to\s+)?(?:the\s+)?(?:gmail|mcp|api)|grant\s+(?:(?:gmail|mcp|api)\s+)?(?:access|permission)|give\s+(?:gmail|mcp|api)\s+(?:access|permission)|workflow\s+graph)\b/i;
const draftAgent = /\b(create|add|build|request|generate)\b[\s\S]{0,60}\bagent\b/i;
const refinement = /\b(rewrite|refine|improve|shorten|expand|edit|revise|rephrase|summari[sz]e)\b/i;
const question = /(^|\s)(what|why|how|is|are|does|do|can|could|where|when|which|who)\b|\?$/i;

export function detectDeterministicIntent(
  messages: WoodyChatMessage[],
  outstandingProposalKind: CopilotProposalKind | null,
): IntentDecision {
  const content = messages.at(-1)?.content.trim() ?? '';
  if (unsupported.test(content)) return { intent: 'unsupported', confidence: 'deterministic' };
  if (outstandingProposalKind) {
    return {
      intent: outstandingProposalKind === 'output_refinement'
        ? 'refine_output'
        : 'create_draft_agent',
      proposalKind: outstandingProposalKind,
      confidence: 'deterministic',
    };
  }
  if (draftAgent.test(content)) return { intent: 'create_draft_agent', proposalKind: 'draft_agent', confidence: 'deterministic' };
  if (refinement.test(content)) return { intent: 'refine_output', proposalKind: 'output_refinement', confidence: 'deterministic' };
  if (question.test(content)) return { intent: 'answer_question', confidence: 'deterministic' };
  return { confidence: 'ambiguous' };
}
