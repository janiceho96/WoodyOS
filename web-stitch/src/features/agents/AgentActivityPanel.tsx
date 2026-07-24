import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Bot, CheckCircle2, ChevronRight, CircleAlert, Clock3, Filter, RefreshCw, Square, Wrench, X } from 'lucide-react';
import { api } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { OutputViewer } from '../../components/OutputViewer';
import { Status } from '../../components/ui';
import { duration } from '../../lib/format';
import { useAgentExecution, type ActivityFilter, type UnifiedActivityEvent } from './agentExecution';

const filterOptions: Array<{ value: ActivityFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'agent', label: 'Agent' },
  { value: 'tools', label: 'Tools' },
  { value: 'approvals', label: 'Approvals' },
  { value: 'errors', label: 'Errors' },
  { value: 'results', label: 'Results' },
];

export function AgentActivityPanel({ close }: { close: () => void }) {
  const execution = useAgentExecution();
  const queryClient = useQueryClient();
  const { report, reportError, session } = useWorkspace();
  const canApprove = !session.workspace.role || ['owner', 'admin'].includes(session.workspace.role);
  const refresh = async () => { await execution.refresh(); };
  const cancel = useMutation({
    mutationFn: () => api.cancelTask(execution.task!.id),
    onSuccess: async () => { report('Task cancelled'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); await refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not cancel task'),
  });
  const taskDecision = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) => api.decideActionAuthorization(id, decision),
    onSuccess: async (_result, variables) => { report(variables.decision === 'approved' ? 'Action approved once' : 'Action rejected'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); await refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not resolve approval'),
  });
  const workflowDecision = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) => api.decideWorkflowApproval(execution.workflowRun!.id, id, decision),
    onSuccess: async () => { report('Workflow approval resolved'); await refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not resolve workflow approval'),
  });
  const workflowActionDecision = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) => api.decideWorkflowAction(id, decision),
    onSuccess: async () => { report('Workflow action confirmation resolved'); await refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not resolve action confirmation'),
  });
  const filtered = execution.events.filter((event) => execution.activityFilter === 'all' || event.category === execution.activityFilter)
    .filter((event) => !execution.selectedStepId || execution.section !== 'workflow' || !event.stepId || event.stepId === execution.selectedStepId);
  const selectedEvent = execution.events.find((event) => event.id === execution.selectedEventId);
  const currentStep = execution.steps.find((step) => step.id === execution.currentStepId);
  const cancellable = execution.task && ['queued', 'running', 'awaiting_approval'].includes(execution.task.status);
  const deciding = taskDecision.isPending || workflowDecision.isPending || workflowActionDecision.isPending;

  return <aside className="agent-activity-panel" aria-label="Live activity">
    <header><div><span className="eyebrow">Live activity</span><h2>{execution.task ? execution.task.title : 'No active task'}</h2></div><div><button className="icon-button" onClick={() => void refresh()} aria-label="Refresh activity"><RefreshCw size={15}/></button><button className="icon-button" onClick={close} aria-label="Collapse activity"><X size={17}/></button></div></header>
    <section className="activity-summary">
      <div className="activity-status-row"><Status value={execution.status}/>{execution.status === 'running' && <span className="live-indicator"><i/>Updating</span>}</div>
      {execution.task ? <>
        <dl><div><dt>Current step</dt><dd>{currentStep?.label ?? 'Preparing'}</dd></div><div><dt>Progress</dt><dd>{execution.steps.length ? `${execution.completedSteps}/${execution.steps.length} steps` : 'Not available'}</dd></div><div><dt>Elapsed</dt><dd>{execution.elapsedMs === null ? '—' : duration(execution.elapsedMs)}</dd></div></dl>
        {execution.progressPercent !== null && <div className="activity-progress" aria-label={`${execution.progressPercent}% complete`}><span style={{ width: `${execution.progressPercent}%` }}/></div>}
        {cancellable && <button className="button danger compact" disabled={cancel.isPending} onClick={() => { if (window.confirm('Cancel this task? Work already completed will remain in the activity log, but execution cannot be resumed.')) cancel.mutate(); }}><Square size={12}/>Cancel task</button>}
      </> : <p>Select a run or start a task to see progress, tools, approvals and results here.</p>}
    </section>

    {execution.pendingApprovals > 0 && <section className="activity-attention"><div><AlertTriangle size={18}/><span><strong>Action required</strong><small>{execution.pendingApprovals} approval{execution.pendingApprovals === 1 ? '' : 's'} waiting</small></span></div>
      {execution.task?.actionAuthorizations?.filter((item) => item.status === 'awaiting_confirmation').map((item) => <ApprovalCard key={item.id} title="Confirm agent action" description={item.target_summary ?? item.operation} details={item.arguments_summary} canApprove={canApprove} deciding={deciding} decide={(decision) => taskDecision.mutate({ id: item.id, decision })}/>) }
      {execution.workflowRun?.approvals?.filter((item) => item.status === 'pending').map((item) => <ApprovalCard key={item.id} title="Business approval" description={`Workflow step: ${item.node_id}`} canApprove={canApprove} deciding={deciding} decide={(decision) => workflowDecision.mutate({ id: item.id, decision })}/>) }
      {execution.workflowRun?.actionAuthorizations?.filter((item) => item.status === 'awaiting_confirmation').map((item) => <ApprovalCard key={item.id} title="Confirm external action" description={item.target_summary ?? item.operation} details={item.arguments_summary} canApprove={canApprove} deciding={deciding} decide={(decision) => workflowActionDecision.mutate({ id: item.id, decision })}/>) }
    </section>}

    <div className="activity-filters" role="group" aria-label="Filter activity"><Filter size={14}/>{filterOptions.map((option) => <button key={option.value} className={execution.activityFilter === option.value ? 'active' : ''} onClick={() => execution.setActivityFilter(option.value)}>{option.label}{option.value === 'errors' && execution.errorCount > 0 ? <b>{execution.errorCount}</b> : null}</button>)}</div>
    <div className="activity-timeline" aria-live="polite">
      {filtered.length ? [...filtered].reverse().map((event) => <ActivityEvent key={event.id} event={event} selected={event.id === execution.selectedEventId} select={() => execution.selectEvent(event.id, event.stepId)}/>) : <div className="activity-empty"><Activity size={22}/><strong>{execution.task ? 'No matching events' : 'Activity will appear here'}</strong><p>{execution.task ? 'Choose another filter or workflow step.' : 'Start a task when you are ready.'}</p></div>}
    </div>
    {selectedEvent && <section className="activity-details"><div className="section-title"><div><span className="eyebrow">Selected event</span><h3>{selectedEvent.title}</h3></div><button className="icon-button" onClick={() => execution.selectEvent(undefined)} aria-label="Close event details"><X size={15}/></button></div><p>{selectedEvent.message}</p><dl><div><dt>Source</dt><dd>{selectedEvent.source}</dd></div><div><dt>Time</dt><dd>{new Date(selectedEvent.createdAt).toLocaleString()}</dd></div>{selectedEvent.stepId && <div><dt>Step</dt><dd>{selectedEvent.stepId}</dd></div>}</dl>{selectedEvent.payload && Object.keys(selectedEvent.payload).length > 0 && <details><summary>Technical details</summary><OutputViewer value={selectedEvent.payload}/></details>}</section>}
  </aside>;
}

