import { ArrowLeft, Bot, History, LayoutDashboard, Play, Settings2, Workflow } from 'lucide-react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useWorkspace } from '../../app/workspace';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import type { AgentSection } from './agentExecution';

const sections: Array<{ id: AgentSection; label: string; description: string; Icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', description: 'Purpose and next action', Icon: LayoutDashboard },
  { id: 'workspace', label: 'Workspace', description: 'Task, conversation and result', Icon: Play },
  { id: 'configure', label: 'Configure', description: 'Model, tools and permissions', Icon: Settings2 },
  { id: 'workflow', label: 'Workflow', description: 'Steps, routing and agents', Icon: Workflow },
  { id: 'history', label: 'History', description: 'Previous tasks and outputs', Icon: History },
];

export function AgentWorkspaceNav({ agentId, close }: { agentId: string; close: () => void }) {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const agent = data.agents.find((candidate) => candidate.id === agentId);
  const current = (params.get('section') ?? 'overview') as AgentSection;
  const setSection = (section: AgentSection) => { const next = new URLSearchParams(params); next.set('section', section); next.delete('event'); setParams(next); close(); };
  const chooseAgent = (nextId: string) => { const next = new URLSearchParams(); next.set('section', current); navigate(`/agents/${nextId}?${next.toString()}`); close(); };
  return <nav className="agent-context-nav" aria-label="Agent workspace navigation">
    <button className="agent-nav-back" onClick={() => { navigate('/agents'); close(); }}><ArrowLeft size={16}/>All agents</button>
    {agent && <div className="agent-nav-identity"><AgentAvatar agent={agent} size="md"/><div><strong>{agent.name}</strong><small>{agent.role}</small></div></div>}
    <label className="agent-nav-selector"><span>Selected agent</span><select value={agentId} onChange={(event) => chooseAgent(event.target.value)}>{data.agents.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
    <div className="agent-nav-sections">{sections.map(({ id, label, description, Icon }) => <button key={id} className={current === id ? 'active' : ''} aria-current={current === id ? 'page' : undefined} onClick={() => setSection(id)}><Icon size={17}/><span><strong>{label}</strong><small>{description}</small></span></button>)}</div>
    <button className="agent-nav-create" onClick={() => { navigate('/agents/new', { state: { from: location.pathname + location.search } }); close(); }}><Bot size={16}/>Create another agent</button>
  </nav>;
}
