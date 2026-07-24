import { Bot, WandSparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import { humanize, relative } from '../../lib/format';
import { AgentHubTabs } from './AgentHubTabs';
import { agentAvatarStatus, agentDisplayStatus, agentStatusDescription, type AgentDisplayStatus } from './agentStatus';

type AgentFilter = 'all' | Exclude<AgentDisplayStatus, 'archived'>;
const agentFilters = ['all', 'ready', 'working', 'draft', 'paused', 'needs_attention'] as const;

export function AgentsPage() {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [showArchived, setShowArchived] = useState(false);
  const selectedId = params.get('selected');
  useEffect(() => { if (selectedId && data.agents.some((agent) => agent.id === selectedId)) navigate(`/agents/${selectedId}`, { replace: true }); }, [data.agents, navigate, selectedId]);
  const visibleAgents = data.agents.filter((agent) => showArchived || agent.status !== 'archived');
  const filtered = visibleAgents.filter((agent) => filter === 'all' || agentDisplayStatus(agent, data.tasks) === filter);
  const counts = useMemo(() => Object.fromEntries(agentFilters.map((value) => [value, data.agents.filter((agent) => agent.status !== 'archived' && (value === 'all' || agentDisplayStatus(agent, data.tasks) === value)).length])), [data.agents, data.tasks]);
  const archivedCount = data.agents.filter((agent) => agent.status === 'archived').length;
  return <div className="agent-control">
    <div className="agent-main">
      <AgentHubTabs active="agents"/>
      <PageHeader eyebrow="Workforce" title="Agent Control Center" description="Manage and monitor your deployed AI agents." actions={<button className="button primary" onClick={() => navigate('/agents/new')}><WandSparkles size={16}/>Create Agent</button>}/>
      <div className="filter-row" role="group" aria-label="Filter agents">{agentFilters.map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'needs_attention' ? 'Attention' : value} <span>{counts[value]}</span></button>)}{archivedCount > 0 && <button className={showArchived ? 'active' : ''} aria-pressed={showArchived} onClick={() => { setShowArchived((value) => !value); setFilter('all'); }}>Archived <span>{archivedCount}</span></button>}</div>
      {filtered.length ? <div className="agent-grid">{filtered.map((agent) => {
        const recent = data.tasks.find((task) => task.agent_id === agent.id);
        const capabilities = Object.entries(agent.capabilities ?? {}).filter(([, enabled]) => enabled).map(([key]) => key);
        const status = agentDisplayStatus(agent, data.tasks);
        const assignedWebTool = data.tools.some((tool) => tool.enabled && agent.tool_ids.includes(tool.id) && tool.permissions.some((permission) => permission.startsWith('web.') || permission === 'reddit.read'));
        const readiness = agent.capabilities.webBrowser && !assignedWebTool ? 'Web access is on, but no web tool is assigned' : agentStatusDescription(status);
        return <button className="agent-card panel" key={agent.id} onClick={() => navigate(`/agents/${agent.id}`)}>
          <div className="agent-card-top"><AgentAvatar agent={agent} size="md" status={agentAvatarStatus(status)}/><Status value={status}/></div>
          <h2>{agent.name}</h2><p>{agent.role}</p>
          <div className="capability-tags">{capabilities.length ? capabilities.map((capability) => <span key={capability}>{humanize(capability)}</span>) : <span>No extra capabilities</span>}</div>
          <p className={`agent-readiness-note ${status}`}>{readiness}</p>
          <div className="agent-card-meta"><span><small>Model</small><strong>{agent.model}</strong></span><span><small>Last activity</small><strong>{recent ? relative(recent.updated_at) : 'No activity yet'}</strong></span></div>
        </button>;
      })}</div> : <EmptyState Icon={Bot} title="No agents in this view" text={data.agents.length ? 'Try another status filter.' : 'Create your first agent to start operating.'} action={!data.agents.length && <button className="button primary" onClick={() => navigate('/agents/new')}>Create Agent</button>}/>}
    </div>
  </div>;
}
