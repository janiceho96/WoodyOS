import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Download, Eye, FileArchive, FileSpreadsheet, FileText, LoaderCircle, Play, Presentation, RefreshCw, Square, TerminalSquare, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useSearchParams } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { api, type Artifact, type ArtifactFormat, type TaskDetail } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { compact, duration, relative, taskCost } from '../../lib/format';

export function ExecutionPage({ openTask }: { openTask: () => void }) {
  const { data, reportError } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('all');
  const taskId = params.get('task');
  const agentId = params.get('agent');
  const detail = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId!), enabled: Boolean(taskId), refetchInterval: (query) => {
    const task = query.state.data as TaskDetail | undefined;
    return ['queued', 'running', 'awaiting_approval'].includes(task?.status ?? '') || task?.artifacts?.some((artifact) => artifact.status !== 'ready' && artifact.status !== 'failed') ? 2_500 : false;
  } });
  useEffect(() => { if (detail.error) reportError(detail.error instanceof Error ? detail.error.message : 'Could not open execution'); }, [detail.error]);
  const filtered = data.tasks.filter((task) => (!agentId || task.agent_id === agentId) && (filter === 'all' || task.status === filter));
  const totalCost = taskCost(filtered);
  return <div className="execution-page">
    <PageHeader eyebrow="Observability" title="Execution Monitor" description="Real task status, event traces, output, errors, runtime, and cost." actions={<><span className="cost-pill">{totalCost.available ? `${totalCost.label} total` : 'Pricing unavailable'}</span><button className="button primary" onClick={openTask}><Play size={15}/>Run task</button></>}/>
    <div className="execution-layout">
      <section className="panel run-list">
        <div className="panel-header"><h2>Recent runs</h2><select aria-label="Filter executions" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All statuses</option><option value="running">Running</option><option value="queued">Queued</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></div>
        {filtered.length ? <div>{filtered.map((task) => <button className={taskId === task.id ? 'active' : ''} key={task.id} onClick={() => setParams({ task: task.id })}><div><strong>{task.title}</strong><Status value={task.status}/></div><small>{task.agent_name ?? 'AI Agent'} · {relative(task.created_at)}</small><span><small>{taskCost([task]).label}</small>{detail.isFetching && taskId === task.id && <LoaderCircle size={13} className="spin"/>}</span></button>)}</div> : <EmptyState Icon={Activity} title="No executions found" text={data.tasks.length ? 'No runs match this status or agent filter.' : 'Run a task to start the execution timeline.'} action={!data.tasks.length && <button className="button primary" onClick={openTask}>Run task</button>}/>}
      </section>
      <section className="panel trace-panel">{detail.data ? <ExecutionDetail task={detail.data} refresh={() => void detail.refetch()}/> : detail.isLoading ? <EmptyState Icon={LoaderCircle} title="Loading execution" text="Retrieving the event timeline and output."/> : <EmptyState Icon={TerminalSquare} title="Select an execution" text="Choose a run to inspect its event timeline and rendered output."/>}</section>
    </div>
  </div>;
}

