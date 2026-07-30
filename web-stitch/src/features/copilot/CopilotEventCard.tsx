import type { CopilotEvent } from '../../contracts/copilot';
import { DraftAgentProposalCard } from './DraftAgentProposalCard';
import { ExecutionReceiptCard } from './ExecutionReceiptCard';
import { RefinementProposalCard } from './RefinementProposalCard';

export function CopilotEventCard({ event, onApprove, onReject, onRegenerate, onRetry, applying = false }: {
  event: CopilotEvent;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  onRegenerate?: () => void;
  onRetry?: () => void;
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
  if (event.type === 'proposal_error') {
    return <section className="copilot-event-card proposal-error-card">
      <header><strong>Proposal unavailable</strong><span>{event.code}</span></header>
      <p>{event.message}</p>
      <small>Request ID: {event.requestId}</small>
      {event.retryable && onRetry ? <footer><button type="button" onClick={onRetry}>Try again</button></footer> : null}
    </section>;
  }
  return null;
}
