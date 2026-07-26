import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, ArrowUpRight, CalendarDays, CheckCircle2, CircleAlert, Download, Eye, FileArchive, FileSpreadsheet, FileText, LoaderCircle, Play, Presentation, RefreshCw, Search, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, artifactFormats, type Artifact, type ArtifactFormat, type FileAsset, type Task, type TaskDetail } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { OutputViewer } from '../../components/OutputViewer';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { compact, duration, relative, taskCost } from '../../lib/format';
import { failureGuidance, outputText } from '../../lib/recovery';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import { AttachmentPicker } from '../../components/files/AttachmentPicker';
import { HtmlArtifactPreview } from '../../components/files/HtmlArtifactPreview';
import { OutputFormatPicker } from '../../components/files/OutputFormatPicker';
import { EditableOutput } from '../../components/outputs/EditableOutput';

const taskAgent = (task: Task) => ({ id: task.agent_id, name: task.agent_name ?? 'AI Agent', role: task.agent_role ?? 'AI agent', avatar_config: task.agent_avatar ?? {}, updated_at: task.updated_at });

function outputSummary(task: Task) {
  const artifacts = task.artifact_summary ?? [];
  const readyFiles = artifacts.filter((artifact) => artifact.status === 'ready');
  const pendingFiles = artifacts.filter((artifact) => ['pending', 'queued', 'generating'].includes(artifact.status));
  const failedFiles = artifacts.filter((artifact) => artifact.status === 'failed');
  if (task.status === 'completed' && task.output !== null && task.output !== undefined && failedFiles.length) return { state: 'Output ready · file issue', action: 'Review result', tone: 'warning' };
  if (task.status === 'completed' && task.output !== null && task.output !== undefined && pendingFiles.length) return { state: 'Output ready · files generating', action: 'View result', tone: 'active' };
  if (task.status === 'completed' && task.output !== null && task.output !== undefined) return { state: readyFiles.length ? 'Output and files ready' : 'Output ready', action: 'View result', tone: 'ready' };
  if (task.status === 'completed' && readyFiles.length) return { state: 'Files ready', action: 'Open files', tone: 'ready' };
  if (task.status === 'completed' && pendingFiles.length) return { state: 'Files still generating', action: 'View progress', tone: 'active' };
  if (task.status === 'completed' && failedFiles.length) return { state: 'File generation failed', action: 'Review error', tone: 'error' };
  if (task.status === 'completed') return { state: 'Completed · no saved result', action: 'View details', tone: 'muted' };
  if (task.status === 'failed') return { state: 'Run failed', action: 'Review error', tone: 'error' };
  if (task.status === 'awaiting_approval') return { state: 'Action required', action: 'Review approval', tone: 'warning' };
  if (task.status === 'running') return { state: 'Generating output', action: 'View progress', tone: 'active' };
  if (task.status === 'queued') return { state: 'Waiting to start', action: 'View progress', tone: 'active' };
  return { state: 'Run cancelled', action: 'View details', tone: 'muted' };
}