function ExecutionDetail({ task, refresh }: { task: TaskDetail; refresh: () => void }) {
  const queryClient = useQueryClient();
  const { report, reportError } = useWorkspace();
  const cancel = useMutation({
    mutationFn: () => api.cancelTask(task.id),
    onSuccess: async () => { report('Task cancelled'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); await queryClient.invalidateQueries({ queryKey: ['task', task.id] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not cancel task'),
  });
  const cancellable = ['queued', 'running', 'awaiting_approval'].includes(task.status);
  const cost = taskCost([task], 5);
  return <div className="execution-detail">
    <div className="trace-head"><div><span className="eyebrow">trace:{task.id.slice(0, 8)}</span><h2>{task.title}</h2><p>{task.agent_name ?? 'AI Agent'} · created {new Date(task.created_at).toLocaleString()}</p></div><div><Status value={task.status}/><button className="icon-button" onClick={refresh} aria-label="Refresh execution"><RefreshCw size={16}/></button>{cancellable && <button className="button danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}><Square size={13}/>Cancel</button>}</div></div>
    <div className="execution-stats"><span><small>Duration</small><strong>{task.duration_ms ? duration(task.duration_ms) : '—'}</strong></span><span><small>Input tokens</small><strong>{compact(task.token_input ?? 0)}</strong></span><span><small>Output tokens</small><strong>{compact(task.token_output ?? 0)}</strong></span><span><small>Cost</small><strong>{cost.label}</strong></span></div>
    <div className="trace-timeline"><h3>Event timeline</h3>{task.events.length ? task.events.map((event) => <div key={event.id}><i/><time>{new Date(event.created_at).toLocaleTimeString()}</time><span><strong>{event.event_type.replaceAll('.', ' ')}</strong><p>{event.message}</p>{event.payload && Object.keys(event.payload).length > 0 && <code>{JSON.stringify(event.payload)}</code>}</span></div>) : <p>No events recorded yet.</p>}</div>
    {(task.output !== null && task.output !== undefined) && <section className="output-section"><h3>Agent result</h3><OutputViewer value={task.output}/></section>}
    <ArtifactPanel task={task} refresh={refresh}/>
    {(task.error !== null && task.error !== undefined) && <section className="output-section error"><h3>Execution error</h3><OutputViewer value={task.error} error/></section>}
    {task.status === 'completed' && (task.output === null || task.output === undefined) && <section className="output-section"><h3>Agent result</h3><p>This task completed without an output payload.</p></section>}
  </div>;
}

function outputText(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') return (value as { text: string }).text;
  return null;
}

function OutputViewer({ value, error = false }: { value: unknown; error?: boolean }) {
  const text = outputText(value);
  return text !== null ? <div className={`markdown-output ${error ? 'error-output' : ''}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div> : <pre className={`json-output ${error ? 'error-output' : ''}`}>{JSON.stringify(value, null, 2)}</pre>;
}

export function TaskDialogBody({ close }: { close: () => void }) {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: api.createTask,
    onSuccess: async () => { report('Task queued for execution'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); close(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not queue task'),
  });
  const agents = data.agents.filter((agent) => agent.status === 'active');
  const send = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const artifactFormats = (['pdf', 'docx', 'pptx', 'xlsx'] as ArtifactFormat[]).filter((format) => form.get(`artifact-${format}`) === 'on');
    mutation.mutate({ agentId: String(form.get('agentId')), title: String(form.get('title')), input: { request: String(form.get('request')) }, artifactFormats });
  };
  return <form className="form-grid" onSubmit={send}><label>Active agent<select name="agentId" required><option value="">Choose an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} — {agent.role}</option>)}</select></label><label>Task title<input name="title" required minLength={2} maxLength={300} placeholder="Research current market"/></label><label>Desired outcome<textarea name="request" required placeholder="Describe exactly what the agent should deliver."/></label><fieldset className="artifact-format-picker"><legend>Downloadable output <small>Optional</small></legend><p>Woody keeps the Markdown result and generates selected files after the task completes.</p><div>{(['pdf', 'docx', 'pptx', 'xlsx'] as ArtifactFormat[]).map((format) => <label key={format}><input type="checkbox" name={`artifact-${format}`}/><span>{artifactIcon(format)}<strong>{format.toUpperCase()}</strong></span></label>)}</div></fieldset>{!agents.length && <div className="inline-error"><AlertTriangle size={15}/>Create and deploy an active agent first.</div>}<div className="form-actions"><button className="button" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={!agents.length || mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15}/> : <Play size={15}/>}Queue task</button></div></form>;
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

function ArtifactPanel({ task, refresh }: { task: TaskDetail; refresh: () => void }) {
  const { session, report, reportError } = useWorkspace();
  const canDelete = !session.workspace.role || ['owner', 'admin'].includes(session.workspace.role);
  const [formats, setFormats] = useState<ArtifactFormat[]>([]);
  const requestFiles = useMutation({
    mutationFn: () => api.requestArtifacts({ taskId: task.id, formats }),
    onSuccess: async () => { report('Artifact generation requested'); setFormats([]); refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not request artifacts'),
  });
  const remove = useMutation({
    mutationFn: api.deleteArtifact,
    onSuccess: () => { report('Artifact deleted'); refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not delete artifact'),
  });
  const openArtifact = async (artifact: Artifact, inline: boolean) => {
    const pendingTab = inline ? window.open('', '_blank', 'noopener,noreferrer') : null;
    try {
      const file = await api.artifactFile(artifact.id, inline);
      const url = URL.createObjectURL(file.blob);
      if (inline && pendingTab) pendingTab.location.href = url;
      else {
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      pendingTab?.close();
      reportError(cause instanceof Error ? cause.message : 'Could not open artifact');
    }
  };
  const existing = new Set((task.artifacts ?? []).filter((artifact) => artifact.status !== 'failed').map((artifact) => artifact.format));
  const available = (['pdf', 'docx', 'pptx', 'xlsx'] as ArtifactFormat[]).filter((format) => !existing.has(format));
  if (!task.artifacts?.length && task.status !== 'completed') return null;
  return <section className="artifact-section"><div className="section-title"><div><h3>Downloadable files</h3><small>Generated from the recorded agent result</small></div><button className="icon-button" onClick={refresh} aria-label="Refresh artifacts"><RefreshCw size={14}/></button></div>{task.artifacts?.length ? <div className="artifact-list">{task.artifacts.map((artifact) => <article key={artifact.id}><span className={`artifact-icon ${artifact.format}`}>{artifactIcon(artifact.format)}</span><span><strong>{artifact.filename}</strong><small>{artifact.format.toUpperCase()} · {artifact.status === 'ready' ? bytes(artifact.size_bytes) : artifact.status.replaceAll('_', ' ')}</small>{artifact.error_message && <em>{artifact.error_message}</em>}</span><Status value={artifact.status}/>{artifact.status === 'ready' && artifact.format === 'pdf' && <button className="icon-button" title="Preview PDF" onClick={() => void openArtifact(artifact, true)}><Eye size={15}/></button>}{artifact.status === 'ready' && <button className="icon-button" title={`Download ${artifact.filename}`} onClick={() => void openArtifact(artifact, false)}><Download size={15}/></button>}{canDelete && <button className="icon-button danger" title="Delete artifact" disabled={remove.isPending} onClick={() => remove.mutate(artifact.id)}><Trash2 size={14}/></button>}</article>)}</div> : <p className="artifact-empty">No downloadable files were requested for this task.</p>}{task.status === 'completed' && available.length > 0 && <div className="artifact-request"><span>{available.map((format) => <label key={format}><input type="checkbox" checked={formats.includes(format)} onChange={(event) => setFormats((current) => event.target.checked ? [...current, format] : current.filter((item) => item !== format))}/>{format.toUpperCase()}</label>)}</span><button className="button" disabled={!formats.length || requestFiles.isPending} onClick={() => requestFiles.mutate()}>{requestFiles.isPending ? <LoaderCircle className="spin" size={14}/> : <Download size={14}/>}Generate selected</button></div>}</section>;
}
