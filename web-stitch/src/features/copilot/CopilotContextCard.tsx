import type { CopilotContextView } from '../../contracts/copilot';

export function CopilotContextCard({ context, currentOutputVersionId }: {
  context: CopilotContextView;
  currentOutputVersionId?: string;
}) {
  const fresh = !currentOutputVersionId || currentOutputVersionId === context.output.versionId;
  return <section className={`copilot-context-card ${fresh ? 'fresh' : 'stale'}`}>
    <header><strong>Selected output</strong><span>{fresh ? 'Current output context' : 'Output changed — generate a new proposal'}</span></header>
    <dl>
      <div><dt>Workflow</dt><dd>{context.workflow?.id ?? 'Unavailable'}</dd></div>
      <div><dt>Run</dt><dd>{context.run ? `${context.run.id} · ${context.run.status}` : 'Unavailable'}</dd></div>
      <div><dt>Task</dt><dd>{context.task.id} · {context.task.status}</dd></div>
      <div><dt>Output</dt><dd>Version {context.output.versionNumber}</dd></div>
    </dl>
  </section>;
}
