import type { CopilotProposalView, DraftAgentPayload } from '../../contracts/copilot';

type Props = {
  proposal: CopilotProposalView;
  onApprove: () => void;
  onReject: () => void;
  onRegenerate?: () => void;
  applying?: boolean;
};

const yesNo = (value: boolean) => value ? 'On' : 'Off';
const statusLabel = (status: CopilotProposalView['status']) => status
  .split('_')
  .map((part) => part[0]?.toUpperCase() + part.slice(1))
  .join(' ');

export function DraftAgentProposalCard({ proposal, onApprove, onReject, onRegenerate, applying = false }: Props) {
  const payload = proposal.payload as DraftAgentPayload;
  const reviewable = proposal.status === 'ready_for_review' && !applying;
  const stale = proposal.status === 'expired' || proposal.status === 'superseded';
  return <section className={`copilot-event-card proposal-card ${proposal.status}`}>
    <header><strong>Draft agent proposal</strong><span>{statusLabel(proposal.status)}</span></header>
    <dl>
      <div><dt>Name</dt><dd>{payload.name}</dd></div>
      <div><dt>Role</dt><dd>{payload.role}</dd></div>
      <div><dt>Goal</dt><dd>{payload.goal}</dd></div>
      <div><dt>Instructions</dt><dd>{payload.instructions}</dd></div>
      <div><dt>Personality</dt><dd>{payload.personality ?? 'Not set'}</dd></div>
      <div><dt>Model</dt><dd>{payload.model}</dd></div>
      <div><dt>Model settings</dt><dd>Temperature {payload.modelConfig.temperature} · Max tokens {payload.modelConfig.maxTokens} · Top P {payload.modelConfig.topP}</dd></div>
      <div><dt>Status</dt><dd>Draft</dd></div>
      <div><dt>Tools</dt><dd>{payload.toolIds.length ? `${payload.toolIds.length} tools` : 'No tools'}</dd></div>
      <div><dt>Capabilities</dt><dd>Web browser: {yesNo(payload.capabilities.webBrowser)} · Code interpreter: {yesNo(payload.capabilities.codeInterpreter)} · Knowledge base: {yesNo(payload.capabilities.knowledgeBase)}</dd></div>
      <div><dt>Memory</dt><dd>Short term: {yesNo(payload.memoryConfig.shortTerm)} · Long term: {yesNo(payload.memoryConfig.longTerm)} · Knowledge base: {yesNo(payload.memoryConfig.knowledgeBase)}</dd></div>
    </dl>
    {stale && <div className="copilot-stale"><strong>This proposal is no longer current.</strong><button type="button" onClick={onRegenerate}>Generate a new proposal</button></div>}
    <footer>
      <button type="button" disabled={!reviewable} onClick={onReject}>Reject proposal</button>
      <button className="primary" type="button" disabled={!reviewable} onClick={onApprove}>Approve and create Draft agent</button>
    </footer>
  </section>;
}
