import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bot, CheckCircle2, Download, Edit3, FileOutput, GitBranch, LoaderCircle, Play, Plus, RefreshCw, Repeat2, Save, ShieldCheck, Split, Trash2, Wrench, X, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, type Artifact, type ArtifactFormat, type Workflow, type WorkflowDefinition, type WorkflowNode } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { relative } from '../../lib/format';

type EditableNodeType = 'agent' | 'action' | 'condition' | 'approval' | 'loop';
type EdgeDraft = { source: string; target: string; condition: string };

const initialNodes = (): WorkflowNode[] => [
  { id: 'trigger-1', type: 'trigger', config: { event: 'manual' } },
  { id: 'output-1', type: 'output', config: { artifactFormats: [] } },
];
const initialEdges = () => [{ source: 'trigger-1', target: 'output-1' }];

function idFor(type: WorkflowNode['type']) {
  return `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function parseValue(value: string) {
  try { return JSON.parse(value); } catch { return value; }
}

function configFor(type: EditableNodeType, agentId: string, toolId: string): Record<string, unknown> {
  if (type === 'agent') return { agentId, responsibility: '', expectedOutput: 'Markdown', retry: { maxAttempts: 1, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 } };
  if (type === 'action') return { toolId, input: {}, retry: { maxAttempts: 1, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 } };
  if (type === 'condition') return { path: 'input.approved', operator: 'equals', value: true };
  if (type === 'loop') return { mode: 'forEach', collectionPath: 'input.items', itemVariable: 'item', indexVariable: 'index', maxIterations: 10, onLimit: 'fail' };
  return { prompt: 'Review this workflow step before it continues.' };
}

export function WorkflowsPage() {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nodes, setNodes] = useState<WorkflowNode[]>(initialNodes);
  const [edges, setEdges] = useState<WorkflowDefinition['edges']>(initialEdges);
  const [nodeType, setNodeType] = useState<EditableNodeType>('agent');
  const [selectedAgent, setSelectedAgent] = useState(data.agents.find((agent) => agent.status === 'active')?.id ?? '');
  const [selectedTool, setSelectedTool] = useState(data.tools.find((tool) => tool.enabled)?.id ?? '');
  const [selectedNodeId, setSelectedNodeId] = useState('trigger-1');
  const [edgeDraft, setEdgeDraft] = useState<EdgeDraft>({ source: 'trigger-1', target: 'output-1', condition: '' });
  const [runTarget, setRunTarget] = useState<Workflow | null>(null);
  const [runInput, setRunInput] = useState('{}');
  const [runId, setRunId] = useState('');
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0];

  const reset = () => {
    setEditingId(null); setName(''); setDescription(''); setNodes(initialNodes()); setEdges(initialEdges()); setSelectedNodeId('trigger-1');
  };
  const save = useMutation({
    mutationFn: () => {
      if (name.trim().length < 2) throw new Error('Workflow name needs at least 2 characters.');
      const body = { name: name.trim(), description: description.trim(), definition: { nodes, edges }, enabled: true };
      return editingId ? api.updateWorkflow(editingId, body) : api.createWorkflow(body);
    },
    onSuccess: async () => { report(editingId ? 'Workflow updated and validated' : 'Workflow saved and validated'); reset(); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not save workflow'),
  });
  const run = useMutation({
    mutationFn: () => {
      if (!runTarget) throw new Error('Choose a workflow.');
      const parsed = JSON.parse(runInput || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Workflow input must be a JSON object.');
      return api.runWorkflow(runTarget.id, parsed);
    },
    onSuccess: async (result) => { setRunId(result.id); setRunTarget(null); report('Workflow run queued'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not run workflow'),
  });
  const runDetail = useQuery({
    queryKey: ['workflow-run', runId], queryFn: () => api.workflowRun(runId), enabled: Boolean(runId),
    refetchInterval: (query) => {
      const detail = query.state.data;
      return ['queued', 'running', 'awaiting_approval'].includes(detail?.status ?? '') || detail?.artifacts?.some((item) => !['ready', 'failed', 'skipped'].includes(item.status)) ? 2_000 : false;
    },
  });
  const decide = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: 'approved' | 'rejected' }) => api.decideWorkflowApproval(runId, approvalId, decision),
    onSuccess: async (_, variables) => { report(`Workflow ${variables.decision}`); await runDetail.refetch(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not resolve approval'),
  });

  const addNode = () => {
    if (nodeType === 'agent' && !selectedAgent) return reportError('Choose an active agent first.');
    if (nodeType === 'action' && !selectedTool) return reportError('Choose an enabled tool first.');
    const node: WorkflowNode = { id: idFor(nodeType), type: nodeType, config: configFor(nodeType, selectedAgent, selectedTool) };
    setNodes((current) => [...current.slice(0, -1), node, current[current.length - 1]]);
    if (nodes.length === 2 && edges.length === 1 && edges[0].source === 'trigger-1' && edges[0].target === 'output-1') {
      setEdges(nodeType === 'condition' || nodeType === 'loop' ? [{ source: 'trigger-1', target: node.id }] : [{ source: 'trigger-1', target: node.id }, { source: node.id, target: 'output-1' }]);
    }
    setSelectedNodeId(node.id);
    setEdgeDraft({ source: node.id, target: 'output-1', condition: '' });
  };
  const removeNode = (id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
    setSelectedNodeId('trigger-1');
  };
  const updateConfig = (changes: Record<string, unknown>) => setNodes((current) => current.map((node) => node.id === selectedNode.id ? { ...node, config: { ...node.config, ...changes } } : node));
  const addEdge = () => {
    if (!edgeDraft.source || !edgeDraft.target || edgeDraft.source === edgeDraft.target) return reportError('Choose two different nodes.');
    const source = nodes.find((node) => node.id === edgeDraft.source);
    const condition = edgeDraft.condition || undefined;
    if (source?.type === 'condition' && !['true', 'false'].includes(condition ?? '')) return reportError('Condition edges must be true or false.');
    if (source?.type === 'loop' && !['body', 'done'].includes(condition ?? '')) return reportError('Loop edges must be body or done.');
    if (condition === 'continue' && nodes.find((node) => node.id === edgeDraft.target)?.type !== 'loop') return reportError('Continue edges must return to a loop node.');
    if (edges.some((edge) => edge.source === edgeDraft.source && edge.target === edgeDraft.target && edge.condition === condition)) return reportError('That edge already exists.');
    setEdges((current) => [...current, { source: edgeDraft.source, target: edgeDraft.target, ...(condition ? { condition } : {}) }]);
  };
  const loadWorkflow = (workflow: Workflow) => {
    setEditingId(workflow.id); setName(workflow.name); setDescription(workflow.description); setNodes(workflow.definition.nodes); setEdges(workflow.definition.edges); setSelectedNodeId(workflow.definition.nodes[0]?.id ?? ''); window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const validationHints = useMemo(() => {
    const hints: string[] = [];
    if (nodes.some((node) => node.type === 'condition')) hints.push('Conditions require true and false edges.');
    if (nodes.some((node) => node.type === 'loop')) hints.push('Loops require body, done and a body continue edge.');
    return hints;
  }, [nodes]);

  return <div className="workflow-page">
    <PageHeader eyebrow="Automation" title="Workflow Designer" description="Author resumable branches, bounded loops, retry policies, approvals and downloadable outputs." actions={<>{editingId && <button className="button" onClick={reset}><X size={14}/>Cancel edit</button>}<button className="button primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>} {editingId ? 'Update workflow' : 'Save workflow'}</button></>}/>
    <div className="workflow-meta panel"><label>Workflow name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer feedback processor"/></label><label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What outcome does this workflow produce?"/></label></div>
    <div className="workflow-layout advanced">
      <aside className="node-library panel"><span className="eyebrow">Node library</span><h2>Add a control or work node</h2><p>Nodes and edges are validated as a deterministic graph before save.</p><label>Node type<select value={nodeType} onChange={(event) => setNodeType(event.target.value as EditableNodeType)}><option value="agent">Agent</option><option value="action">Tool action</option><option value="condition">True/false branch</option><option value="loop">Controlled loop</option><option value="approval">Human approval</option></select></label>{nodeType === 'agent' && <label>Active agent<select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}><option value="">Choose agent</option>{data.agents.filter((agent) => agent.status === 'active').map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>}{nodeType === 'action' && <label>Enabled tool<select value={selectedTool} onChange={(event) => setSelectedTool(event.target.value)}><option value="">Choose tool</option>{data.tools.filter((tool) => tool.enabled).map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></label>}<button className="button" onClick={addNode}><Plus size={15}/>Add node</button><div className="validation-note"><ShieldCheck size={17}/><span><strong>Safety bounds</strong>Retries stop after five attempts, loops after 100 iterations, and arbitrary cycles remain invalid. Write-capable tools require a directly preceding human approval and cannot auto-retry.</span></div>{validationHints.map((hint) => <p className="inline-warning" key={hint}>{hint}</p>)}</aside>
      <section className="workflow-canvas advanced panel"><div className="dot-grid"/><div className="graph-node-grid">{nodes.map((node) => <button type="button" className={`workflow-node ${node.type} ${selectedNodeId === node.id ? 'selected' : ''}`} key={node.id} onClick={() => setSelectedNodeId(node.id)}><span>{nodeIcon(node.type)}<small>{node.type}</small>{!['trigger', 'output'].includes(node.type) && <i role="button" tabIndex={0} onClick={(event) => { event.stopPropagation(); removeNode(node.id); }}><Trash2 size={12}/></i>}</span><strong>{nodeLabel(node, data.agents, data.tools)}</strong><small>{node.id}</small></button>)}</div><div className="graph-edges"><span className="eyebrow">Connections</span>{edges.length ? edges.map((edge, index) => <div key={`${edge.source}-${edge.target}-${edge.condition ?? index}`}><code>{edge.source}</code><ArrowRight size={13}/>{edge.condition && <b>{edge.condition}</b>}<code>{edge.target}</code><button className="icon-button" onClick={() => setEdges((current) => current.filter((_, item) => item !== index))}><X size={12}/></button></div>) : <p>No connections yet.</p>}</div></section>
      <aside className="workflow-inspector panel"><span className="eyebrow">Node inspector</span>{selectedNode && <NodeInspector node={selectedNode} nodes={nodes} agents={data.agents} tools={data.tools} update={updateConfig}/>}<div className="edge-builder"><h3>Add connection</h3><label>From<select value={edgeDraft.source} onChange={(event) => setEdgeDraft({ ...edgeDraft, source: event.target.value })}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label><label>To<select value={edgeDraft.target} onChange={(event) => setEdgeDraft({ ...edgeDraft, target: event.target.value })}>{nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label><label>Branch label<select value={edgeDraft.condition} onChange={(event) => setEdgeDraft({ ...edgeDraft, condition: event.target.value })}><option value="">Normal</option><option value="true">True</option><option value="false">False</option><option value="body">Loop body</option><option value="done">Loop done</option><option value="continue">Continue loop</option></select></label><button className="button" onClick={addEdge}><GitBranch size={14}/>Connect</button></div></aside>
    </div>
    <section className="saved-workflows panel"><div className="panel-header"><div><span className="eyebrow">Saved automation</span><h2>Workflows</h2></div></div>{data.workflows.length ? <div className="workflow-list">{data.workflows.map((workflow) => <div key={workflow.id}><span className="workflow-list-icon"><GitBranch size={18}/></span><span><strong>{workflow.name}</strong><small>{workflow.description || `${workflow.definition?.nodes?.length ?? 0} nodes`} · updated {relative(workflow.updated_at)}</small></span><Status value={workflow.enabled ? 'active' : 'paused'}/><button className="button" onClick={() => loadWorkflow(workflow)}><Edit3 size={13}/>Edit</button><button className="button primary" disabled={!workflow.enabled} onClick={() => { setRunTarget(workflow); setRunInput('{}'); }}><Play size={14}/>Prepare run</button></div>)}</div> : <EmptyState Icon={GitBranch} title="No saved workflows" text="Build the first graph above and save it."/>}</section>
    {runTarget && <section className="workflow-run-prep panel"><div><span className="eyebrow">Run input</span><h2>{runTarget.name}</h2><p>Provide a JSON object. For a for-each loop using <code>input.items</code>, include <code>{'{"items":[...]}'}</code>.</p></div><textarea value={runInput} onChange={(event) => setRunInput(event.target.value)} spellCheck={false}/><div><button className="button" onClick={() => setRunTarget(null)}>Cancel</button><button className="button primary" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? <LoaderCircle className="spin" size={14}/> : <Play size={14}/>}Run workflow</button></div></section>}
    {runId && <WorkflowRunPanel detail={runDetail.data} loading={runDetail.isLoading} refresh={() => void runDetail.refetch()} decide={(approvalId, decision) => decide.mutate({ approvalId, decision })} deciding={decide.isPending}/>} 
  </div>;
}

function NodeInspector({ node, nodes, agents, tools, update }: { node: WorkflowNode; nodes: WorkflowNode[]; agents: Array<{ id: string; name: string }>; tools: Array<{ id: string; name: string }>; update: (changes: Record<string, unknown>) => void }) {
  const retry = node.config.retry && typeof node.config.retry === 'object' ? node.config.retry as Record<string, unknown> : {};
  return <div className="node-config"><h2>{node.type} settings</h2><code>{node.id}</code>{node.type === 'agent' && <><label>Agent<select value={String(node.config.agentId ?? '')} onChange={(event) => update({ agentId: event.target.value })}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label>Responsibility<textarea value={String(node.config.responsibility ?? '')} onChange={(event) => update({ responsibility: event.target.value })}/></label><RetryEditor retry={retry} update={(value) => update({ retry: value })}/></>}{node.type === 'action' && <><label>Tool<select value={String(node.config.toolId ?? '')} onChange={(event) => update({ toolId: event.target.value })}>{tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></label><label>Input JSON<textarea value={JSON.stringify(node.config.input ?? {}, null, 2)} onChange={(event) => update({ input: parseValue(event.target.value) })}/></label><RetryEditor retry={retry} update={(value) => update({ retry: value })}/></>}{node.type === 'condition' && <ConditionEditor config={node.config} update={update}/>} {node.type === 'loop' && <LoopEditor config={node.config} update={update}/>} {node.type === 'approval' && <label>Approval prompt<textarea value={String(node.config.prompt ?? '')} onChange={(event) => update({ prompt: event.target.value })}/></label>}{node.type === 'output' && <><label>Return result from<select value={String(node.config.fromNodeId ?? '')} onChange={(event) => update({ fromNodeId: event.target.value || undefined })}><option value="">Entire workflow state</option>{nodes.filter((item) => item.id !== node.id && item.type !== 'trigger').map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label><fieldset><legend>Generate files</legend>{(['pdf', 'docx', 'pptx', 'xlsx'] as ArtifactFormat[]).map((format) => { const selected = Array.isArray(node.config.artifactFormats) && node.config.artifactFormats.includes(format); return <label className="check-row" key={format}><input type="checkbox" checked={selected} onChange={(event) => { const current = Array.isArray(node.config.artifactFormats) ? node.config.artifactFormats as ArtifactFormat[] : []; update({ artifactFormats: event.target.checked ? [...current, format] : current.filter((item) => item !== format) }); }}/><span>{format.toUpperCase()}</span></label>; })}</fieldset></>}</div>;
}

function RetryEditor({ retry, update }: { retry: Record<string, unknown>; update: (value: Record<string, unknown>) => void }) {
  const change = (key: string, value: number) => update({ ...retry, [key]: value });
  return <fieldset className="retry-editor"><legend>Retry policy</legend><label>Maximum attempts<input type="number" min="1" max="5" value={Number(retry.maxAttempts ?? 1)} onChange={(event) => change('maxAttempts', Number(event.target.value))}/></label><label>Initial delay (ms)<input type="number" min="0" max="60000" step="500" value={Number(retry.initialDelayMs ?? 1000)} onChange={(event) => change('initialDelayMs', Number(event.target.value))}/></label><label>Backoff multiplier<input type="number" min="1" max="4" step="0.5" value={Number(retry.multiplier ?? 2)} onChange={(event) => change('multiplier', Number(event.target.value))}/></label><label>Maximum delay (ms)<input type="number" min="0" max="300000" step="1000" value={Number(retry.maxDelayMs ?? 60000)} onChange={(event) => change('maxDelayMs', Number(event.target.value))}/></label></fieldset>;
}

function ConditionEditor({ config, update, prefix = '' }: { config: Record<string, unknown>; update: (changes: Record<string, unknown>) => void; prefix?: string }) {
  return <><label>{prefix}State path<input value={String(config.path ?? '')} onChange={(event) => update({ path: event.target.value })} placeholder="input.approved"/></label><label>Operator<select value={String(config.operator ?? 'equals')} onChange={(event) => update({ operator: event.target.value })}><option value="equals">Equals</option><option value="not_equals">Not equal</option><option value="greater_than">Greater than</option><option value="greater_or_equal">Greater or equal</option><option value="less_than">Less than</option><option value="less_or_equal">Less or equal</option><option value="contains">Contains</option><option value="exists">Exists</option><option value="not_exists">Does not exist</option></select></label>{!['exists', 'not_exists'].includes(String(config.operator)) && <label>Comparison value<input value={typeof config.value === 'string' ? config.value : JSON.stringify(config.value ?? '')} onChange={(event) => update({ value: parseValue(event.target.value) })}/></label>}</>;
}

function LoopEditor({ config, update }: { config: Record<string, unknown>; update: (changes: Record<string, unknown>) => void }) {
  const mode = String(config.mode ?? 'forEach');
  const condition = config.condition && typeof config.condition === 'object' ? config.condition as Record<string, unknown> : { path: 'input.continue', operator: 'equals', value: true };
  return <><label>Loop mode<select value={mode} onChange={(event) => update({ mode: event.target.value, ...(event.target.value === 'while' ? { condition } : {}) })}><option value="forEach">For each item</option><option value="while">While condition</option></select></label>{mode === 'forEach' ? <><label>Collection path<input value={String(config.collectionPath ?? '')} onChange={(event) => update({ collectionPath: event.target.value })} placeholder="input.items"/></label><label>Item variable<input value={String(config.itemVariable ?? 'item')} onChange={(event) => update({ itemVariable: event.target.value })}/></label><label>Index variable<input value={String(config.indexVariable ?? 'index')} onChange={(event) => update({ indexVariable: event.target.value })}/></label></> : <ConditionEditor prefix="While " config={condition} update={(changes) => update({ condition: { ...condition, ...changes } })}/>}<label>Maximum iterations<input type="number" min="1" max="100" value={Number(config.maxIterations ?? 10)} onChange={(event) => update({ maxIterations: Number(event.target.value) })}/></label><label>When limit is reached<select value={String(config.onLimit ?? 'fail')} onChange={(event) => update({ onLimit: event.target.value })}><option value="fail">Fail safely</option><option value="exit">Exit loop</option></select></label></>;
}

function WorkflowRunPanel({ detail, loading, refresh, decide, deciding }: { detail: Awaited<ReturnType<typeof api.workflowRun>> | undefined; loading: boolean; refresh: () => void; decide: (id: string, decision: 'approved' | 'rejected') => void; deciding: boolean }) {
  if (loading) return <section className="workflow-run panel"><p>Loading workflow trace…</p></section>;
  if (!detail) return null;
  return <section className="workflow-run panel"><div className="panel-header"><div><span className="eyebrow">Latest launched run</span><h2>Persisted run trace</h2></div><div><Status value={detail.status}/><button className="icon-button" onClick={refresh}><RefreshCw size={14}/></button></div></div>{detail.nodeStates?.length ? <div className="workflow-node-states">{detail.nodeStates.map((state) => <article key={state.id}><span>{nodeIconByStatus(state.status)}</span><span><strong>{state.node_id}</strong><small>{state.iteration_key} · attempt {state.attempt}</small></span><Status value={state.status}/></article>)}</div> : null}<div className="workflow-run-events">{detail.events?.map((event) => <div key={event.id}><time>{new Date(event.created_at).toLocaleTimeString()}</time><span><strong>{event.event_type.replaceAll('.', ' ')}</strong><small>{event.message}</small></span></div>)}</div>{detail.approvals?.filter((approval) => approval.status === 'pending').map((approval) => <div className="workflow-approval" key={approval.id}><span><strong>Approval required</strong><small>{approval.node_id}</small></span><button className="button danger" disabled={deciding} onClick={() => decide(approval.id, 'rejected')}>Reject</button><button className="button primary" disabled={deciding} onClick={() => decide(approval.id, 'approved')}>Approve</button></div>)}{detail.artifacts?.length ? <WorkflowArtifacts artifacts={detail.artifacts}/> : null}{detail.output !== undefined && <pre className="json-output">{JSON.stringify(detail.output, null, 2)}</pre>}</section>;
}

function WorkflowArtifacts({ artifacts }: { artifacts: Artifact[] }) {
  const { reportError } = useWorkspace();
  const open = async (artifact: Artifact) => {
    try { const file = await api.artifactFile(artifact.id, false); const url = URL.createObjectURL(file.blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60000); }
    catch (cause) { reportError(cause instanceof Error ? cause.message : 'Could not download artifact'); }
  };
  return <div className="workflow-artifacts"><h3>Generated files</h3>{artifacts.map((artifact) => <article key={artifact.id}><FileOutput size={16}/><span><strong>{artifact.filename}</strong><small>{artifact.status}</small></span><Status value={artifact.status}/>{artifact.status === 'ready' && <button className="icon-button" onClick={() => void open(artifact)}><Download size={14}/></button>}</article>)}</div>;
}

function nodeLabel(node: WorkflowNode, agents: Array<{ id: string; name: string }>, tools: Array<{ id: string; name: string }>) {
  if (node.type === 'trigger') return 'Manual trigger';
  if (node.type === 'output') return 'Return output';
  if (node.type === 'agent') return agents.find((item) => item.id === node.config.agentId)?.name ?? 'Agent';
  if (node.type === 'action') return tools.find((item) => item.id === node.config.toolId)?.name ?? 'Tool action';
  if (node.type === 'condition') return `${String(node.config.path ?? 'state')} ${String(node.config.operator ?? 'equals')}`;
  if (node.type === 'loop') return `${String(node.config.mode ?? 'forEach')} · max ${String(node.config.maxIterations ?? 10)}`;
  return 'Human approval';
}

function nodeIcon(type: WorkflowNode['type']) {
  if (type === 'trigger') return <Zap size={16}/>;
  if (type === 'agent') return <Bot size={16}/>;
  if (type === 'action') return <Wrench size={16}/>;
  if (type === 'condition') return <Split size={16}/>;
  if (type === 'loop') return <Repeat2 size={16}/>;
  if (type === 'approval') return <ShieldCheck size={16}/>;
  return <FileOutput size={16}/>;
}

function nodeIconByStatus(status: string) {
  return ['failed'].includes(status) ? <X size={14}/> : ['running', 'retrying'].includes(status) ? <LoaderCircle className="spin" size={14}/> : <CheckCircle2 size={14}/>;
}
