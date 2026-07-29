import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CopilotProposalView, OutputRefinementPayload } from '../../contracts/copilot';

type Props = {
  proposal: CopilotProposalView;
  onApprove: () => void;
  onReject: () => void;
  onRegenerate?: () => void;
  applying?: boolean;
};

const statusLabel = (status: CopilotProposalView['status']) => status
  .split('_')
  .map((part) => part[0]?.toUpperCase() + part.slice(1))
  .join(' ');

export function RefinementProposalCard({ proposal, onApprove, onReject, onRegenerate, applying = false }: Props) {
  const payload = proposal.payload as OutputRefinementPayload;
  const reviewable = proposal.status === 'ready_for_review' && !applying;
  const stale = proposal.status === 'expired' || proposal.status === 'superseded';
  return <section className={`copilot-event-card proposal-card ${proposal.status}`}>
    <header><strong>Output refinement preview</strong><span>{statusLabel(proposal.status)}</span></header>
    <p>Proposed new version based on version {payload.baseVersionNumber}</p>
    <ul>{payload.changeSummary.map((change) => <li key={change}>{change}</li>)}</ul>
    <article className="copilot-proposed-output">
      <pre>{payload.proposedContent}</pre>
      <div className="copilot-proposed-rendered"><ReactMarkdown remarkPlugins={[remarkGfm]}>{payload.proposedContent}</ReactMarkdown></div>
    </article>
    {stale && <div className="copilot-stale"><strong>This proposal is no longer current.</strong><button type="button" onClick={onRegenerate}>Generate a new proposal</button></div>}
    <footer>
      <button type="button" disabled={!reviewable} onClick={onReject}>Reject proposal</button>
      <button className="primary" type="button" disabled={!reviewable} onClick={onApprove}>Accept as new output version</button>
    </footer>
  </section>;
}
