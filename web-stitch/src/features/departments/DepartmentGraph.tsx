import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  BriefcaseBusiness,
  Building2,
  ExternalLink,
  Network,
  Share2,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  Department,
  OrganizationAgentSummary,
  OrganizationSnapshot,
} from '../../api';
import {
  buildDepartmentGraph,
  type DepartmentGraphEdge,
  type DepartmentGraphNode,
} from './departmentLayout';
import type { DepartmentView } from './departmentState';
import { isDepartmentFocusTarget } from './departmentState';

type GraphCallbacks = {
  onFocus?: (id: string) => void;
  onEditDepartment?: (departmentId: string) => void;
  canEdit?: boolean;
};

function metricLabel(data: DepartmentGraphNode['data']) {
  const metrics = [
    data.activeWorkCount ? `${data.activeWorkCount} active` : '',
    data.mcpConnectionCount ? `${data.mcpConnectionCount} MCP` : '',
    data.apiToolCount ? `${data.apiToolCount} API` : '',
  ].filter(Boolean);
  return metrics.length ? metrics.join(' · ') : 'No active work';
}

function DepartmentOrgNode({ id, data }: NodeProps<DepartmentGraphNode>) {
  const callbacks = data as DepartmentGraphNode['data'] & GraphCallbacks;
  const focus = () => {
    if (isDepartmentFocusTarget(id)) callbacks.onFocus?.(id);
  };
  if (data.kind === 'workspace') {
    return <button type="button" className="department-node workspace-node" onClick={focus}>
      <Building2 size={18}/><span><small>Workspace</small><strong>{data.name}</strong></span>
    </button>;
  }
  if (data.kind === 'shared-rail') {
    return <button type="button" className="department-node shared-rail-node" onClick={focus}>
      <Share2 size={17}/><span><small>Collaboration rail</small><strong>{data.name}</strong></span>
    </button>;
  }
  if (data.kind === 'department') {
    return <article className="department-node department-card">
      <button type="button" onClick={focus} aria-label={`Focus ${data.name}`}>
        <BriefcaseBusiness size={17}/><span><small>Department</small><strong>{data.name}</strong><em>{data.memberCount} members · {data.activeWorkCount} active work</em></span>
      </button>
      {callbacks.canEdit && data.departmentId && <button
        type="button"
        className="department-node-edit nodrag"
        onClick={(event) => {
          event.stopPropagation();
          callbacks.onEditDepartment?.(data.departmentId as string);
        }}
        aria-label={`Edit ${data.name}`}
      >Edit</button>}
    </article>;
  }
  const icon = data.kind === 'executive'
    ? <Network size={17}/>
    : data.kind === 'manager'
      ? <UsersRound size={17}/>
      : <UserRound size={17}/>;
  return <article className={`department-node agent-node ${data.kind}`}>
    <button type="button" onClick={focus} aria-label={`Focus ${data.name}`}>
      {icon}<span><small>{data.kind === 'executive' ? 'Executive' : data.kind === 'manager' ? 'Manager' : data.role}</small><strong>{data.name}</strong><em>{data.kind === 'executive' ? data.description : metricLabel(data)}</em></span>
    </button>
    {data.agentId && <Link
      className="department-agent-link nodrag"
      to={`/agents/${data.agentId}`}
      aria-label={`Open ${data.name} Agent Workspace`}
    ><ExternalLink size={13}/></Link>}
  </article>;
}

const nodeTypes = { departmentOrg: DepartmentOrgNode };

