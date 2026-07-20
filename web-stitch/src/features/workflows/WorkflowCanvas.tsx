import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
  useNodesState,
} from '@xyflow/react';
import { Bot, Blocks, BrainCircuit, FileOutput, Maximize2, Network, PlugZap, Repeat2, ShieldCheck, Split, Undo2, Redo2, Wrench, Zap } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeCatalogEntry } from '../../api';

type PositionRecord = { nodeId: string; x: number; y: number };
type CanvasNodeData = Record<string, unknown> & {
  workflowNode: WorkflowNode;
  definition: WorkflowNodeCatalogEntry;
  label: string;
  active: boolean;
};
type CanvasNode = Node<CanvasNodeData, 'woody'>;

export type WorkflowCanvasProps = {
  nodes: WorkflowNode[];
  edges: WorkflowDefinition['edges'];
  positions: PositionRecord[];
  viewport: { x: number; y: number; zoom: number };
  catalog: WorkflowNodeCatalogEntry[];
  selectedNodeId: string;
  activeNodeIds?: Set<string>;
  simpleMode: boolean;
  canUndo: boolean;
  canRedo: boolean;
  labelFor: (node: WorkflowNode) => string;
  onSelectNode: (id: string) => void;
  onMoveNode: (id: string, position: { x: number; y: number }) => void;
  onViewportChange: (viewport: { x: number; y: number; zoom: number }) => void;
  onConnect: (connection: Connection) => void;
  onDeleteNodes: (ids: string[]) => void;
  onDeleteEdges: (edges: WorkflowDefinition['edges']) => void;
  onDropNode: (type: WorkflowNode['type'], position: { x: number; y: number }) => void;
  onAutoLayout: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleMode: () => void;
};

function iconFor(type: WorkflowNode['type']) {
  if (type === 'trigger') return <Zap size={16}/>;
  if (type === 'agent') return <Bot size={16}/>;
  if (type === 'action') return <Wrench size={16}/>;
  if (type === 'api_action') return <PlugZap size={16}/>;
  if (type === 'mcp_action') return <Blocks size={16}/>;
  if (type === 'knowledge_search') return <BrainCircuit size={16}/>;
  if (type === 'condition') return <Split size={16}/>;
  if (type === 'loop') return <Repeat2 size={16}/>;
  if (type === 'approval') return <ShieldCheck size={16}/>;
  return <FileOutput size={16}/>;
}

const WorkflowCanvasNode = memo(function WorkflowCanvasNode({ data, selected }: NodeProps<CanvasNode>) {
  const { workflowNode, definition, label, active } = data;
  const outputs = definition.outputPorts;
  return <div className={`flow-node-card ${workflowNode.type} ${selected ? 'selected' : ''} ${active ? 'executing' : ''}`}>
    {definition.inputPorts.length > 0 && <Handle type="target" position={Position.Left} id="input" className="typed-handle input"/>}
    <div className="flow-node-head"><span>{iconFor(workflowNode.type)}</span><small>{definition.title}</small>{active && <i>RUNNING</i>}</div>
    <strong>{label}</strong>
    <code>{workflowNode.id}</code>
    {outputs.map((port, index) => <div className="flow-port-label" key={port.id} style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }}>{port.label}</div>)}
    {outputs.map((port, index) => <Handle key={port.id} type="source" position={Position.Right} id={port.id} className={`typed-handle output ${port.dataType}`} style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }}/>) }
  </div>;
});

const nodeTypes = { woody: WorkflowCanvasNode };

