import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowRight, Bot, Brain, CheckCircle2, ChevronRight, CircleAlert, Clock3, FileOutput, History, LoaderCircle, PanelRightOpen, Pencil, Play, Plus, RotateCcw, Settings2, Sparkles, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, isApiTool, type Task } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import { AttachmentChip } from '../../components/files/AttachmentChip';
import { FilePreviewDialog } from '../../components/files/FilePreviewDialog';
import { OutputViewer } from '../../components/OutputViewer';
import { EditableOutput } from '../../components/outputs/EditableOutput';
import { EmptyState, Status } from '../../components/ui';
import { compact, duration, humanize, relative, taskCost } from '../../lib/format';
import { thinkingOrbStateForContext } from '../../lib/thinkingOrb';
import { ArtifactPanel, TaskDialogBody } from '../execution/ExecutionPage';
import { AgentActivityPanel } from './AgentActivityPanel';
import { AgentExecutionProvider, useAgentExecution } from './agentExecution';
import { mcpAccessForAgent } from '../mcp/agentMcpAccess';

export function AgentWorkspacePage() {
  const { agentId } = useParams();
  const { data, loading } = useWorkspace();
  const navigate = useNavigate();
  const agent = data.agents.find((candidate) => candidate.id === agentId);
  if (!agent && loading) return <div className="agent-workspace-loading"><LoaderCircle className="spin"/><strong>Loading agent workspace…</strong></div>;
  if (!agent) return <EmptyState Icon={Bot} title="Agent not found" text="This agent may have been archived or removed from the workspace." action={<button className="button" onClick={() => navigate('/agents')}>Back to Agents</button>}/>;
  return <AgentExecutionProvider agent={agent}><AgentWorkspace/></AgentExecutionProvider>;
}

function AgentWorkspace() {
  const execution = useAgentExecution();
  const [activityOpen, setActivityOpen] = useState(() => window.matchMedia('(min-width: 1180px)').matches);
  const currentStep = execution.steps.find((item) => item.id === execution.currentStepId);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 1180px)');
    const change = (event: MediaQueryListEvent) => { if (event.matches) setActivityOpen(true); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  return <div className={`agent-workspace-shell ${activityOpen ? 'activity-open' : 'activity-closed'}`}>
    <div className="agent-workspace-main">
      <header className="agent-workspace-header">
        <div className="agent-workspace-identity"><AgentAvatar agent={execution.agent} size="md" status={execution.status === 'failed' ? 'error' : execution.status === 'running' ? 'busy' : undefined} thinkingState={thinkingOrbStateForContext(currentStep?.kind, currentStep?.label)}/><div><span className="eyebrow">{execution.agent.role}</span><h1>{execution.agent.name}</h1><p>{sectionDescription(execution.section)}</p></div></div>
        <div><Status value={execution.status}/><button className="button" onClick={() => setActivityOpen((value) => !value)} aria-expanded={activityOpen}><Activity size={15}/>{activityOpen ? 'Hide activity' : 'Show activity'}{execution.pendingApprovals > 0 && <b className="attention-count">{execution.pendingApprovals}</b>}</button></div>
      </header>
      <div className="agent-section-content">
        {execution.section === 'overview' && <AgentOverview/>}
        {execution.section === 'workspace' && <AgentTaskWorkspace/>}
        {execution.section === 'configure' && <AgentConfiguration/>}
        {execution.section === 'workflow' && <AgentWorkflowView/>}
        {execution.section === 'history' && <AgentHistory/>}
      </div>
    </div>
    {activityOpen && <><button className="activity-drawer-backdrop" onClick={() => setActivityOpen(false)} aria-label="Close activity"/><AgentActivityPanel close={() => setActivityOpen(false)}/></>}
    {!activityOpen && <button className="activity-dock-button" onClick={() => setActivityOpen(true)}><PanelRightOpen size={17}/><span><strong>Activity</strong><small>{execution.task ? `${humanize(execution.status)} · ${execution.steps.find((step) => step.id === execution.currentStepId)?.label ?? 'Current task'}` : 'No active task'}</small></span>{execution.errorCount > 0 && <b>{execution.errorCount}</b>}{execution.pendingApprovals > 0 && <b className="warning">{execution.pendingApprovals}</b>}</button>}
  </div>;
}