export function DepartmentGraph({
  snapshot,
  workspaceName,
  view,
  focusId,
  visibleAgentIds,
  departmentId,
  resetKey,
  onFocus,
  onEditDepartment,
  canEdit,
}: {
  snapshot: OrganizationSnapshot;
  workspaceName: string;
  view: DepartmentView;
  focusId: string | null;
  visibleAgentIds: ReadonlySet<string>;
  departmentId?: string;
  resetKey: number;
  onFocus: (id: string) => void;
  onEditDepartment: (departmentId: string) => void;
  canEdit: boolean;
}) {
  const [instance, setInstance] = useState<ReactFlowInstance<DepartmentGraphNode, DepartmentGraphEdge> | null>(null);
  const graph = useMemo(() => buildDepartmentGraph(snapshot, {
    view,
    focusId,
    visibleAgentIds,
    workspaceName,
    departmentId,
  }), [snapshot, view, focusId, visibleAgentIds, workspaceName, departmentId]);
  const nodes = useMemo(() => graph.nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      onFocus,
      onEditDepartment,
      canEdit,
    },
  })), [graph.nodes, onFocus, onEditDepartment, canEdit]);
  useEffect(() => {
    if (!instance) return;
    const frame = window.requestAnimationFrame(() => {
      void instance.fitView({ padding: 0.16, duration: 240 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [instance, resetKey, nodes.length, graph.edges.length, focusId, view]);

  return <div className="department-flow" aria-label="Department organization graph">
    <ReactFlow<DepartmentGraphNode, DepartmentGraphEdge>
      nodes={nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.35}
      maxZoom={1.4}
      fitView
      onInit={setInstance}
      onNodeClick={(_, node) => {
        if (isDepartmentFocusTarget(node.id)) onFocus(node.id);
      }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1}/>
      <Controls showInteractive={false}/>
    </ReactFlow>
  </div>;
}

function compareDepartment(left: Department, right: Department) {
  return left.displayOrder - right.displayOrder
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function compareAgent(left: OrganizationAgentSummary, right: OrganizationAgentSummary) {
  return left.role.localeCompare(right.role)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function AgentListItem({
  agent,
  label,
  onFocus,
}: {
  agent: OrganizationAgentSummary;
  label: string;
  onFocus: (id: string) => void;
}) {
  return <li className="department-list-agent">
    <button type="button" onClick={() => onFocus(`agent:${agent.id}`)} aria-label={`Focus ${agent.name}`}>
      <UserRound size={15}/><span><strong>{agent.name}</strong><small>{label} · {agent.status} · {agent.activeWorkCount} active work</small></span>
    </button>
    <Link to={`/agents/${agent.id}`} aria-label={`Open ${agent.name} Agent Workspace`}>
      Open agent <ExternalLink size={12}/>
    </Link>
  </li>;
}

export function DepartmentHierarchyList({
  snapshot,
  workspaceName,
  view = 'org',
  focusId,
  visibleAgentIds,
  departmentId,
  onFocus,
  onEditDepartment,
  canEdit,
}: {
  snapshot: OrganizationSnapshot;
  workspaceName: string;
  view?: DepartmentView;
  focusId: string | null;
  visibleAgentIds: ReadonlySet<string>;
  departmentId?: string;
  onFocus: (id: string) => void;
  onEditDepartment: (departmentId: string) => void;
  canEdit: boolean;
}) {
  const graph = buildDepartmentGraph(snapshot, {
    view,
    focusId,
    visibleAgentIds,
    departmentId,
    workspaceName,
  });
  const renderedIds = new Set(graph.nodes.map((node) => node.id));
  const renderedAgentKinds = new Map(graph.nodes
    .filter((node) => node.data.agentId)
    .map((node) => [node.data.agentId!, node.data.kind]));
  const agentById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  const executive = snapshot.executiveAgentId
    ? agentById.get(snapshot.executiveAgentId)
    : undefined;
  const departments = snapshot.departments.filter((department) => (
    department.status === 'active' && renderedIds.has(`department:${department.id}`)
  )).sort(compareDepartment);
  const sharedAgents = snapshot.agents.filter((agent) => (
    renderedAgentKinds.get(agent.id) === 'shared-agent'
  )).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  return <nav className="department-hierarchy-list" aria-label="Department hierarchy">
    <header>
      <span><Building2 size={18}/><span><small>Workspace</small><h2>{workspaceName}</h2></span></span>
    </header>
    {executive && renderedIds.has(`agent:${executive.id}`) && <ul>
      <AgentListItem
        agent={executive}
        label={`Executive${snapshot.memberships.some((membership) => membership.agentId === executive.id)
          ? ` · Department reference: ${snapshot.memberships.filter((membership) => membership.agentId === executive.id).map((membership) => snapshot.departments.find((department) => department.id === membership.departmentId)?.name).filter(Boolean).join(', ')}`
          : ''}`}
        onFocus={onFocus}
      />
    </ul>}
    <ul className="department-list-branches">
      {departments.map((department) => {
        const departmentAgentIds = new Set(snapshot.memberships.filter((membership) => (
          membership.departmentId === department.id
        )).map((membership) => membership.agentId));
        const departmentAgents = [...departmentAgentIds].map((agentId) => agentById.get(agentId))
          .filter((agent): agent is OrganizationAgentSummary => Boolean(agent));
        const primaryAgents = snapshot.memberships.filter((membership) => (
          membership.departmentId === department.id
          && membership.membershipType === 'primary'
          && (renderedAgentKinds.get(membership.agentId) === 'agent'
            || renderedAgentKinds.get(membership.agentId) === 'manager')
        )).map((membership) => agentById.get(membership.agentId))
          .filter((agent): agent is OrganizationAgentSummary => Boolean(agent))
          .sort(compareAgent);
        const manager = department.managerAgentId
          ? primaryAgents.find((agent) => agent.id === department.managerAgentId)
          : undefined;
        const ordered = manager
          ? [manager, ...primaryAgents.filter((agent) => agent.id !== manager.id)]
          : primaryAgents;
        return <li key={department.id} className="department-list-branch">
          <div>
            <span><BriefcaseBusiness size={16}/><span><strong>{department.name}</strong><small>{departmentAgents.length} members · {departmentAgents.reduce((total, agent) => total + agent.activeWorkCount, 0)} active work · {department.description || 'No description'}</small></span></span>
            <span>
              <button type="button" onClick={() => onFocus(`department:${department.id}`)} aria-label={`Focus ${department.name}`}>Focus</button>
              {canEdit && <button type="button" onClick={() => onEditDepartment(department.id)} aria-label={`Edit ${department.name}`}>Edit</button>}
            </span>
          </div>
          {ordered.length > 0 && <ul>{ordered.map((agent) => <AgentListItem
            key={agent.id}
            agent={agent}
            label={agent.id === department.managerAgentId ? 'Manager' : agent.role}
            onFocus={onFocus}
          />)}</ul>}
        </li>;
      })}
    </ul>
    {sharedAgents.length > 0 && <section aria-labelledby="shared-specialists-heading">
      <h3 id="shared-specialists-heading"><Share2 size={15}/>Shared specialists</h3>
      <ul>{sharedAgents.map((agent) => {
        const assignments = snapshot.memberships.filter((membership) => (
          membership.agentId === agent.id
        )).map((membership) => snapshot.departments.find((department) => (
          department.id === membership.departmentId
        ))?.name).filter(Boolean).join(', ');
        return <AgentListItem key={agent.id} agent={agent} label={`Assigned to ${assignments}`} onFocus={onFocus}/>;
      })}</ul>
    </section>}
  </nav>;
}
