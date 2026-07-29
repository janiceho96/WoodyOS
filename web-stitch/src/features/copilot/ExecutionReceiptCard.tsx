import type { ExecutionReceiptView } from '../../contracts/copilot';

export function ExecutionReceiptCard({ receipt }: { receipt: ExecutionReceiptView }) {
  const agent = receipt.resource.type === 'agent';
  const href = agent
    ? `/agents/${receipt.resource.id}`
    : `/executions?outputVersion=${receipt.resource.id}`;
  return <section className={`copilot-event-card receipt-card ${receipt.status}`}>
    <header><strong>{receipt.status === 'succeeded' ? 'Change completed' : 'Change failed'}</strong><span>{receipt.operation.replaceAll('.', ' ')}</span></header>
    {receipt.status === 'succeeded' && receipt.resource.id
      ? <a href={href}>{agent ? 'Open Draft agent' : 'Open output version'}</a>
      : <p>{receipt.errorCode ?? 'COPILOT_APPLICATION_FAILED'}</p>}
    {receipt.resource.resultingVersion && <small>Created output version {receipt.resource.resultingVersion}</small>}
  </section>;
}