function edgeId(edge: WorkflowDefinition['edges'][number], index: number) {
  return `${edge.source}:${edge.condition ?? 'output'}:${edge.target}:${index}`;
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  const { catalog, positions, nodes, selectedNodeId, activeNodeIds, labelFor, viewport } = props;
  const wrapper = useRef<HTMLDivElement>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<CanvasNode, Edge> | null>(null);
  const catalogByType = useMemo(() => new Map(catalog.map((entry) => [entry.type, entry])), [catalog]);
  const positionById = useMemo(() => new Map(positions.map((position) => [position.nodeId, position])), [positions]);
  const derivedNodes = useMemo<CanvasNode[]>(() => nodes.flatMap((workflowNode, index) => {
    const definition = catalogByType.get(workflowNode.type);
    if (!definition) return [];
    const position = positionById.get(workflowNode.id) ?? { x: 50 + index * 285, y: 280 };
    return [{ id: workflowNode.id, type: 'woody', position: { x: position.x, y: position.y }, data: { workflowNode, definition, label: labelFor(workflowNode), active: activeNodeIds?.has(workflowNode.id) ?? false }, selected: selectedNodeId === workflowNode.id, deletable: !['trigger', 'output'].includes(workflowNode.type) }];
  }), [catalogByType, positionById, nodes, selectedNodeId, activeNodeIds, labelFor]);
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<CanvasNode>(derivedNodes);
  useEffect(() => setFlowNodes(derivedNodes), [derivedNodes, setFlowNodes]);
  const flowEdges = useMemo<Edge[]>(() => props.edges.map((edge, index) => ({
    id: edgeId(edge, index),
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.condition && edge.condition !== 'continue' ? edge.condition : 'output',
    targetHandle: 'input',
    label: edge.condition,
    animated: props.activeNodeIds?.has(edge.target) ?? false,
    markerEnd: { type: MarkerType.ArrowClosed },
    className: edge.condition ? `flow-edge ${edge.condition}` : 'flow-edge',
  })), [props.edges, props.activeNodeIds]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/woody-node') as WorkflowNode['type'];
    if (!type || !instance) return;
    props.onDropNode(type, instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };
  const fullscreen = async () => {
    if (!wrapper.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await wrapper.current.requestFullscreen();
  };

  return <div className="visual-workflow-canvas" ref={wrapper} onDrop={onDrop} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}>
    <div className="canvas-toolbar" aria-label="Workflow canvas controls">
      <button type="button" onClick={props.onToggleMode}><Network size={14}/>{props.simpleMode ? 'Simple' : 'Advanced'}</button>
      <button type="button" onClick={props.onUndo} disabled={!props.canUndo} aria-label="Undo"><Undo2 size={14}/></button>
      <button type="button" onClick={props.onRedo} disabled={!props.canRedo} aria-label="Redo"><Redo2 size={14}/></button>
      <button type="button" onClick={props.onAutoLayout}>Auto layout</button>
      <button type="button" onClick={() => void fullscreen()} aria-label="Toggle full screen"><Maximize2 size={14}/></button>
    </div>
    <ReactFlow<CanvasNode, Edge>
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onInit={setInstance}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => props.onSelectNode(node.id)}
      onNodeDragStop={(_, node) => props.onMoveNode(node.id, node.position)}
      onMoveEnd={(_, viewport) => props.onViewportChange(viewport)}
      onNodesDelete={(removed) => props.onDeleteNodes(removed.filter((node) => !['trigger', 'output'].includes(node.data.workflowNode.type)).map((node) => node.id))}
      onEdgesDelete={(removed) => props.onDeleteEdges(removed.map((edge) => props.edges.find((candidate, index) => edge.id === edgeId(candidate, index))).filter((edge): edge is WorkflowDefinition['edges'][number] => Boolean(edge)))}
      onConnect={props.onConnect}
      nodesConnectable
      nodesDraggable
      edgesReconnectable={false}
      fitView
      defaultViewport={viewport}
      minZoom={0.15}
      maxZoom={2.5}
      deleteKeyCode={['Backspace', 'Delete']}
      proOptions={{ hideAttribution: true }}
      colorMode={document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1}/>
      <Controls position="bottom-left" showInteractive={false}/>
      <MiniMap pannable zoomable nodeColor={(node) => node.data.active ? '#34d399' : '#7c7ff2'} maskColor="rgba(5,7,16,.72)"/>
    </ReactFlow>
  </div>;
}