function outputPreview(value: unknown) {
  const text = outputText(value);
  let preview = '';
  if (text) preview = text;
  if (value === null || value === undefined) return '';
  if (!preview) {
    try {
      preview = JSON.stringify(value);
    } catch {
      preview = 'Saved structured result';
    }
  }
  const normalized = preview.replace(/\s+/g, ' ').trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}…` : normalized;
}

export function ExecutionPage({ openTask }: { openTask: () => void }) {
  const { data } = useWorkspace();
  const [params] = useSearchParams();
  const taskId = params.get('task');
  const agentId = params.get('agent');
  const [filter, setFilter] = useState(params.get('status') ?? 'all');
  const [agentFilter, setAgentFilter] = useState(agentId ?? 'all');
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'week'>('all');
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    if (!taskId) return;
    const legacyTask = data.tasks.find((task) => task.id === taskId);
    if (legacyTask) navigate(`/agents/${legacyTask.agent_id}?section=workspace&task=${legacyTask.id}`, { replace: true });
  }, [data.tasks, navigate, taskId]);
  const filtered = data.tasks.filter((task) => {
    const created = new Date(task.created_at).getTime();
    const now = Date.now();
    const matchesDate = dateFilter === 'all' || (dateFilter === 'today' && now - created <= 86_400_000) || (dateFilter === 'week' && now - created <= 604_800_000);
    const matchesQuery = !query.trim() || `${task.title} ${task.agent_name ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
    return (!agentId || task.agent_id === agentId) && (agentFilter === 'all' || task.agent_id === agentFilter) && (filter === 'all' || task.status === filter) && matchesDate && matchesQuery;
  });
  const totalCost = taskCost(filtered);
  return <div className="execution-page">
    <PageHeader eyebrow="Workspace index" title="Outputs" description="Find agent work and saved results. Open an item to see its workflow, live activity, approvals and output together in the agent workspace." actions={<><span className="cost-pill">{totalCost.available ? `${totalCost.label} in view` : 'Pricing unavailable'}</span><button className="button primary" onClick={openTask}><Play size={15}/>Run task</button></>}/>
    <section className="runs-filter-bar panel"><label><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search output, task or agent"/></label><select aria-label="Filter outputs by status" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All statuses</option><option value="running">Running</option><option value="queued">Queued</option><option value="awaiting_approval">Needs approval</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select><select aria-label="Filter outputs by agent" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}><option value="all">All agents</option>{data.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><select aria-label="Filter outputs by date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value as typeof dateFilter)}><option value="all">Any date</option><option value="today">Last 24 hours</option><option value="week">Last 7 days</option></select><span><CalendarDays size={14}/>{filtered.length} shown</span></section>
    <div className="execution-layout run-index-layout">
      <section className="panel run-list">
        <div className="panel-header"><div><span className="eyebrow">Agent work</span><h2>Recent outputs</h2></div><small>Open an item to view it with its agent workflow</small></div>
        {filtered.length ? <div>{filtered.map((task) => {
          const summary = outputSummary(task);
          const cost = taskCost([task]);
          const formats = [...new Set((task.artifact_summary ?? []).filter((artifact) => artifact.status !== 'skipped').map((artifact) => artifact.format))];
          const origin = task.workflow_name ? `${task.workflow_name} · ${task.agent_name ?? 'AI Agent'}` : task.agent_name ?? 'AI Agent';
          const timing = task.completed_at ? `Completed ${relative(task.completed_at)}` : task.started_at ? `Started ${relative(task.started_at)}` : `Created ${relative(task.created_at)}`;
          const agent = data.agents.find((item) => item.id === task.agent_id);
          const agentDescription = agent?.goal?.trim() || task.agent_role?.trim() || 'General AI agent';
          const preview = outputPreview(task.output);
          return <button className={taskId === task.id ? 'active' : ''} key={task.id} aria-label={`${summary.action}: ${task.title}`} onClick={() => navigate(`/agents/${task.agent_id}?section=workspace&task=${task.id}`)}>
            <AgentAvatar agent={taskAgent(task)} size="sm" status={task.status === 'failed' ? 'error' : task.status === 'running' ? 'busy' : undefined} decorative/>
            <span className="run-card-copy">
              <span><strong title={task.title}>{task.title}</strong><Status value={task.status}/></span>
              <small>{origin} · {timing}</small>
              <span className="run-agent-description" title={agentDescription}>{agentDescription}</span>
              <span className="run-output-preview">
                <span><b>Output</b><em className={`run-output-state ${summary.tone}`}>{summary.state}</em></span>
                <span title={preview || summary.state}>{preview || summary.state}</span>
              </span>
              {formats.length > 0 && <span className="run-format-list" aria-label={`Requested files: ${formats.join(', ')}`}>{formats.map((format) => <i key={format}>{format.toUpperCase()}</i>)}</span>}
            </span>
            <span className="run-card-result"><small>{cost.available ? cost.label : 'Pricing unavailable'}</small><b>{summary.action}<ArrowUpRight size={13}/></b></span>
          </button>;
        })}</div> : <EmptyState Icon={Activity} title="No outputs found" text={data.tasks.length ? 'No agent work matches these filters.' : 'Run a task to create the first output.'} action={!data.tasks.length && <button className="button primary" onClick={openTask}>Run task</button>}/>}
      </section>
    </div>
  </div>;
}