function sectionDescription(section: ReturnType<typeof useAgentExecution>['section']) {
  if (section === 'workspace') return 'Give the agent work and review its result.';
  if (section === 'configure') return 'Review its purpose, model, resources and permissions.';
  if (section === 'workflow') return 'Follow the exact workflow and its active execution step.';
  if (section === 'history') return 'Return to previous tasks and saved outputs.';
  return 'Purpose, capabilities and the next action in one view.';
}

function AgentOverview() {
  const execution = useAgentExecution();
  const { data } = useWorkspace();
  const done = execution.tasks.filter((task) => task.status === 'completed').length;
  const failed = execution.tasks.filter((task) => task.status === 'failed').length;
  const rate = done + failed ? Math.round(done / (done + failed) * 100) : null;
  const tokens = execution.tasks.reduce((sum, task) => sum + Number(task.token_input ?? 0) + Number(task.token_output ?? 0), 0);
  const capabilities = Object.entries(execution.agent.capabilities ?? {}).filter(([, enabled]) => enabled).map(([key]) => key);
  const apiTools = data.tools.filter(isApiTool).filter((tool) => execution.agent.tool_ids?.includes(tool.id));
  return <div className="agent-overview-grid">
    <section className="panel agent-purpose-card"><div className="section-title"><div><span className="eyebrow">Agent purpose</span><h2>What {execution.agent.name} is here to do</h2></div><button className="text-button" onClick={() => execution.setSection('configure')}>Review setup <ChevronRight size={14}/></button></div><p className="agent-goal">{execution.agent.goal}</p>{execution.agent.personality && <p className="agent-personality"><Sparkles size={15}/>{execution.agent.personality}</p>}<div className="capability-tags">{capabilities.length ? capabilities.map((capability) => <span key={capability}>{humanize(capability)}</span>) : <span>Core reasoning only</span>}{apiTools.map((tool) => <span key={tool.id}><Wrench size={11}/>{tool.name}</span>)}</div></section>
    <section className="panel next-action-card"><span className="eyebrow">Next action</span>{execution.task && ['running', 'queued', 'awaiting_approval'].includes(execution.task.status) ? <><Activity size={26}/><h2>Continue monitoring</h2><p>{execution.task.title}</p><button className="button primary" onClick={() => execution.setSection('workspace')}>Open current task <ArrowRight size={14}/></button></> : <><Play size={26}/><h2>Start a new task</h2><p>Describe the outcome. Woody will keep progress and results beside your work.</p><button className="button primary" onClick={() => execution.setSection('workspace')}>Go to workspace <ArrowRight size={14}/></button></>}</section>
    <section className="panel agent-health-card"><div className="section-title"><div><span className="eyebrow">Performance</span><h2>Agent health</h2></div><Status value={execution.agent.status}/></div><div className="agent-metric-grid"><span><small>Success rate</small><strong>{rate === null ? '—' : `${rate}%`}</strong></span><span><small>Completed</small><strong>{done}</strong></span><span><small>Tokens</small><strong>{compact(tokens)}</strong></span><span><small>Cost</small><strong>{taskCost(execution.tasks).label}</strong></span></div></section>
    <section className="panel recent-agent-work"><div className="section-title"><div><span className="eyebrow">Recent work</span><h2>Latest tasks</h2></div><button className="text-button" onClick={() => execution.setSection('history')}>Full history <ChevronRight size={14}/></button></div>{execution.tasks.length ? execution.tasks.slice(0, 4).map((task) => <button key={task.id} onClick={() => execution.selectTask(task.id)}><Status value={task.status}/><span><strong>{task.title}</strong><small>{relative(task.created_at)}{task.duration_ms ? ` · ${duration(task.duration_ms)}` : ''}</small></span><ChevronRight size={15}/></button>) : <div className="compact-empty"><Clock3 size={20}/><p>No tasks yet. Start in Workspace.</p></div>}</section>
  </div>;
}

