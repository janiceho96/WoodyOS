import type { CopilotEvent } from '../../contracts/copilot';
import { DraftAgentProposalCard } from './DraftAgentProposalCard';
import { ExecutionReceiptCard } from './ExecutionReceiptCard';
import { RefinementProposalCard } from './RefinementProposalCard';

export function CopilotEventCard({ event, onApprove, onReject, onRegenerate, applying = false }: {
  event: CopilotEvent;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  onRegenerate?: () => void;
  applying?: boolean;
}) {
  if (event.type === 'clarification') {
    return <section className="copilot-event-card clarification-card"><strong>Before I prepare the {event.proposalKind === 'draft_agent' ? 'Draft agent' : 'refinement'}</strong><ol>{event.questions.map((question) => <li key={question.id}>{question.question}</li>)}</ol></section>;
  }
  if (event.type === 'refinement_preview') {
    return <RefinementProposalCard proposal={event.proposal} applying={applying} onApprove={() => onApprove(event.proposal.id)} onReject={() => onReject(event.proposal.id)} onRegenerate={onRegenerate}/>;
  }
  if (event.type === 'agent_proposal') {
    return <DraftAgentProposalCard proposal={event.proposal} applying={applying} onApprove={() => onApprove(event.proposal.id)} onReject={() => onReject(event.proposal.id)} onRegenerate={onRegenerate}/>;
  }
  if (event.type === 'execution_receipt') return <ExecutionReceiptCard receipt={event.receipt}/>;
  return null;
}