export function ExecutionDetail({ task, refresh }: { task: TaskDetail; refresh: () => void }) {
  const queryClient = useQueryClient();
  const { report, reportError, session } = useWorkspace();
  const navigate = useNavigate();
  const cancel = useMutation({
    mutationFn: () => api.cancelTask(task.id),
    onSuccess: async () => { report('Task cancelled'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); await queryClient.invalidateQueries({ queryKey: ['task', task.id] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not cancel task'),
  });
  const decideAction = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) => api.decideActionAuthorization(id, decision),
    onSuccess: async (_result, variables) => {
      report(variables.decision === 'approved' ? 'Action approved once' : 'Action rejected');
      await queryClient.invalidateQueries({ queryKey: ['task', task.id] });
      await queryClient.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not resolve action confirmation'),
  });
  const cancellable = ['queued', 'running', 'awaiting_approval'].includes(task.status);
  const pendingActions = task.actionAuthorizations?.filter((authorization) => authorization.status === 'awaiting_confirmation') ?? [];
  const canApproveActions = !session.workspace.role || ['owner', 'admin'].includes(session.workspace.role);
  const cost = taskCost([task], 5);
  return <div className="execution-detail">
    <div className="trace-head"><AgentAvatar agent={taskAgent(task)} size="md" status={task.status === 'failed' ? 'error' : task.status === 'running' ? 'busy' : undefined}/><div><span className="eyebrow">run:{task.id.slice(0, 8)}</span><h2>{task.title}</h2><p>{task.agent_name ?? 'AI Agent'} · created {new Date(task.created_at).toLocaleString()}</p></div><div><Status value={task.status}/><button className="icon-button" onClick={refresh} aria-label="Refresh execution"><RefreshCw size={16}/></button>{cancellable && <button className="button danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}><Square size={13}/>Cancel</button>}</div></div>
    <RunStatusGuide task={task} openAgent={() => navigate(`/agents/${task.agent_id}/edit`)}/>
    {pendingActions.map((authorization) => <section className="workflow-approval action-bound" key={authorization.id}><span><strong>Confirm agent action</strong><small>{authorization.target_summary ?? authorization.operation} · {authorization.risk_level.replaceAll('_', ' ')}</small><code>{JSON.stringify(authorization.arguments_summary)}</code>{!canApproveActions && <small>An owner or admin must approve this action.</small>}</span>{canApproveActions && <button className="button danger" disabled={decideAction.isPending} onClick={() => decideAction.mutate({ id: authorization.id, decision: 'rejected' })}>Reject</button>}{canApproveActions && <button className="button primary" disabled={decideAction.isPending} onClick={() => decideAction.mutate({ id: authorization.id, decision: 'approved' })}>Approve once</button>}</section>)}
    <div className="execution-stats"><span><small>Duration</small><strong>{task.duration_ms ? duration(task.duration_ms) : '—'}</strong></span><span><small>Input tokens</small><strong>{compact(task.token_input ?? 0)}</strong></span><span><small>Output tokens</small><strong>{compact(task.token_output ?? 0)}</strong></span><span><small>Cost</small><strong>{cost.label}</strong></span></div>
    {task.input && Object.keys(task.input).length > 0 && <section className="run-input-section"><div className="section-title"><div><span className="eyebrow">Request</span><h3>Input provided</h3></div></div><OutputViewer value={task.input}/></section>}
    <div className="trace-timeline"><h3>Event timeline</h3>{task.events.length ? task.events.map((event) => <div key={event.id}><i/><time>{new Date(event.created_at).toLocaleTimeString()}</time><span><strong>{event.event_type.replaceAll('.', ' ')}</strong><p>{event.message}</p>{event.payload && Object.keys(event.payload).length > 0 && <details className="event-data"><summary>Technical event data</summary><code>{JSON.stringify(event.payload)}</code></details>}</span></div>) : <p>No events recorded yet.</p>}</div>
    {(task.output !== null && task.output !== undefined) && (task.status === 'completed'
      ? <EditableOutput task={task} refreshTask={refresh}/>
      : <section className="output-section"><h3>Agent result</h3><OutputViewer value={task.output}/></section>)}
    <ArtifactPanel task={task} refresh={refresh}/>
    {(task.error !== null && task.error !== undefined) && <section className="output-section error"><h3>Execution error</h3><OutputViewer value={task.error} error/></section>}
    {task.status === 'completed' && (task.output === null || task.output === undefined) && <section className="output-section"><h3>Agent result</h3><p>This task completed without an output payload.</p></section>}
  </div>;
}

export function RunStatusGuide({ task, openAgent }: { task: TaskDetail; openAgent: () => void }) {
  if (task.status === 'failed') return <section className="run-status-guide failed"><CircleAlert size={20}/><div><strong>This run needs attention</strong><p>{failureGuidance(task.error)}</p><span>Nothing will retry automatically. Review the agent setup or start a new task after fixing the cause.</span></div><button className="button" onClick={openAgent}>Open agent <ArrowUpRight size={14}/></button></section>;
  if (task.status === 'awaiting_approval') return <section className="run-status-guide waiting"><AlertTriangle size={20}/><div><strong>Waiting for approval</strong><p>This task is paused until an authorized person approves the required action.</p></div></section>;
  if (task.status === 'completed') return <section className="run-status-guide complete"><CheckCircle2 size={20}/><div><strong>Run completed</strong><p>Review the result below, then open or download any requested files.</p></div></section>;
  return <section className="run-status-guide active"><Activity size={20}/><div><strong>{task.status === 'queued' ? 'Run is queued' : 'Run is in progress'}</strong><p>Woody refreshes this view while the task and any requested file generation are still active.</p></div></section>;
}

export function TaskDialogBody({ close, agentId, onCreated, submitLabel = 'Queue task' }: { close: () => void; agentId?: string; onCreated?: (task: Task) => void; submitLabel?: string }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: api.createTask,
    onSuccess: async (task) => { report('Task queued for execution'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); onCreated?.(task); close(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not queue task'),
  });
  const agents = data.agents.filter((agent) => agent.status === 'active' && (!agentId || agent.id === agentId));
  const [attachments, setAttachments] = useState<FileAsset[]>([]);
  const [artifactFormats, setArtifactFormats] = useState<ArtifactFormat[]>([]);
  const attachmentsReady = attachments.every((file) => file.status === 'ready');
  const send = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    mutation.mutate({
      agentId: String(form.get('agentId')),
      title: String(form.get('title')),
      input: { request: String(form.get('request')) },
      artifactFormats,
      attachmentIds: attachments.map((file) => file.id),
    });
  };
  return <form className="form-grid" onSubmit={send}>{agentId ? <input type="hidden" name="agentId" value={agentId}/> : <label>Active agent<select name="agentId" required defaultValue=""><option value="">Choose an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>)}</select></label>}<label>Task title<input name="title" required minLength={2} maxLength={300} placeholder="Research current market"/></label><label>Desired outcome<textarea name="request" required placeholder="Describe exactly what the agent should deliver. Mention which attachment to use when several are selected."/></label><AttachmentPicker value={attachments} onChange={setAttachments}/><OutputFormatPicker value={artifactFormats} onChange={setArtifactFormats}/>{!agents.length && <div className="inline-error"><AlertTriangle size={15}/>This agent must be published and active before it can run tasks.</div>}{!attachmentsReady && <div className="security-note"><LoaderCircle className="spin" size={15}/>Wait for every attachment to finish scanning and extraction before starting.</div>}<div className="form-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={!agents.length || !attachmentsReady || mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Play size={15}/>} {submitLabel}</button></div></form>;
}