function ApprovalCard({ title, description, details, canApprove, deciding, decide }: { title: string; description: string; details?: Record<string, unknown>; canApprove: boolean; deciding: boolean; decide: (decision: 'approved' | 'rejected') => void }) {
  return <article className="activity-approval-card"><strong>{title}</strong><p>{description}</p>{details && <details><summary>Review input</summary><OutputViewer value={details}/></details>}{canApprove ? <div><button className="button danger compact" disabled={deciding} onClick={() => decide('rejected')}>Reject</button><button className="button primary compact" disabled={deciding} onClick={() => decide('approved')}>Approve once</button></div> : <small>An owner or admin must approve this action.</small>}</article>;
}

function ActivityEvent({ event, selected, select }: { event: UnifiedActivityEvent; selected: boolean; select: () => void }) {
  const Icon = event.category === 'tools' ? Wrench : event.category === 'errors' ? CircleAlert : event.category === 'results' ? CheckCircle2 : event.category === 'agent' ? Bot : AlertTriangle;
  return <button className={`activity-event ${event.category} ${selected ? 'selected' : ''}`} onClick={select} aria-pressed={selected}><span className="event-icon"><Icon size={15}/></span><span><span><strong>{event.title}</strong><Status value={event.status}/></span><p>{event.message}</p><small><Clock3 size={11}/>{new Date(event.createdAt).toLocaleTimeString()} · {event.source}</small></span><ChevronRight size={14}/></button>;
}
