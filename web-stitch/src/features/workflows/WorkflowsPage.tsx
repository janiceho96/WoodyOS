import type { Connection } from '@xyflow/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Blocks, Bot, BrainCircuit, CheckCircle2, Download, Edit3, Eye, FileOutput, GitBranch, Globe2, LoaderCircle, LockKeyhole, Play, Plus, RefreshCw, Rocket, Save, Search, ShieldCheck, TestTube2, Trash2, Wrench, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Artifact, type Workflow, type WorkflowDefinition, type WorkflowDryRun, type WorkflowEditorLayout, type WorkflowNode, type WorkflowNodeCatalogEntry, type WorkflowRegressionCase, type WorkflowResources, type WorkflowRun } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { OutputViewer } from '../../components/OutputViewer';
import { groupInspectorFields, inspectorSectionLabels, type InspectorSection } from './NodeInspector';
import { mutateWorkflowEdge } from './WorkflowEdge';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { compact, duration, money, relative } from '../../lib/format';
import { failureGuidance } from '../../lib/recovery';
import { WorkflowCanvas } from './WorkflowCanvas';
import { autoLayoutPositions } from './workflowLayout';

type PositionRecord = { nodeId: string; x: number; y: number };
type GraphSnapshot = { nodes: WorkflowNode[]; edges: WorkflowDefinition['edges']; positions: PositionRecord[] };

const initialNodes = (): WorkflowNode[] => [
  { id: 'trigger-1', type: 'trigger', config: { event: 'manual' } },
  { id: 'output-1', type: 'output', config: { artifactFormats: [] } },
];
const initialEdges = (): WorkflowDefinition['edges'] => [{ source: 'trigger-1', target: 'output-1' }];
const initialPositions = () => autoLayoutPositions(initialNodes(), initialEdges());
const emptyResources: WorkflowResources = { version: 1, agents: [], apiTools: [], mcpTools: [], knowledge: { scope: 'workspace', total: 0, ready: 0, processing: 0, failed: 0 } };