function artifactIcon(format: ArtifactFormat) {
  if (format === 'xlsx') return <FileSpreadsheet size={16}/>;
  if (format === 'pptx') return <Presentation size={16}/>;
  if (format === 'pdf') return <FileText size={16}/>;
  return <FileArchive size={16}/>;
}

function bytes(value: string | number | null | undefined) {
  const size = Number(value ?? 0);
  if (!size) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function artifactRevisionLabel(artifact: Artifact, currentVersionId?: string) {
  if (!artifact.output_document_version_id) return 'Original agent output';
  return artifact.output_document_version_id === currentVersionId ? 'Current revision' : 'Older revision';
}

export function ArtifactPanel({ task, refresh }: { task: TaskDetail; refresh: () => void }) {
  const { session, report, reportError } = useWorkspace();
  const canDelete = !session.workspace.role || ['owner', 'admin'].includes(session.workspace.role);
  const [formats, setFormats] = useState<ArtifactFormat[]>([]);
  const [htmlPreview, setHtmlPreview] = useState<{ title: string; html: string } | null>(null);
  const [openingArtifactId, setOpeningArtifactId] = useState<string | null>(null);
  const outputDocumentQuery = useQuery({
    queryKey: ['output-document', task.id],
    queryFn: () => api.outputDocumentForTask(task.id),
    enabled: task.status === 'completed',
  });
  const outputDocument = outputDocumentQuery.data?.document ?? null;
  const currentVersionId = outputDocument?.currentVersion.id;
  const requestFiles = useMutation({
    mutationFn: () => outputDocument
      ? api.requestOutputArtifacts(outputDocument.id, { versionId: outputDocument.currentVersion.id, formats })
      : api.requestArtifacts({ taskId: task.id, formats }),
    onSuccess: async () => {
      report(outputDocument ? `File generation requested from version ${outputDocument.current_version_number}` : 'Artifact generation requested');
      setFormats([]);
      refresh();
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not request artifacts'),
  });
  const remove = useMutation({
    mutationFn: api.deleteArtifact,
    onSuccess: () => { report('Artifact deleted'); refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not delete artifact'),
  });
  const openArtifact = async (artifact: Artifact, inline: boolean) => {
    const sandboxHtml = inline && artifact.format === 'html';
    const pendingTab = inline && !sandboxHtml ? window.open('', '_blank', 'noopener,noreferrer') : null;
    setOpeningArtifactId(artifact.id);
    try {
      const file = await api.artifactFile(artifact.id, inline);
      if (sandboxHtml) {
        setHtmlPreview({ title: file.filename, html: await file.blob.text() });
        return;
      }
      const url = URL.createObjectURL(file.blob);
      if (inline && pendingTab) pendingTab.location.href = url;
      else {
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      pendingTab?.close();
      reportError(cause instanceof Error ? cause.message : 'Could not open artifact');
    } finally {
      setOpeningArtifactId(null);
    }
  };
  const existing = new Set((task.artifacts ?? [])
    .filter((artifact) => artifact.status !== 'failed')
    .filter((artifact) => outputDocument
      ? artifact.output_document_version_id === currentVersionId
      : !artifact.output_document_version_id)
    .map((artifact) => artifact.format));
  const available = artifactFormats.filter((format) => !existing.has(format));
  if (!task.artifacts?.length && task.status !== 'completed') return null;
  return <section className="artifact-section"><div className="section-title"><div><h3>Downloadable files</h3><small>{outputDocument ? `New files use saved version ${outputDocument.current_version_number}. Older files remain available below.` : "HTML files open in Woody's safe viewer. Other formats preview or download normally."}</small></div><button className="icon-button" onClick={refresh} aria-label="Refresh artifacts"><RefreshCw size={14}/></button></div>{outputDocumentQuery.error && <div className="inline-error"><AlertTriangle size={15}/><span>Woody could not verify which output version these files use.</span></div>}{task.artifacts?.length ? <div className="artifact-list">{task.artifacts.map((artifact) => <article key={artifact.id}><span className={`artifact-icon ${artifact.format}`}>{artifactIcon(artifact.format)}</span><span><strong>{artifact.filename}</strong><small>{artifact.format.toUpperCase()} · {artifact.status === 'ready' ? bytes(artifact.size_bytes) : artifact.status.replaceAll('_', ' ')}</small><small className={`artifact-revision ${artifact.output_document_version_id === currentVersionId ? 'current' : ''}`}>{artifactRevisionLabel(artifact, currentVersionId)}</small>{artifact.error_message && <em>{artifact.error_message}</em>}</span><Status value={artifact.status}/>{artifact.status === 'ready' && artifact.format === 'html' && <button className="button artifact-view-button" aria-label={`View HTML ${artifact.filename}`} disabled={openingArtifactId === artifact.id} onClick={() => void openArtifact(artifact, true)}>{openingArtifactId === artifact.id ? <LoaderCircle className="spin" size={14}/> : <Eye size={14}/>}View HTML</button>}{artifact.status === 'ready' && artifact.format === 'pdf' && <button className="icon-button" aria-label={`Preview ${artifact.filename}`} disabled={openingArtifactId === artifact.id} onClick={() => void openArtifact(artifact, true)}><Eye size={15}/></button>}{artifact.status === 'ready' && <button className="icon-button" aria-label={`Download ${artifact.filename}`} disabled={openingArtifactId === artifact.id} onClick={() => void openArtifact(artifact, false)}><Download size={15}/></button>}{canDelete && <button className="icon-button danger" aria-label={`Delete ${artifact.filename}`} disabled={remove.isPending} onClick={() => remove.mutate(artifact.id)}><Trash2 size={14}/></button>}</article>)}</div> : <p className="artifact-empty">No downloadable files were requested for this task.</p>}{task.status === 'completed' && available.length > 0 && <div className="artifact-request"><span>{available.map((format) => <label key={format}><input type="checkbox" checked={formats.includes(format)} onChange={(event) => setFormats((current) => event.target.checked ? [...current, format] : current.filter((item) => item !== format))}/>{format.toUpperCase()}</label>)}</span><button className="button" disabled={!formats.length || requestFiles.isPending || outputDocumentQuery.isLoading || Boolean(outputDocumentQuery.error)} onClick={() => requestFiles.mutate()}>{requestFiles.isPending ? <LoaderCircle className="spin" size={14}/> : <Download size={14}/>} {outputDocument ? 'Regenerate selected' : 'Generate selected'}</button></div>}{htmlPreview && <HtmlArtifactPreview title={htmlPreview.title} html={htmlPreview.html} close={() => setHtmlPreview(null)}/>}</section>;
}