function AgentTaskWorkspace() {
  const execution = useAgentExecution();
  const queryClient = useQueryClient();
  const { report, reportError } = useWorkspace();
  const [composing, setComposing] = useState(!execution.task);
  const [previewAttachment, setPreviewAttachment] = useState<NonNullable<typeof execution.task>['attachments'][number] | null>(null);
  const retrievedSources = ([...(execution.task?.events ?? [])].reverse().find((event) => event.event_type === 'attachments.retrieved')?.payload?.citations ?? []) as Array<{ fileId: string; filename: string; locator: string }>;
  const rerun = useMutation({
    mutationFn: () => api.createTask({ agentId: execution.agent.id, title: `${execution.task!.title} — retry`, input: execution.task?.input ?? {} }),
    onSuccess: async (task) => { report('New task queued'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); execution.selectTask(task.id); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not retry task'),
  });
  return <div className="agent-task-workspace">
    <section className={`panel inline-task-composer ${composing ? 'open' : ''}`}>
      <div className="section-title"><div><span className="eyebrow">Task</span><h2>{composing ? `Give ${execution.agent.name} a task` : execution.task?.title ?? 'Start work'}</h2></div><button className="button" onClick={() => setComposing((value) => !value)}>{composing ? 'Close composer' : <><Plus size={14}/>New task</>}</button></div>
      {composing && <TaskDialogBody agentId={execution.agent.id} close={() => setComposing(false)} onCreated={(task) => execution.selectTask(task.id)} submitLabel="Start execution"/>}
    </section>
    {execution.taskLoading && <section className="panel workspace-state"><LoaderCircle className="spin"/><h2>Loading task</h2><p>Retrieving the latest events and result.</p></section>}
    {!execution.taskLoading && execution.task && <>
      <section className={`panel task-focus-card ${execution.task.status}`}><div><span className="eyebrow">Selected run · {relative(execution.task.created_at)}</span><h2>{execution.task.title}</h2><p>{statusMessage(execution.task.status)}</p></div><div><Status value={execution.task.status}/>{['completed', 'failed', 'cancelled'].includes(execution.task.status) && <button className="button" disabled={rerun.isPending} onClick={() => rerun.mutate()}><RotateCcw size={14}/>Run again</button>}</div></section>
      {execution.task.input && Object.keys(execution.task.input).length > 0 && <section className="panel run-input-section"><div className="section-title"><div><span className="eyebrow">Request</span><h2>Task context</h2></div></div><OutputViewer value={execution.task.input}/></section>}
      {execution.task.attachments?.length > 0 && <section className="panel run-input-section"><div className="section-title"><div><span className="eyebrow">Scoped evidence</span><h2>Task attachments</h2></div><small>{execution.task.attachments.length} file{execution.task.attachments.length === 1 ? '' : 's'}</small></div><div className="attachment-list">{execution.task.attachments.map((file) => <AttachmentChip key={file.id} file={file} onPreview={() => setPreviewAttachment(file)}/>)}</div></section>}
      {execution.task.output !== undefined && execution.task.output !== null && (execution.task.status === 'completed'
        ? <section className="panel editable-output-panel"><EditableOutput task={execution.task} refreshTask={() => void execution.refresh()}/></section>
        : <section className="panel output-section primary-result"><div className="section-title"><div><span className="eyebrow">Saved automatically</span><h2>Agent result</h2></div><FileOutput size={20}/></div><OutputViewer value={execution.task.output}/></section>)}
      {retrievedSources.length > 0 && <section className="panel run-input-section"><div className="section-title"><div><span className="eyebrow">Grounding</span><h2>Attachment sources used</h2></div></div><div className="capability-tags">{retrievedSources.map((source, index) => <span key={`${source.fileId}-${source.locator}-${index}`}>{source.filename} · {source.locator}</span>)}</div></section>}
      {execution.task.error !== undefined && execution.task.error !== null && <section className="panel output-section error"><h2>Execution error</h2><OutputViewer value={execution.task.error} error/></section>}
      {(execution.task.status === 'completed' || execution.task.artifacts?.length > 0) && <section className="panel"><ArtifactPanel task={execution.task} refresh={() => void execution.refresh()}/></section>}
      {previewAttachment && <FilePreviewDialog file={previewAttachment} close={() => setPreviewAttachment(null)}/>}
    </>}
    {!execution.taskLoading && !execution.task && !composing && <EmptyState Icon={Play} title="Ready for the first task" text="Start a task to create an execution timeline and saved result." action={<button className="button primary" onClick={() => setComposing(true)}>Start a task</button>}/>} 
  </div>;
}

function AgentWorkflowView() {
  const execution = useAgentExecution();
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const related = useMemo(() => data.workflows.filter((workflow) => workflow.definition.nodes.some((node) => node.type === 'agent' && node.config.agentId === execution.agent.id)), [data.workflows, execution.agent.id]);
  const plannedSteps = !execution.steps.length && related[0] ? related[0].definition.nodes.map((node) => ({ id: node.id, label: typeof node.config.label === 'string' ? node.config.label : node.type === 'agent' ? data.agents.find((agent) => agent.id === node.config.agentId)?.name ?? 'Agent step' : humanize(node.type), kind: node.type, status: 'pending' as const })) : [];
  const visibleSteps = execution.steps.length ? execution.steps : plannedSteps;
  return <div className="agent-workflow-layout">
    <section className="panel workflow-step-panel"><div className="section-title"><div><span className="eyebrow">{plannedSteps.length ? 'Published plan · not running' : 'Synchronized execution'}</span><h2>{execution.workflowRun ? 'Workflow steps' : execution.steps.length ? 'Task phases' : plannedSteps.length ? related[0].name : 'Workflow steps'}</h2></div>{execution.workflowRun ? <Status value={execution.workflowRun.status}/> : plannedSteps.length ? <Status value={related[0].status}/> : null}</div>{visibleSteps.length ? <div className="agent-step-list">{visibleSteps.map((step, index) => <button key={step.id} className={`${execution.selectedStepId === step.id ? 'selected' : ''} ${step.status}`} onClick={() => execution.selectStep(step.id)}><span className="step-index">{step.status === 'completed' ? <CheckCircle2 size={15}/> : step.status === 'failed' ? <CircleAlert size={15}/> : index + 1}</span><span><strong>{step.label}</strong><small>{humanize(step.kind)}</small></span><Status value={step.status}/></button>)}</div> : <EmptyState Icon={Activity} title="No workflow yet" text="Start a standalone task or add this agent to a workflow to see its execution plan."/>}</section>
    <section className="panel workflow-context-panel"><span className="eyebrow">Automation context</span><h2>Workflows using this agent</h2><p>The live step list uses the exact saved workflow snapshot. Editing a workflow cannot rewrite old run history.</p>{related.length ? <div className="related-workflows">{related.map((workflow) => <article key={workflow.id}><span><strong>{workflow.name}</strong><small>{workflow.description || `${workflow.definition.nodes.length} nodes`} · {humanize(workflow.status)}</small></span><button className="button" onClick={() => navigate('/workflows')}>Open designer</button></article>)}</div> : <div className="compact-empty"><Brain size={20}/><p>This agent currently runs standalone tasks. Add it to a workflow when you need routing, approvals or multiple agents.</p><button className="button" onClick={() => navigate('/workflows')}>Open Workflow Designer</button></div>}</section>
  </div>;
}

function AgentConfiguration() {
  const execution = useAgentExecution();
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const apiTools = data.tools.filter(isApiTool).filter((tool) => execution.agent.tool_ids?.includes(tool.id));
  const capabilities = Object.entries(execution.agent.capabilities ?? {});
  const mcpResources = useQuery({ queryKey: ['workflow-resources'], queryFn: api.workflowResources });
  const mcpAccess = mcpAccessForAgent(mcpResources.data, execution.agent.id);
  return <div className="agent-config-overview">
    <section className="panel config-hero"><div><span className="eyebrow">Published configuration</span><h2>Purpose and instructions</h2><p>Review the operating contract before changing how this agent works.</p></div><button className="button primary" onClick={() => navigate(`/agents/${execution.agent.id}/edit`)}><Pencil size={14}/>Edit full configuration</button></section>
    <section className="panel"><h3>Role</h3><p>{execution.agent.role}</p><h3>Goal</h3><p>{execution.agent.goal}</p><details className="config-details"><summary>Instructions</summary><OutputViewer value={execution.agent.instructions}/></details></section>
    <section className="panel"><div className="section-title"><div><span className="eyebrow">Runtime</span><h2>Model settings</h2></div><Settings2 size={19}/></div><dl className="config-definition-list"><div><dt>Model</dt><dd>{execution.agent.model}</dd></div><div><dt>Temperature</dt><dd>{execution.agent.model_config?.temperature ?? 0.2}</dd></div><div><dt>Maximum tokens</dt><dd>{execution.agent.model_config?.maxTokens ?? 4096}</dd></div><div><dt>Top P</dt><dd>{execution.agent.model_config?.topP ?? 1}</dd></div></dl></section>
    <section className="panel"><div className="section-title"><div><span className="eyebrow">Access</span><h2>Capabilities and resources</h2></div><Wrench size={19}/></div><div className="permission-list">{capabilities.map(([name, enabled]) => <span key={name}><strong>{humanize(name)}</strong><Status value={enabled ? 'enabled' : 'disabled'}/></span>)}</div><div className="resource-group"><div><h3>API Tools</h3><p>Saved in this agent’s API Tool access list.</p></div><div className="permission-list">{apiTools.map((tool) => <span key={tool.id}><strong>{tool.name}</strong><small>{tool.permissions.join(', ') || 'No declared permissions'}</small><Status value={tool.enabled ? 'enabled' : 'disabled'}/></span>)}{!apiTools.length && <p>No API Tools are assigned.</p>}</div></div><div className="resource-group"><div><h3>MCP access</h3><p>Currently available through this agent’s separate MCP allowlists.</p></div>{mcpResources.isLoading ? <p>Loading MCP access…</p> : mcpResources.isError ? <p>MCP access could not be loaded.</p> : <div className="mcp-agent-resource-summary"><div><strong>Assigned connections</strong>{mcpAccess.connections.length ? mcpAccess.connections.map((connection) => <span key={connection}>{connection}</span>) : <span>No currently available connections</span>}</div><div><strong>Assigned MCP actions</strong>{mcpAccess.actions.length ? mcpAccess.actions.map((tool) => <span key={tool.id}>{tool.title ?? tool.remoteName}</span>) : <span>No currently available actions</span>}</div></div>}<button className="button" onClick={() => navigate('/mcp?tab=access')}>Manage MCP access</button></div><div className="config-actions"><button className="button" onClick={() => navigate('/knowledge')}>Knowledge Hub</button><button className="button" onClick={() => navigate('/api-tools')}>API Tools</button></div></section>
  </div>;
}

function AgentHistory() {
  const execution = useAgentExecution();
  const totalCost = taskCost(execution.tasks);
  return <section className="panel agent-history-panel"><div className="section-title"><div><span className="eyebrow">Saved history</span><h2>Previous tasks and outputs</h2></div><span className="cost-pill">{totalCost.available ? `${totalCost.label} total` : 'Pricing unavailable'}</span></div>{execution.tasks.length ? <div className="agent-history-list">{execution.tasks.map((task) => <button key={task.id} className={execution.task?.id === task.id ? 'selected' : ''} onClick={() => execution.selectTask(task.id)}><Status value={task.status}/><span><strong>{task.title}</strong><small>{new Date(task.created_at).toLocaleString()} · {task.duration_ms ? duration(task.duration_ms) : humanize(task.status)}</small></span><span><small>{taskCost([task]).label}</small>{task.output !== undefined && task.output !== null && <FileOutput size={14}/>}<ChevronRight size={15}/></span></button>)}</div> : <EmptyState Icon={History} title="No output history" text="Completed tasks, failures and saved outputs will appear here."/>}</section>;
}

function statusMessage(status: Task['status']) {
  if (status === 'queued') return 'The task is queued and will start when a worker is available.';
  if (status === 'running') return 'The agent is working. Follow the active phase and tools in Live Activity.';
  if (status === 'awaiting_approval') return 'The agent is waiting for a person to approve a protected action.';
  if (status === 'completed') return 'The result is saved below. You can generate, preview or download files.';
  if (status === 'failed') return 'Review the error and activity details before running the task again.';
  return 'This task was cancelled. Start a new task when you are ready.';
}