function idFor(type: WorkflowNode['type']) {
  return `${type.replaceAll('_', '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function parseValue(value: string) {
  try { return JSON.parse(value); } catch { return value; }
}

function configFor(type: WorkflowNode['type'], resources: WorkflowResources): Record<string, unknown> {
  if (type === 'agent') return { agentId: resources.agents[0]?.id ?? '', responsibility: '', expectedOutput: 'Markdown', retry: { maxAttempts: 1, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 } };
  if (type === 'action') return { toolId: resources.apiTools[0]?.id ?? '', input: {}, retry: { maxAttempts: 1, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 60000 } };
  if (type === 'api_action') return { toolId: resources.apiTools[0]?.id ?? '', input: {} };
  if (type === 'mcp_action') return { agentId: resources.mcpTools[0]?.agentId ?? '', mcpToolId: resources.mcpTools[0]?.id ?? '', input: {} };
  if (type === 'knowledge_search') return { query: '{{ input.query }}', limit: 8 };
  if (type === 'condition') return { path: 'input.approved', operator: 'equals', value: true };
  if (type === 'loop') return { mode: 'forEach', collectionPath: 'input.items', itemVariable: 'item', indexVariable: 'index', maxIterations: 10, onLimit: 'fail' };
  if (type === 'approval') return { prompt: 'Review this workflow step before it continues.' };
  return {};
}

function cloneSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  return {
    nodes: snapshot.nodes.map((node) => ({ ...node, config: structuredClone(node.config) })),
    edges: snapshot.edges.map((edge) => ({ ...edge })),
    positions: snapshot.positions.map((position) => ({ ...position })),
  };
}

export function WorkflowsPage() {
  const { data, report, reportError } = useWorkspace();
  const queryClient = useQueryClient();
  const editorShellRef = useRef<HTMLDivElement>(null);
  const catalogQuery = useQuery({ queryKey: ['workflow-node-catalog'], queryFn: api.workflowNodeCatalog });
  const resourcesQuery = useQuery({ queryKey: ['workflow-resources'], queryFn: api.workflowResources });
  const catalog = useMemo(() => catalogQuery.data?.data ?? [], [catalogQuery.data]);
  const resources = resourcesQuery.data ?? emptyResources;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loadingWorkflowId, setLoadingWorkflowId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nodes, setNodes] = useState<WorkflowNode[]>(initialNodes);
  const [edges, setEdges] = useState<WorkflowDefinition['edges']>(initialEdges);
  const [positions, setPositions] = useState<PositionRecord[]>(initialPositions);
  const [viewport, setViewport] = useState<WorkflowEditorLayout['viewport']>({ x: 0, y: 0, zoom: 1 });
  const [selectedNodeId, setSelectedNodeId] = useState('trigger-1');
  const [paletteSearch, setPaletteSearch] = useState('');
  const [simpleMode, setSimpleMode] = useState(true);
  const [qualityWorkerId, setQualityWorkerId] = useState('');
  const [qualityGraderId, setQualityGraderId] = useState('');
  const [qualityRevisionStrategy, setQualityRevisionStrategy] = useState<'same_worker' | 'dedicated_agent'>('same_worker');
  const [qualityRevisionAgentId, setQualityRevisionAgentId] = useState('');
  const [qualityMaximumRevisions, setQualityMaximumRevisions] = useState(3);
  const [qualityPassingScore, setQualityPassingScore] = useState(80);
  const [qualityOnLimit, setQualityOnLimit] = useState<'return_best' | 'human_review' | 'fail'>('human_review');
  const [inspectorOpen, setInspectorOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 820);
  const [past, setPast] = useState<GraphSnapshot[]>([]);
  const [future, setFuture] = useState<GraphSnapshot[]>([]);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [savedWorkflow, setSavedWorkflow] = useState<Workflow | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(true);
  const [testedRevision, setTestedRevision] = useState<number | null>(null);
  const [runTarget, setRunTarget] = useState<Workflow | null>(null);
  const [runMode, setRunMode] = useState<'test' | 'production' | 'dry-run'>('production');
  const [testTargetNodeId, setTestTargetNodeId] = useState<string | null>(null);
  const [runInput, setRunInput] = useState('{}');
  const [runId, setRunId] = useState('');
  const [dryRunResult, setDryRunResult] = useState<WorkflowDryRun | null>(null);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? nodes[0];
  const selectedDefinition = catalog.find((entry) => entry.type === selectedNode?.type);
  useEffect(() => {
    if (!resources.agents.length) return;
    setQualityWorkerId((value) => value || resources.agents[0].id);
    setQualityGraderId((value) => value || resources.agents[Math.min(1, resources.agents.length - 1)].id);
    setQualityRevisionAgentId((value) => value || resources.agents[Math.min(2, resources.agents.length - 1)].id);
  }, [resources.agents]);

  const snapshot = useCallback(() => cloneSnapshot({ nodes, edges, positions }), [nodes, edges, positions]);
  const commit = useCallback((next: GraphSnapshot) => {
    setPast((current) => [...current, snapshot()].slice(-50));
    setFuture([]);
    const cloned = cloneSnapshot(next);
    setNodes(cloned.nodes); setEdges(cloned.edges); setPositions(cloned.positions);
    setHasUnsavedChanges(true);
  }, [snapshot]);
  const undo = () => {
    const previous = past.at(-1); if (!previous) return;
    setFuture((current) => [snapshot(), ...current].slice(0, 50));
    setPast((current) => current.slice(0, -1));
    const restored = cloneSnapshot(previous); setNodes(restored.nodes); setEdges(restored.edges); setPositions(restored.positions); setHasUnsavedChanges(true);
  };
  const redo = () => {
    const next = future[0]; if (!next) return;
    setPast((current) => [...current, snapshot()].slice(-50));
    setFuture((current) => current.slice(1));
    const restored = cloneSnapshot(next); setNodes(restored.nodes); setEdges(restored.edges); setPositions(restored.positions); setHasUnsavedChanges(true);
  };
  const reset = () => {
    const freshNodes = initialNodes(); const freshEdges = initialEdges();
    setEditingId(null); setSavedWorkflow(null); setName(''); setDescription(''); setNodes(freshNodes); setEdges(freshEdges); setPositions(autoLayoutPositions(freshNodes, freshEdges)); setViewport({ x: 0, y: 0, zoom: 1 }); setSelectedNodeId('trigger-1'); setPast([]); setFuture([]); setTestedRevision(null); setHasUnsavedChanges(true); setCanvasRevision((value) => value + 1);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (name.trim().length < 2) throw new Error('Workflow name needs at least 2 characters.');
      const body = { name: name.trim(), description: description.trim(), definition: { nodes, edges }, ...(editingId ? {} : { enabled: false }) };
      const saved = editingId ? await api.updateWorkflow(editingId, body) : await api.createWorkflow(body);
      const completePositions = nodes.map((node, index) => positions.find((position) => position.nodeId === node.id) ?? { nodeId: node.id, x: 50 + index * 285, y: 280 });
      try { await api.saveWorkflowLayout(saved.id, { schemaVersion: 1, positions: completePositions, viewport }); }
      catch (error) { throw new Error(`${editingId ? 'Workflow changes were saved' : 'Workflow was created'}, but the canvas layout could not be saved: ${error instanceof Error ? error.message : 'unknown layout error'}`); }
      return saved;
    },
    onSuccess: async (saved) => { setEditingId(saved.id); setSavedWorkflow(saved); setHasUnsavedChanges(false); setTestedRevision(saved.latest_test_revision === saved.draft_revision && saved.latest_test_status === 'completed' ? saved.draft_revision : null); report('Draft and canvas saved. Test this revision before publishing.'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not save workflow'),
  });
  const run = useMutation<WorkflowRun | WorkflowDryRun, Error>({
    mutationFn: () => {
      if (!runTarget) throw new Error('Choose a workflow.');
      const parsed = JSON.parse(runInput || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Workflow input must be a JSON object.');
      if (runMode === 'dry-run') return api.dryRunWorkflow(runTarget.id, parsed);
      if (runMode === 'test' && testTargetNodeId) return api.testWorkflowNode(runTarget.id, testTargetNodeId, parsed);
      return runMode === 'test' ? api.testWorkflow(runTarget.id, parsed) : api.runWorkflow(runTarget.id, parsed);
    },
    onSuccess: async (result) => { setRunTarget(null); if ('manifest' in result) { const preview = result as WorkflowDryRun; setDryRunResult(preview); report(preview.valid ? 'Dry run completed without executing the workflow.' : 'Dry run found workflow issues.'); return; } setRunId(result.id); report(runMode === 'test' ? 'Draft test queued' : 'Workflow run queued'); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not run workflow'),
  });
  const runDetail = useQuery({
    queryKey: ['workflow-run', runId], queryFn: () => api.workflowRun(runId), enabled: Boolean(runId),
    refetchInterval: (query) => {
      const detail = query.state.data;
      return ['queued', 'running', 'awaiting_approval'].includes(detail?.status ?? '') || detail?.artifacts?.some((item) => !['ready', 'failed', 'skipped'].includes(item.status)) ? 2_000 : false;
    },
  });
  useEffect(() => {
    if (runDetail.data?.run_mode === 'test' && !runDetail.data.test_target_node_id && runDetail.data.status === 'completed' && runDetail.data.draft_revision) {
      setTestedRevision(runDetail.data.draft_revision);
      void queryClient.invalidateQueries({ queryKey: ['workspace'] });
    }
  }, [queryClient, runDetail.data?.draft_revision, runDetail.data?.run_mode, runDetail.data?.status, runDetail.data?.test_target_node_id]);
  const publish = useMutation({
    mutationFn: () => {
      if (!editingId) throw new Error('Save the workflow draft first.');
      return api.publishWorkflow(editingId);
    },
    onSuccess: async (workflow) => { setSavedWorkflow(workflow); report(`Workflow version ${workflow.published_version ?? 1} published`); await queryClient.invalidateQueries({ queryKey: ['workspace'] }); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not publish workflow'),
  });
  const decide = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: 'approved' | 'rejected' }) => api.decideWorkflowApproval(runId, approvalId, decision),
    onSuccess: async (_, variables) => { report(`Workflow ${variables.decision}`); await runDetail.refetch(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not resolve approval'),
  });
  const decideAction = useMutation({
    mutationFn: ({ authorizationId, decision }: { authorizationId: string; decision: 'approved' | 'rejected' }) => api.decideWorkflowAction(authorizationId, decision),
    onSuccess: async (_, variables) => { report(`External action ${variables.decision}`); await runDetail.refetch(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not resolve action confirmation'),
  });

  const addNode = (type: WorkflowNode['type'], position?: { x: number; y: number }) => {
    if (['trigger', 'output'].includes(type)) return;
    const definition = catalog.find((entry) => entry.type === type);
    if (!definition?.available) return reportError(definition?.availabilityReason ?? 'That node is unavailable.');
    const config = configFor(type, resources);
    if (type === 'agent' && !config.agentId) return reportError('Create or activate an agent before adding an Agent node.');
    if (['action', 'api_action'].includes(type) && !config.toolId) return reportError('Connect an API tool before adding an API action.');
    if (type === 'mcp_action' && (!config.agentId || !config.mcpToolId)) return reportError('Assign an enabled MCP tool to an active agent before adding an App action.');
    const node: WorkflowNode = { id: idFor(type), type, config };
    const outputIndex = Math.max(1, nodes.findIndex((item) => item.type === 'output'));
    const nextNodes = [...nodes.slice(0, outputIndex), node, ...nodes.slice(outputIndex)];
    let nextEdges = edges;
    if (nodes.length === 2 && edges.length === 1 && edges[0].source === nodes[0].id && edges[0].target === nodes[1].id) {
      nextEdges = ['condition', 'loop'].includes(type) ? [{ source: nodes[0].id, target: node.id }] : [{ source: nodes[0].id, target: node.id }, { source: node.id, target: nodes[1].id }];
    }
    const nextPositions = [...positions, { nodeId: node.id, x: position?.x ?? 330, y: position?.y ?? 280 }];
    commit({ nodes: nextNodes, edges: nextEdges, positions: nextPositions });
    setSelectedNodeId(node.id);
    setInspectorOpen(true);
  };
  const removeNodes = (ids: string[]) => {
    const removable = new Set(ids.filter((id) => !['trigger', 'output'].includes(nodes.find((node) => node.id === id)?.type ?? '')));
    if (!removable.size) return;
    commit({ nodes: nodes.filter((node) => !removable.has(node.id)), edges: edges.filter((edge) => !removable.has(edge.source) && !removable.has(edge.target)), positions: positions.filter((position) => !removable.has(position.nodeId)) });
    setSelectedNodeId(nodes.find((node) => node.type === 'trigger')?.id ?? '');
  };
  const updateConfig = (changes: Record<string, unknown>) => {
    if (!selectedNode) return;
    commit({ nodes: nodes.map((node) => node.id === selectedNode.id ? { ...node, config: { ...node.config, ...changes } } : node), edges, positions });
  };
  const connect = (connection: Connection) => {
    const result = mutateWorkflowEdge({ nodes, edges, catalog, connection });
    if (result.error) return reportError(result.error);
    commit({ nodes, edges: result.edges, positions });
  };
  const reconnectEdge = (edge: WorkflowDefinition['edges'][number], connection: Connection) => {
    const result = mutateWorkflowEdge({ nodes, edges, catalog, connection, previous: edge });
    if (result.error) return reportError(result.error);
    commit({ nodes, edges: result.edges, positions });
  };
  const deleteEdges = (removed: WorkflowDefinition['edges']) => {
    commit({ nodes, edges: edges.filter((edge) => !removed.some((candidate) => candidate.source === edge.source && candidate.target === edge.target && candidate.condition === edge.condition)), positions });
  };
  const moveNode = (id: string, position: { x: number; y: number }) => commit({ nodes, edges, positions: [...positions.filter((item) => item.nodeId !== id), { nodeId: id, ...position }] });
  const autoLayout = () => commit({ nodes, edges, positions: autoLayoutPositions(nodes, edges) });
  const loadWorkflow = async (workflow: Workflow) => {
    setLoadingWorkflowId(workflow.id);
    try {
      const layout = await api.workflowLayout(workflow.id);
      setEditingId(workflow.id); setSavedWorkflow(workflow); setName(workflow.name); setDescription(workflow.description); setNodes(workflow.definition.nodes); setEdges(workflow.definition.edges); setPositions(layout.positions.length ? layout.positions : autoLayoutPositions(workflow.definition.nodes, workflow.definition.edges)); setViewport(layout.viewport); setSelectedNodeId(workflow.definition.nodes[0]?.id ?? ''); setInspectorOpen(window.innerWidth > 820); setPast([]); setFuture([]); setTestedRevision(workflow.latest_test_status === 'completed' && workflow.latest_test_revision === workflow.draft_revision ? workflow.draft_revision : null); setHasUnsavedChanges(false); setCanvasRevision((value) => value + 1); window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (cause) { reportError(cause instanceof Error ? cause.message : 'Could not load workflow canvas'); }
    finally { setLoadingWorkflowId(null); }
  };

  const palette = useMemo(() => {
    const simpleTypes = new Set<WorkflowNode['type']>(['agent', 'api_action', 'mcp_action', 'knowledge_search', 'approval']);
    const search = paletteSearch.trim().toLowerCase();
    return catalog.filter((entry) => !['trigger', 'output'].includes(entry.type) && (!simpleMode || simpleTypes.has(entry.type)) && (!search || `${entry.title} ${entry.description} ${entry.category}`.toLowerCase().includes(search)));
  }, [catalog, paletteSearch, simpleMode]);
  const qualityTemplate = useMutation({
    mutationFn: () => api.workflowQualityLoopTemplate({
      workerAgentId: qualityWorkerId,
      graderAgentId: qualityGraderId,
      revisionStrategy: qualityRevisionStrategy,
      ...(qualityRevisionStrategy === 'dedicated_agent' ? { revisionAgentId: qualityRevisionAgentId } : {}),
      maximumRevisions: qualityMaximumRevisions,
      passingScore: qualityPassingScore,
      onLimit: qualityOnLimit,
    }),
    onSuccess: (definition) => {
      commit({ nodes: definition.nodes, edges: definition.edges, positions: autoLayoutPositions(definition.nodes, definition.edges) });
      setSelectedNodeId('quality_loop');
      setSimpleMode(false);
      setInspectorOpen(true);
      report('Editable quality-review loop added. Review the agents, threshold, and limit behavior before testing.');
    },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not build the quality loop'),
  });
  const validation = useMemo(() => clientValidation(nodes, edges, catalog), [nodes, edges, catalog]);
  const activeNodeIds = useMemo(() => new Set(runDetail.data?.workflow_id === editingId ? runDetail.data.nodeStates?.filter((state) => ['running', 'waiting'].includes(state.status)).map((state) => state.node_id) ?? [] : []), [editingId, runDetail.data]);
  const labelFor = useCallback((node: WorkflowNode) => nodeLabel(node, resources, data.agents, data.tools), [resources, data.agents, data.tools]);
  const brandFor = useCallback((node: WorkflowNode) => {
    if (node.type !== 'mcp_action') return null;
    const tool = resources.mcpTools.find((item) => item.id === node.config.mcpToolId);
    if (!tool) return null;
    return { appId: tool.appId, title: tool.appTitle ?? tool.connectionName, color: tool.brandColor };
  }, [resources.mcpTools]);
  const agentFor = useCallback((node: WorkflowNode) => node.type === 'agent' ? resources.agents.find((agent) => agent.id === node.config.agentId) ?? null : null, [resources.agents]);
  const estimatedCalls = nodes.filter((node) => node.type === 'agent').length;
  const testedUsage = runDetail.data?.run_mode === 'test' && runDetail.data.status === 'completed' && runDetail.data.draft_revision === savedWorkflow?.draft_revision
    ? runDetail.data.usage
    : undefined;
  const selectedAgentNames = [...new Set(nodes.filter((node) => node.type === 'agent').map((node) => labelFor(node)))];
  const selectedApiToolNames = [...new Set(nodes.filter((node) => ['api_action', 'action'].includes(node.type)).map((node) => labelFor(node)))];
  const selectedMcpActionNames = [...new Set(nodes.filter((node) => node.type === 'mcp_action').map((node) => labelFor(node)))];
  const toggleEditorFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await editorShellRef.current?.requestFullscreen();
  }, []);
  const inspectorPanel = <aside className={`workflow-inspector panel ${inspectorOpen ? 'open' : ''}`} aria-label="Selected node inspector">
    <div className="inspector-panel-head"><span className="eyebrow">Inspector</span><button type="button" className="icon-button inspector-close" onClick={() => setInspectorOpen(false)} aria-label="Close node inspector"><X size={16}/></button></div>
    {selectedNode && selectedDefinition ? <SchemaNodeInspector node={selectedNode} definition={selectedDefinition} nodes={nodes} edges={edges} resources={resources} update={updateConfig} remove={() => removeNodes([selectedNode.id])}/> : <p>Select a node to configure it.</p>}
    {selectedNode && selectedNode.type !== 'trigger' && <button className="button node-test-button" disabled={!savedWorkflow || hasUnsavedChanges || run.isPending} onClick={() => { if (savedWorkflow) { setRunMode('test'); setTestTargetNodeId(selectedNode.id); setRunTarget(savedWorkflow); setRunInput('{}'); } }}><TestTube2 size={14}/>Test to this node</button>}
    <div className="workflow-review-summary"><h3>Pre-publish review</h3><ReviewLine label="Agents" value={selectedAgentNames.length ? selectedAgentNames.join(', ') : 'No agent calls'}/><ReviewLine label="Knowledge" value={nodes.some((node) => node.type === 'knowledge_search') ? `Workspace Knowledge · ${resources.knowledge.ready} ready` : 'Not used'}/><ReviewLine label="API Tools" value={selectedApiToolNames.length ? selectedApiToolNames.join(', ') : 'None'}/><ReviewLine label="MCP Actions" value={selectedMcpActionNames.length ? selectedMcpActionNames.join(', ') : 'None'}/><ReviewLine label="Usage" value={testedUsage ? `${compact(testedUsage.inputTokens + testedUsage.outputTokens)} tokens in latest test` : estimatedCalls ? `${estimatedCalls} model call${estimatedCalls === 1 ? '' : 's'} · test to measure tokens` : 'No model usage expected'}/><ReviewLine label="Cost" value={testedUsage ? testedUsage.estimatedCostUsd > 0 || testedUsage.inputTokens + testedUsage.outputTokens === 0 ? `$${money(testedUsage.estimatedCostUsd)} in latest test` : 'Pricing unavailable' : estimatedCalls ? 'Measured after a safe test' : '$0.0000 expected'}/><ReviewLine label="Confirmation" value={nodes.some((node) => ['api_action', 'mcp_action'].includes(node.type)) ? 'Risk checked for the final action' : 'No connected actions'}/>{validation.map((message) => <p className="inline-warning" key={message}>{message}</p>)}</div>
  </aside>;

  if (catalogQuery.isLoading || resourcesQuery.isLoading) return <div className="workflow-page"><PageHeader eyebrow="Automation" title="Workflow Designer" description="Loading the safe node catalog and connected resources…"/><section className="panel workflow-loading"><LoaderCircle className="spin" size={22}/>Preparing workflow tools</section></div>;
  if (catalogQuery.isError || resourcesQuery.isError) return <div className="workflow-page"><PageHeader eyebrow="Automation" title="Workflow Designer" description="The workflow foundation could not be loaded."/><section className="panel workflow-load-error"><AlertTriangle size={22}/><div><strong>Rebuild the Woody backend</strong><p>{catalogQuery.error?.message ?? resourcesQuery.error?.message ?? 'Workflow catalogs are unavailable.'}</p></div><button className="button" onClick={() => { void catalogQuery.refetch(); void resourcesQuery.refetch(); }}><RefreshCw size={14}/>Try again</button></section></div>;

  return <div className="workflow-page">
    <PageHeader eyebrow="Automation" title="Workflow Designer" description="Build a safe, resumable process by connecting agents, Knowledge and exact app actions." actions={<>{editingId && <button className="button" onClick={reset}><X size={14}/>Close draft</button>}<button className="button" onClick={() => save.mutate()} disabled={save.isPending || validation.length > 0 || name.trim().length < 2 || (!hasUnsavedChanges && Boolean(editingId))}>{save.isPending ? <LoaderCircle className="spin" size={15}/> : <Save size={15}/>}Save draft</button><button className="button" disabled={!savedWorkflow || hasUnsavedChanges || run.isPending} onClick={() => { if (savedWorkflow) { setRunMode('dry-run'); setTestTargetNodeId(null); setRunTarget(savedWorkflow); setRunInput('{}'); } }}><Search size={14}/>Dry run</button><button className="button" disabled={!savedWorkflow || hasUnsavedChanges || run.isPending} onClick={() => { if (savedWorkflow) { setRunMode('test'); setTestTargetNodeId(null); setRunTarget(savedWorkflow); setRunInput('{}'); } }}><TestTube2 size={14}/>Test draft</button><button className="button primary" disabled={!savedWorkflow || hasUnsavedChanges || testedRevision !== savedWorkflow.draft_revision || publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? <LoaderCircle className="spin" size={14}/> : <Rocket size={14}/>}Publish</button></>}/>
    <div className="workflow-lifecycle panel" aria-label="Workflow lifecycle"><span className={editingId ? 'complete' : 'active'}>1. Save draft</span><span className={testedRevision === savedWorkflow?.draft_revision ? 'complete' : editingId && !hasUnsavedChanges ? 'active' : ''}>2. Test</span><span className={savedWorkflow?.status === 'published' && !hasUnsavedChanges ? 'complete' : testedRevision === savedWorkflow?.draft_revision ? 'active' : ''}>3. Publish</span><span className={savedWorkflow?.status === 'published' ? 'active' : ''}>4. Run</span></div>
    <div className="workflow-meta panel"><label>Workflow name<input value={name} onChange={(event) => { setName(event.target.value); setHasUnsavedChanges(true); }} placeholder="Customer feedback processor"/></label><label>Outcome description<input value={description} onChange={(event) => { setDescription(event.target.value); setHasUnsavedChanges(true); }} placeholder="What outcome does this workflow produce?"/></label><div className="workflow-readiness"><Status value={validation.length ? 'needs attention' : hasUnsavedChanges ? 'draft' : savedWorkflow?.status ?? 'draft'}/><small>{validation.length ? `${validation.length} issue${validation.length === 1 ? '' : 's'} before save` : hasUnsavedChanges ? 'Save this draft before testing' : `${estimatedCalls} estimated model call${estimatedCalls === 1 ? '' : 's'} per straight path`}</small></div></div>
    <div className="workflow-editor-shell" ref={editorShellRef}>
      <div className="workflow-layout visual">
        <div className="workflow-side-dock">
          <aside className="node-library panel">
        <span className="eyebrow">Node library</span><h2>Drag work onto the canvas</h2><p>{simpleMode ? 'Common building blocks only. Switch to Advanced for branches, loops and legacy tools.' : 'All installed node types, including advanced control flow.'}</p>
        <div className="library-mode-switch" role="group" aria-label="Node library mode"><button type="button" className={simpleMode ? 'active' : ''} aria-pressed={simpleMode} onClick={() => setSimpleMode(true)}>Simple</button><button type="button" className={!simpleMode ? 'active' : ''} aria-pressed={!simpleMode} onClick={() => setSimpleMode(false)}>Advanced</button></div>
        {!simpleMode && resources.agents.length > 0 && <details className="quality-loop-builder"><summary>Build a quality-review loop</summary><label>Worker agent<select value={qualityWorkerId} onChange={(event) => setQualityWorkerId(event.target.value)}>{resources.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label><label>Grader agent<select value={qualityGraderId} onChange={(event) => setQualityGraderId(event.target.value)}>{resources.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label><label>Revision strategy<select value={qualityRevisionStrategy} onChange={(event) => setQualityRevisionStrategy(event.target.value as typeof qualityRevisionStrategy)}><option value="same_worker">Same worker</option><option value="dedicated_agent">Dedicated revision agent</option></select></label>{qualityRevisionStrategy === 'dedicated_agent' && <label>Revision agent<select value={qualityRevisionAgentId} onChange={(event) => setQualityRevisionAgentId(event.target.value)}>{resources.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select></label>}<div className="quality-loop-numbers"><label>Passing score<input type="number" min="0" max="100" value={qualityPassingScore} onChange={(event) => setQualityPassingScore(Number(event.target.value))}/></label><label>Maximum revisions<input type="number" min="0" max="99" value={qualityMaximumRevisions} onChange={(event) => setQualityMaximumRevisions(Number(event.target.value))}/></label></div><label>When limit is reached<select value={qualityOnLimit} onChange={(event) => setQualityOnLimit(event.target.value as typeof qualityOnLimit)}><option value="human_review">Request human review</option><option value="return_best">Return best result with warning</option><option value="fail">Fail workflow</option></select></label><button className="button primary" type="button" disabled={!qualityWorkerId || !qualityGraderId || qualityTemplate.isPending || (qualityRevisionStrategy === 'dedicated_agent' && !qualityRevisionAgentId)} onClick={() => qualityTemplate.mutate()}>{qualityTemplate.isPending ? <LoaderCircle className="spin" size={14}/> : <BrainCircuit size={14}/>}Build editable loop</button><small>This replaces the current canvas and can be undone.</small></details>}
        <label className="palette-search"><Search size={14}/><input value={paletteSearch} onChange={(event) => setPaletteSearch(event.target.value)} placeholder="Search nodes"/></label>
        <div className="node-palette">{palette.map((entry) => <button key={entry.type} type="button" draggable={entry.available} disabled={!entry.available} title={entry.available ? `Add ${entry.title}` : entry.availabilityReason} onDragStart={(event) => { event.dataTransfer.setData('application/woody-node', entry.type); event.dataTransfer.effectAllowed = 'move'; }} onClick={() => addNode(entry.type)}><span>{paletteIcon(entry.type)}</span><span><strong>{entry.title}</strong><small>{entry.available ? entry.description : entry.availabilityReason ?? entry.description}</small></span>{entry.available ? <Plus size={14}/> : <LockKeyhole size={13}/>}</button>)}</div>
        <div className="resource-summary"><span><Bot size={14}/><strong>{resources.agents.length}</strong> agents</span><span><Blocks size={14}/><strong>{resources.mcpTools.length}</strong> app actions</span><span><BrainCircuit size={14}/><strong>{resources.knowledge.ready}</strong> ready documents</span></div>
          </aside>
          {inspectorPanel}
        </div>
        <section className="workflow-canvas visual panel">
          <WorkflowCanvas key={`${editingId ?? 'new'}:${canvasRevision}`} nodes={nodes} edges={edges} positions={positions} viewport={viewport} catalog={catalog} selectedNodeId={selectedNodeId} activeNodeIds={activeNodeIds} simpleMode={simpleMode} canUndo={past.length > 0} canRedo={future.length > 0} inspectorOpen={inspectorOpen} labelFor={labelFor} brandFor={brandFor} agentFor={agentFor} onSelectNode={(id) => { setSelectedNodeId(id); setInspectorOpen(true); }} onMoveNode={moveNode} onViewportChange={(next) => { setViewport(next); }} onConnect={connect} onReconnectEdge={reconnectEdge} onDeleteNodes={removeNodes} onDeleteEdges={deleteEdges} onDropNode={addNode} onAutoLayout={autoLayout} onUndo={undo} onRedo={redo} onSetMode={setSimpleMode} onToggleInspector={() => setInspectorOpen((open) => !open)} onToggleFullscreen={toggleEditorFullscreen}/>
        </section>
      </div>
    </div>
    {savedWorkflow && <WorkflowEvaluationPanel workflow={savedWorkflow} report={report} reportError={reportError}/>}
    <section className="saved-workflows panel"><div className="panel-header"><div><span className="eyebrow">Saved automation</span><h2>Workflows</h2></div></div>{data.workflows.length ? <div className="workflow-list">{data.workflows.map((workflow) => <div key={workflow.id}><span className="workflow-list-icon"><GitBranch size={18}/></span><span><strong>{workflow.name}</strong><small>{workflow.description || `${workflow.definition?.nodes?.length ?? 0} nodes`} · draft r{workflow.draft_revision}{workflow.published_version ? ` · live v${workflow.published_version}` : ''} · updated {relative(workflow.updated_at)}</small></span><Status value={workflow.status}/><button className="button" disabled={loadingWorkflowId === workflow.id} onClick={() => void loadWorkflow(workflow)}>{loadingWorkflowId === workflow.id ? <LoaderCircle className="spin" size={13}/> : <Edit3 size={13}/>}Edit</button><button className="button primary" disabled={workflow.status !== 'published' || !workflow.enabled} onClick={() => { setRunMode('production'); setTestTargetNodeId(null); setRunTarget(workflow); setRunInput('{}'); }}><Play size={14}/>Prepare run</button></div>)}</div> : <EmptyState Icon={GitBranch} title="No saved workflows" text="Build your first process on the canvas and save it."/>}</section>
    {runTarget && <section className="workflow-run-prep panel"><div><span className="eyebrow">{runMode === 'dry-run' ? 'Dry-run fixture input' : runMode === 'test' ? 'Test input' : 'Run input'}</span><h2>{runTarget.name}{testTargetNodeId ? ` · ${testTargetNodeId}` : ''}</h2><p>{runMode === 'dry-run' ? 'This read-only preview never starts adapters, a run, a worker, a queue, or generated files. It checks the saved draft, tenant-scoped resources, permissions, bindings, limits, and budget.' : runMode === 'test' ? testTargetNodeId ? 'Woody follows the real draft path and stops after this node, so mappings and permissions are tested safely.' : 'This isolated test uses the current saved draft and does not change the published version.' : 'This production run uses the immutable published version.'} Provide a JSON object. Safe mappings such as <code>{'{{ input.topic }}'}</code> use these values.</p></div><textarea value={runInput} onChange={(event) => setRunInput(event.target.value)} spellCheck={false}/><div><button className="button" onClick={() => setRunTarget(null)}>Cancel</button><button className="button primary" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? <LoaderCircle className="spin" size={14}/> : runMode === 'dry-run' ? <Search size={14}/> : runMode === 'test' ? <TestTube2 size={14}/> : <Play size={14}/>} {runMode === 'dry-run' ? 'Preview dry run' : runMode === 'test' ? testTargetNodeId ? 'Test node path' : 'Test draft' : 'Run workflow'}</button></div></section>}
    {dryRunResult && <DryRunPanel result={dryRunResult} dismiss={() => setDryRunResult(null)}/>}
    {runId && <WorkflowRunPanel detail={runDetail.data} loading={runDetail.isLoading} refresh={() => void runDetail.refetch()} decide={(approvalId, decision) => decide.mutate({ approvalId, decision })} decideAction={(authorizationId, decision) => decideAction.mutate({ authorizationId, decision })} deciding={decide.isPending || decideAction.isPending}/>}
  </div>;
}

function SchemaNodeInspector({ node, definition, nodes, edges, resources, update, remove }: { node: WorkflowNode; definition: WorkflowNodeCatalogEntry; nodes: WorkflowNode[]; edges: WorkflowDefinition['edges']; resources: WorkflowResources; update: (changes: Record<string, unknown>) => void; remove: () => void }) {
  const retry = node.config.retry && typeof node.config.retry === 'object' ? node.config.retry as Record<string, unknown> : {};
  const upstreamIds = upstreamNodeIds(node.id, edges);
  const previousNodes = nodes.filter((item) => upstreamIds.has(item.id) && item.type !== 'output');
  const visibleFields = definition.configFields.filter((field) => {
    if (node.type !== 'loop') return true;
    const whileMode = String(node.config.mode ?? 'forEach') === 'while';
    if (field.key === 'condition') return whileMode;
    if (['collectionPath', 'itemVariable', 'indexVariable'].includes(field.key)) return !whileMode;
    return true;
  });
  const groupedFields = groupInspectorFields({ ...definition, configFields: visibleFields });
  const fieldByKey = new Map(visibleFields.map((field) => [field.key, field]));
  return <div className="node-config"><div className="inspector-title"><span>{paletteIcon(node.type)}</span><div><h2>{definition.title}</h2><code>{node.id}</code></div>{!['trigger', 'output'].includes(node.type) && <button className="icon-button danger" onClick={remove} aria-label={`Delete ${definition.title}`}><Trash2 size={14}/></button>}</div><p>{definition.description}</p>
    {(Object.entries(groupedFields) as Array<[InspectorSection, string[]]>).map(([section, keys]) => <fieldset className={`node-inspector-section ${section}`} key={section}><legend>{inspectorSectionLabels[section]}</legend>{keys.map((key) => { const field = fieldByKey.get(key); return field ? <ConfigField key={field.key} field={field} node={node} nodes={previousNodes} resources={resources} update={update}/> : null; })}</fieldset>)}
    {definition.retryable && <RetryEditor retry={retry} update={(value) => update({ retry: value })}/>}
    {['api_action', 'mcp_action', 'action'].includes(node.type) && previousNodes.length > 0 && <label>Map an upstream output<select value="" onChange={(event) => { if (!event.target.value) return; const current = node.config.input && typeof node.config.input === 'object' && !Array.isArray(node.config.input) ? node.config.input as Record<string, unknown> : {}; update({ input: { ...current, data: `{{ ${event.target.value} }}` } }); }}><option value="">Choose safe data to insert</option>{previousNodes.map((item) => <option value={item.type === 'trigger' ? 'input' : `nodes.${item.id}`} key={item.id}>{item.type === 'trigger' ? 'Workflow input' : item.id} → input.data</option>)}</select><small>Only nodes connected before this action are available. Woody inserts a safe reference and never executes JavaScript.</small></label>}
    <div className="node-permission-summary"><ShieldCheck size={16}/><span><strong>{permissionTitle(node, resources)}</strong><small>{permissionDetail(node, resources)}</small></span></div>
  </div>;
}

function ConfigField({ field, node, nodes, resources, update }: { field: WorkflowNodeCatalogEntry['configFields'][number]; node: WorkflowNode; nodes: WorkflowNode[]; resources: WorkflowResources; update: (changes: Record<string, unknown>) => void }) {
  const value = node.config[field.key];
  if (field.control === 'resource') {
    if (field.resource === 'agent') return <label>{field.label}{field.required && ' *'}<select value={String(value ?? '')} onChange={(event) => update({ [field.key]: event.target.value })}><option value="">Choose agent</option>{resources.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name} · {agent.role}</option>)}</select></label>;
    if (field.resource === 'api_tool') return <label>{field.label}{field.required && ' *'}<select value={String(value ?? '')} onChange={(event) => update({ [field.key]: event.target.value })}><option value="">Choose API</option>{resources.apiTools.map((tool) => <option value={tool.id} key={tool.id}>{tool.name}</option>)}</select></label>;
    if (field.resource === 'mcp_tool') {
      const current = `${String(node.config.agentId ?? '')}:${String(node.config.mcpToolId ?? '')}`;
      return <label>{field.label}{field.required && ' *'}<select value={current} onChange={(event) => { const [agentId, mcpToolId] = event.target.value.split(':'); update({ agentId, mcpToolId }); }}><option value=":">Choose app action</option>{resources.mcpTools.map((tool) => <option value={`${tool.agentId}:${tool.id}`} key={`${tool.agentId}:${tool.id}`}>{tool.connectionName} · {tool.title ?? tool.remoteName} · {tool.riskLevel.replaceAll('_', ' ')}</option>)}</select></label>;
    }
    return <label>{field.label}<select value={String(value ?? '')} onChange={(event) => update({ [field.key]: event.target.value || undefined })}><option value="">Entire workflow state</option>{nodes.filter((item) => item.id !== node.id && item.type !== 'trigger').map((item) => <option value={item.id} key={item.id}>{item.id}</option>)}</select></label>;
  }
  if (field.control === 'select') return <label>{field.label}{field.required && ' *'}<select value={String(value ?? field.options?.[0]?.value ?? '')} onChange={(event) => update({ [field.key]: event.target.value })}>{field.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>{field.help && <small>{field.help}</small>}</label>;
  if (field.control === 'number') return <label>{field.label}{field.required && ' *'}<input type="number" min={field.key === 'maxIterations' ? 1 : undefined} max={field.key === 'maxIterations' ? 100 : undefined} value={Number(value ?? (field.key === 'maxIterations' ? 10 : 8))} onChange={(event) => update({ [field.key]: Number(event.target.value) })}/>{field.help && <small>{field.help}</small>}</label>;
  if (field.control === 'json') return <label>{field.label}{field.required && ' *'}<textarea value={typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)} onChange={(event) => update({ [field.key]: parseValue(event.target.value) })} spellCheck={false}/>{field.help && <small>{field.help}</small>}</label>;
  if (field.control === 'multiselect') return <fieldset><legend>{field.label}</legend>{field.options?.map((option) => { const selected = Array.isArray(value) && value.includes(option.value); return <label className="check-row" key={option.value}><input type="checkbox" checked={selected} onChange={(event) => { const current = Array.isArray(value) ? value as string[] : []; update({ [field.key]: event.target.checked ? [...current, option.value] : current.filter((item) => item !== option.value) }); }}/><span>{option.label}</span></label>; })}</fieldset>;
  const Element = field.control === 'textarea' ? 'textarea' : 'input';
  return <label>{field.label}{field.required && ' *'}<Element value={String(value ?? '')} onChange={(event) => update({ [field.key]: event.target.value })}/>{field.help && <small>{field.help}</small>}</label>;
}

function RetryEditor({ retry, update }: { retry: Record<string, unknown>; update: (value: Record<string, unknown>) => void }) {
  const change = (key: string, value: number) => update({ ...retry, [key]: value });
  return <fieldset className="retry-editor"><legend>Retry policy</legend><label>Maximum attempts<input type="number" min="1" max="5" value={Number(retry.maxAttempts ?? 1)} onChange={(event) => change('maxAttempts', Number(event.target.value))}/></label><label>Initial delay (ms)<input type="number" min="0" max="60000" step="500" value={Number(retry.initialDelayMs ?? 1000)} onChange={(event) => change('initialDelayMs', Number(event.target.value))}/></label><label>Backoff multiplier<input type="number" min="1" max="4" step="0.5" value={Number(retry.multiplier ?? 2)} onChange={(event) => change('multiplier', Number(event.target.value))}/></label><label>Maximum delay (ms)<input type="number" min="0" max="300000" step="1000" value={Number(retry.maxDelayMs ?? 60000)} onChange={(event) => change('maxDelayMs', Number(event.target.value))}/></label></fieldset>;
}

function WorkflowEvaluationPanel({ workflow, report, reportError }: { workflow: Workflow; report: (message: string) => void; reportError: (message: string) => void }) {
  const queryClient = useQueryClient();
  const cases = useQuery({ queryKey: ['workflow-regression-cases', workflow.id], queryFn: () => api.workflowRegressionCases(workflow.id) });
  const history = useQuery({ queryKey: ['workflow-evaluations', workflow.id], queryFn: () => api.workflowEvaluationRuns(workflow.id) });
  const [name, setName] = useState('Regression case');
  const [caseInput, setCaseInput] = useState('{}');
  const [fixtures, setFixtures] = useState('{}');
  const [assertions, setAssertions] = useState('[\n  {"kind":"output.json_path","path":"result","operator":"equals","expected":"ok"}\n]');
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['workflow-regression-cases', workflow.id] }), queryClient.invalidateQueries({ queryKey: ['workflow-evaluations', workflow.id] })]); };
  const create = useMutation({
    mutationFn: () => api.createWorkflowRegressionCase(workflow.id, { name: name.trim(), input: JSON.parse(caseInput), fixtures: JSON.parse(fixtures), assertions: JSON.parse(assertions) }),
    onSuccess: async () => { report('Regression case saved.'); await refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not save regression case'),
  });
  const run = useMutation({
    mutationFn: (regression: WorkflowRegressionCase) => {
      if (!workflow.published_version_id) throw new Error('Publish a version before running a regression evaluation.');
      return api.runWorkflowEvaluation(workflow.id, { caseId: regression.id, workflowVersionId: workflow.published_version_id });
    },
    onSuccess: async (result) => { report(result.status === 'passed' ? 'Regression evaluation passed.' : 'Regression evaluation completed with failures.'); await refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not run regression evaluation'),
  });
  const remove = useMutation({
    mutationFn: (caseId: string) => api.deleteWorkflowRegressionCase(workflow.id, caseId),
    onSuccess: async () => { report('Regression case removed.'); await refresh(); },
    onError: (cause) => reportError(cause instanceof Error ? cause.message : 'Could not remove regression case'),
  });
  const regressionCases = cases.data?.data ?? [];
  const evaluations = history.data?.data ?? [];
  return <section className="workflow-evaluations panel" aria-label="Workflow regression evaluation">
    <div className="panel-header"><div><span className="eyebrow">Regression evaluation</span><h2>Fixture-backed checks</h2></div><button className="icon-button" type="button" onClick={() => void refresh()} aria-label="Refresh evaluation history"><RefreshCw size={14}/></button></div>
    <p>API, app, browser, and file fixtures are replayed locally by stable identity—no live external action is invoked. Each run uses the selected immutable published version and stores its trace and manifest.</p>
    <p className="inline-warning">Model-node evaluations are unavailable until a pinned model executor is configured. When enabled, they may incur real model cost; Woody will show that disclosure before starting. Replay is available separately.</p>
    <div className="workflow-evaluation-form"><label>Case name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={160}/></label><label>Input JSON<textarea value={caseInput} onChange={(event) => setCaseInput(event.target.value)} spellCheck={false}/></label><label>Fixtures JSON <small>Use keys like <code>api:tool-id:operation</code></small><textarea value={fixtures} onChange={(event) => setFixtures(event.target.value)} spellCheck={false}/></label><label>Assertions JSON<textarea value={assertions} onChange={(event) => setAssertions(event.target.value)} spellCheck={false}/></label><button className="button" type="button" disabled={create.isPending || !name.trim()} onClick={() => create.mutate()}>{create.isPending ? <LoaderCircle className="spin" size={14}/> : <Plus size={14}/>}Save case</button></div>
    <div className="workflow-evaluation-list"><h3>Cases</h3>{regressionCases.length ? regressionCases.map((regression) => <article key={regression.id}><span><strong>{regression.name}</strong><small>{regression.assertions.length} assertion{regression.assertions.length === 1 ? '' : 's'} · updated {relative(regression.updated_at)}</small></span><button className="button primary" type="button" disabled={!workflow.published_version_id || run.isPending} onClick={() => run.mutate(regression)}><TestTube2 size={14}/>Run</button><button className="icon-button" type="button" aria-label={`Delete ${regression.name}`} disabled={remove.isPending} onClick={() => remove.mutate(regression.id)}><Trash2 size={14}/></button></article>) : <p>No regression cases yet.</p>}</div>
    <div className="workflow-evaluation-list"><h3>History</h3>{evaluations.length ? evaluations.map((evaluation) => <article key={evaluation.id}><span><strong>{evaluation.regression_case_name ?? 'Regression case'}</strong><small>v{evaluation.workflow_version ?? '?'} · trace {evaluation.trace_id} · {relative(evaluation.started_at)}</small></span><Status value={evaluation.status}/><details><summary>Assertions and measurements</summary><OutputViewer value={{ measurements: evaluation.measurements, assertions: evaluation.assertion_results }}/></details></article>) : <p>No evaluations have run for this workflow.</p>}</div>
  </section>;
}

function DryRunPanel({ result, dismiss }: { result: WorkflowDryRun; dismiss: () => void }) {
  const issues = [...result.errors, ...result.warnings];
  return <section className="workflow-run panel" aria-label="Workflow dry run">
    <div className="panel-header"><div><span className="eyebrow">Read-only workflow preview</span><h2>{result.valid ? 'Dry run valid' : 'Dry run needs attention'}</h2></div><div><Status value={result.valid ? 'completed' : 'failed'}/><button className="icon-button" onClick={dismiss} aria-label="Dismiss dry run"><X size={14}/></button></div></div>
    <p>This preview did not create a run, queue work, generate artifacts, or invoke an adapter.</p>
    <div className="workflow-run-usage"><span><small>Path</small><strong>{result.executionPath.join(' → ') || 'None'}</strong></span><span><small>Agent calls</small><strong>{result.estimatedBudgets.agentCalls}</strong></span><span><small>Loop maximum</small><strong>{result.estimatedBudgets.maxLoopIterations}</strong></span><span><small>External actions</small><strong>{result.estimatedBudgets.externalActions}</strong></span></div>
    <section className="run-input-section"><h3>Manifest preview</h3><OutputViewer value={result.manifest}/></section>
    {result.pinnedAgents.length > 0 && <section className="run-input-section"><h3>Pinned agents</h3><OutputViewer value={result.pinnedAgents}/></section>}
    {result.externalActions.length > 0 && <section className="run-input-section"><h3>External actions</h3><OutputViewer value={result.externalActions}/></section>}
    {result.requiredApprovals.length > 0 && <section className="run-input-section"><h3>Required approvals</h3><OutputViewer value={result.requiredApprovals}/></section>}
    {result.missingResources.length > 0 && <section className="run-input-section"><h3>Missing resources</h3><OutputViewer value={result.missingResources} error/></section>}
    {issues.length > 0 && <section className="run-input-section"><h3>Errors and recovery</h3>{issues.map((item, index) => <div className={result.errors.includes(item) ? 'run-status-guide failed' : 'inline-warning'} key={`${item.code}-${index}`}><strong>{item.code}</strong><p>{item.message}</p><small>{item.guidance}</small></div>)}</section>}
  </section>;
}

function WorkflowRunPanel({ detail, loading, refresh, decide, decideAction, deciding }: { detail: Awaited<ReturnType<typeof api.workflowRun>> | undefined; loading: boolean; refresh: () => void; decide: (id: string, decision: 'approved' | 'rejected') => void; decideAction: (id: string, decision: 'approved' | 'rejected') => void; deciding: boolean }) {
  if (loading) return <section className="workflow-run panel"><p>Loading workflow trace…</p></section>;
  if (!detail) return null;
  const runDuration = detail.completed_at ? new Date(detail.completed_at).getTime() - new Date(detail.created_at).getTime() : null;
  const usageTokens = (detail.usage?.inputTokens ?? 0) + (detail.usage?.outputTokens ?? 0);
  const usageCost = detail.usage?.estimatedCostUsd ?? 0;
  const usageCostLabel = usageCost > 0 || usageTokens === 0 ? `$${money(usageCost)}` : 'Pricing unavailable';
  return <section className="workflow-run panel"><div className="panel-header"><div><span className="eyebrow">Latest launched run</span><h2>Persisted run trace</h2></div><div><Status value={detail.status}/><button className="icon-button" onClick={refresh} aria-label="Refresh workflow run"><RefreshCw size={14}/></button></div></div>{detail.status === 'failed' && <section className="run-status-guide failed"><AlertTriangle size={20}/><div><strong>This workflow test needs attention</strong><p>{failureGuidance(detail.output, 'workflow')}</p><span>Nothing destructive retries automatically. Correct the affected node, save the draft, and test again.</span></div></section>}<div className="workflow-run-usage"><span><small>Duration</small><strong>{runDuration !== null ? duration(Math.max(0, runDuration)) : 'In progress'}</strong></span><span><small>Agent tasks</small><strong>{detail.usage?.agentTasks ?? 0}</strong></span><span><small>Tokens</small><strong>{compact(usageTokens)}</strong></span><span><small>Cost</small><strong>{usageCostLabel}</strong></span></div>{detail.input && Object.keys(detail.input).length > 0 && <section className="run-input-section"><div className="section-title"><div><span className="eyebrow">Test data</span><h3>Workflow input</h3></div></div><OutputViewer value={detail.input}/></section>}{detail.nodeStates?.length ? <div className="workflow-node-states">{detail.nodeStates.map((state) => { const nodeDuration = state.completed_at ? new Date(state.completed_at).getTime() - new Date(state.started_at).getTime() : null; const hasData = state.input !== undefined || state.output !== undefined || state.error !== undefined; return <article key={state.id}><span>{nodeIconByStatus(state.status)}</span><span><strong>{state.node_id}</strong><small>{state.iteration_key} · attempt {state.attempt}{nodeDuration !== null ? ` · ${duration(Math.max(0, nodeDuration))}` : ''}</small></span><Status value={state.status}/>{hasData && <details className="workflow-node-data"><summary>Inspect node data</summary>{state.input !== undefined && <><h4>Input</h4><OutputViewer value={state.input}/></>}{state.output !== undefined && <><h4>Output</h4><OutputViewer value={state.output}/></>}{state.error !== undefined && <><h4>Error</h4><OutputViewer value={state.error} error/></>}</details>}</article>; })}</div> : null}<div className="workflow-run-events">{detail.events?.map((event) => <div key={event.id}><time>{new Date(event.created_at).toLocaleTimeString()}</time><span><strong>{event.event_type.replaceAll('.', ' ')}</strong><small>{event.message}</small></span></div>)}</div>{detail.approvals?.filter((approval) => approval.status === 'pending').map((approval) => <div className="workflow-approval" key={approval.id}><span><strong>Business approval required</strong><small>{approval.node_id}</small></span><button className="button danger" disabled={deciding} onClick={() => decide(approval.id, 'rejected')}>Reject</button><button className="button primary" disabled={deciding} onClick={() => decide(approval.id, 'approved')}>Approve</button></div>)}{detail.actionAuthorizations?.filter((authorization) => authorization.status === 'awaiting_confirmation').map((authorization) => <div className="workflow-approval action-bound" key={authorization.id}><span><strong>Confirm external action</strong><small>{authorization.target_summary ?? authorization.operation} · {authorization.risk_level.replaceAll('_', ' ')}</small><code>{JSON.stringify(authorization.arguments_summary)}</code></span><button className="button danger" disabled={deciding} onClick={() => decideAction(authorization.id, 'rejected')}>Reject</button><button className="button primary" disabled={deciding} onClick={() => decideAction(authorization.id, 'approved')}>Confirm action</button></div>)}{detail.artifacts?.length ? <WorkflowArtifacts artifacts={detail.artifacts}/> : null}{detail.output !== undefined && <section className="output-section"><h3>Workflow result</h3><OutputViewer value={detail.output} error={detail.status === 'failed'}/></section>}</section>;
}

function WorkflowArtifacts({ artifacts }: { artifacts: Artifact[] }) {
  const { reportError } = useWorkspace();
  const open = async (artifact: Artifact, inline: boolean) => {
    const pendingTab = inline ? window.open('', '_blank', 'noopener,noreferrer') : null;
    try {
      const file = await api.artifactFile(artifact.id, inline); const url = URL.createObjectURL(file.blob);
      if (inline && pendingTab) pendingTab.location.href = url;
      else { const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click(); }
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    catch (cause) { pendingTab?.close(); reportError(cause instanceof Error ? cause.message : 'Could not open artifact'); }
  };
  return <div className="workflow-artifacts"><h3>Generated files</h3>{artifacts.map((artifact) => <article key={artifact.id}><FileOutput size={16}/><span><strong>{artifact.filename}</strong><small>{artifact.status}</small></span><Status value={artifact.status}/>{artifact.status === 'ready' && artifact.format === 'pdf' && <button className="icon-button" aria-label={`Preview ${artifact.filename}`} onClick={() => void open(artifact, true)}><Eye size={14}/></button>}{artifact.status === 'ready' && <button className="icon-button" aria-label={`Download ${artifact.filename}`} onClick={() => void open(artifact, false)}><Download size={14}/></button>}</article>)}</div>;
}

function clientValidation(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'], catalog: WorkflowNodeCatalogEntry[]) {
  const errors: string[] = [];
  if (nodes.filter((node) => node.type === 'trigger').length !== 1) errors.push('Keep exactly one trigger.');
  if (!nodes.some((node) => node.type === 'output')) errors.push('Add an output node.');
  const known = new Set(nodes.map((node) => node.id));
  if (edges.some((edge) => !known.has(edge.source) || !known.has(edge.target))) errors.push('Remove connections to missing nodes.');
  if (edges.some((edge) => edge.source === edge.target)) errors.push('Connect each node to a different node.');
  for (const node of nodes) {
    const definition = catalog.find((entry) => entry.type === node.type);
    for (const field of definition?.configFields.filter((item) => item.required) ?? []) if (!node.config[field.key]) errors.push(`${definition?.title ?? node.type}: choose ${field.label.toLowerCase()}.`);
    const outgoing = edges.filter((edge) => edge.source === node.id);
    if (node.type === 'condition' && (!outgoing.some((edge) => edge.condition === 'true') || !outgoing.some((edge) => edge.condition === 'false'))) errors.push(`Condition ${node.id} needs True and False connections.`);
    if (node.type === 'loop' && (!outgoing.some((edge) => edge.condition === 'body') || !outgoing.some((edge) => edge.condition === 'done'))) errors.push(`Loop ${node.id} needs Body and Done connections.`);
    if (!['condition', 'loop', 'output'].includes(node.type) && outgoing.length !== 1) errors.push(`${node.id} needs exactly one outgoing connection.`);
  }
  const trigger = nodes.find((node) => node.type === 'trigger');
  if (trigger && edges.every((edge) => known.has(edge.source) && known.has(edge.target))) {
    const reachable = new Set([trigger.id]);
    const pending = [trigger.id];
    while (pending.length) {
      const source = pending.pop()!;
      for (const edge of edges.filter((candidate) => candidate.source === source)) if (!reachable.has(edge.target)) { reachable.add(edge.target); pending.push(edge.target); }
    }
    const unreachable = nodes.filter((node) => !reachable.has(node.id));
    if (unreachable.length) errors.push(`Connect ${unreachable.map((node) => node.id).join(', ')} to the workflow path.`);

    const outgoingWithoutLoopBack = new Map(nodes.map((node) => [node.id, edges.filter((edge) => edge.source === node.id && edge.condition !== 'continue')]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      const cyclic = (outgoingWithoutLoopBack.get(id) ?? []).some((edge) => hasCycle(edge.target));
      visiting.delete(id); visited.add(id);
      return cyclic;
    };
    if (nodes.some((node) => hasCycle(node.id))) errors.push('Remove the cycle, or use a bounded Loop with a Continue connection.');
  }
  return [...new Set(errors)];
}

function upstreamNodeIds(targetId: string, edges: WorkflowDefinition['edges']) {
  const result = new Set<string>();
  const pending = edges.filter((edge) => edge.target === targetId).map((edge) => edge.source);
  while (pending.length) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const edge of edges) if (edge.target === id && !result.has(edge.source)) pending.push(edge.source);
  }
  return result;
}

function nodeLabel(node: WorkflowNode, resources: WorkflowResources, fallbackAgents: Array<{ id: string; name: string }>, fallbackTools: Array<{ id: string; name: string }>) {
  if (node.type === 'trigger') return 'Manual input';
  if (node.type === 'output') return 'Return result';
  if (node.type === 'agent') return resources.agents.find((item) => item.id === node.config.agentId)?.name ?? fallbackAgents.find((item) => item.id === node.config.agentId)?.name ?? 'Choose agent';
  if (node.type === 'action' || node.type === 'api_action') return resources.apiTools.find((item) => item.id === node.config.toolId)?.name ?? fallbackTools.find((item) => item.id === node.config.toolId)?.name ?? 'Choose API';
  if (node.type === 'mcp_action') { const tool = resources.mcpTools.find((item) => item.id === node.config.mcpToolId && item.agentId === node.config.agentId); return tool ? `${tool.connectionName} · ${tool.title ?? tool.remoteName}` : 'Choose app action'; }
  if (node.type === 'knowledge_search') return `Search: ${String(node.config.query ?? 'query')}`;
  if (node.type === 'condition') return `${String(node.config.path ?? 'state')} ${String(node.config.operator ?? 'equals')}`;
  if (node.type === 'loop') return `${String(node.config.mode ?? 'forEach')} · max ${String(node.config.maxIterations ?? 10)}`;
  return 'Human approval';
}

function permissionTitle(node: WorkflowNode, resources: WorkflowResources) {
  if (node.type === 'mcp_action') return `${resources.mcpTools.find((item) => item.id === node.config.mcpToolId)?.riskLevel.replaceAll('_', ' ') ?? 'Unknown'} app permission`;
  if (node.type === 'api_action' || node.type === 'action') return 'API permission checked by the server';
  if (node.type === 'knowledge_search') return 'Workspace Knowledge · read only';
  if (node.type === 'agent') return 'Uses the selected agent’s access';
  return 'No external access';
}

function permissionDetail(node: WorkflowNode, resources: WorkflowResources) {
  if (node.type === 'mcp_action') { const tool = resources.mcpTools.find((item) => item.id === node.config.mcpToolId && item.agentId === node.config.agentId); return tool ? `${tool.connectionName}; ${tool.toolPermission.replace('_', ' ')}. Risky writes require confirmation for the final arguments.` : 'Choose an allowed app action.'; }
  if (node.type === 'api_action') return 'Read calls run immediately; writes and unknown actions pause for argument-bound confirmation.';
  if (node.type === 'action') return 'Legacy write actions require a directly preceding Approval node.';
  if (node.type === 'knowledge_search') return `${resources.knowledge.ready} indexed documents are currently searchable.`;
  return 'This node does not directly perform an external write.';
}

function paletteIcon(type: WorkflowNode['type']) {
  if (type === 'agent') return <Bot size={16}/>;
  if (type === 'mcp_action') return <Blocks size={16}/>;
  if (type === 'knowledge_search') return <BrainCircuit size={16}/>;
  if (type === 'api_action' || type === 'action') return <Wrench size={16}/>;
  if (type === 'approval') return <ShieldCheck size={16}/>;
  if (type === 'browser') return <Globe2 size={16}/>;
  return <GitBranch size={16}/>;
}

function ReviewLine({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }
function nodeIconByStatus(status: string) { return status === 'failed' ? <X size={14}/> : ['running', 'retrying', 'waiting'].includes(status) ? <LoaderCircle className="spin" size={14}/> : <CheckCircle2 size={14}/>; }
