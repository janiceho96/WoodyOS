import { Bot, TerminalSquare, WandSparkles, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Agent, Task } from '../../api';
import { useWorkspace } from '../../app/workspace';
import { EmptyState, PageHeader, Status } from '../../components/ui';
import { compact, duration, humanize, relative, taskCost } from '../../lib/format';

function visualStatus(agent: Agent, tasks: Task[]) {
  const latest = tasks.find((task) => task.agent_id === agent.id);
  if (latest?.status === 'failed') return 'error';
  return agent.status === 'active' ? 'active' : 'idle';
}

export function AgentsPage() {
  const { data } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'all' | 'active' | 'idle' | 'error'>('all');
  const selectedId = params.get('selected');
  const selected = data.agents.find((agent) => agent.id === selectedId) ?? null;
  const filtered = data.agents.filter((agent) => filter === 'all' || visualStatus(agent, data.tasks) === filter);
  const counts = useMemo(() => Object.fromEntries((['all', 'active', 'idle', 'error'] as const).map((value) => [value, data.agents.filter((agent) => value === 'all' || visualStatus(agent, data.tasks) === value).length])), [data.agents, data.tasks]);
  return <div className={`agent-control ${selected ? 'with-detail' : ''}`}>
    <div className="agent-main">
      <PageHeader eyebrow="Workforce" title="Agent Control Center" description="Manage and monitor your deployed AI agents." actions={<button className="button primary" onClick={() => navigate('/agents/new')}><WandSparkles size={16}/>Create Agent</button>}/>
      <div className="filter-row" role="group" aria-label="Filter agents">{(['all', 'active', 'idle', 'error'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value} <span>{counts[value]}</span></button>)}</div>
      {filtered.length ? <div className="agent-grid">{filtered.map((agent) => {
        const recent = data.tasks.find((task) => task.agent_id === agent.id);
        const capabilities = Object.entries(agent.capabilities ?? {}).filter(([, enabled]) => enabled).map(([key]) => key);
        return <button className={`agent-card panel ${selectedId === agent.id ? 'selected' : ''}`} key={agent.id} onClick={() => setParams({ selected: agent.id })}>
          <div className="agent-card-top"><span className="agent-glyph"><TerminalSquare size={23}/></span><Status value={visualStatus(agent, data.tasks)}/></div>
          <h2>{agent.name}</h2><p>{agent.role}</p>
          <div className="capability-tags">{capabilities.length ? capabilities.map((capability) => <span key={capability}>{humanize(capability)}</span>) : <span>No extra capabilities</span>}</div>
          <div className="agent-card-meta"><span><small>Model</small><strong>{agent.model}</strong></span><span><small>Last activity</small><strong>{recent ? relative(recent.updated_at) : 'No runs yet'}</strong></span></div>
        </button>;
      })}</div> : <EmptyState Icon={Bot} title="No agents in this view" text={data.agents.length ? 'Try another status filter.' : 'Create your first agent to start operating.'} action={!data.agents.length && <button className="button primary" onClick={() => navigate('/agents/new')}>Create Agent</button>}/>}
    </div>
    {selected && <AgentDetail agent={selected} tasks={data.tasks.filter((task) => task.agent_id === selected.id)} close={() => setParams({})} edit={() => navigate(`/agents/${selected.id}/edit`)} executions={() => navigate(`/executions?agent=${selected.id}`)}/>}
  </div>;
}

function AgentDetail({ agent, tasks, close, edit, executions }: { agent: Agent; tasks: Task[]; close: () => void; edit: () => void; executions: () => void }) {
  const done = tasks.filter((task) => task.status === 'completed').length;
  const failed = tasks.filter((task) => task.status === 'failed').length;
  const rate = done + failed ? Math.round(done / (done + failed) * 100) : null;
  const totalTokens = tasks.reduce((sum, task) => sum + Number(task.token_input ?? 0) + Number(task.token_output ?? 0), 0);
  const cost = taskCost(tasks);
  const completedDurations = tasks.filter((task) => task.duration_ms).map((task) => Number(task.duration_ms));
  const average = completedDurations.length ? completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length : null;
  return <aside className="agent-detail panel" aria-label={`${agent.name} details`}>
    <div className="detail-title"><h2>Agent Details</h2><button className="icon-button" onClick={close} aria-label="Close agent details"><X size={18}/></button></div>
    <div className="agent-identity"><span className="agent-glyph large"><TerminalSquare size={32}/><i/></span><h1>{agent.name}</h1><p>{agent.role}</p><Status value={agent.status}/><div className="detail-actions"><button className="button primary" onClick={executions}>Open executions</button><button className="button" onClick={edit}><WandSparkles size={15}/>Edit</button></div></div>
    <section><h3>Goal</h3><p>{agent.goal}</p></section>
    <section><h3>Performance metrics</h3><div className="detail-metrics"><span><small>Task success</small><strong>{rate === null ? '—' : `${rate}%`}</strong></span><span><small>Tokens used</small><strong>{compact(totalTokens)}</strong></span><span><small>Avg run time</small><strong>{average ? duration(average) : '—'}</strong></span><span><small>Total cost</small><strong>{cost.label}</strong></span></div></section>
    <section><div className="section-title"><h3>Recent executions</h3><button className="text-button" onClick={executions}>View all</button></div>{tasks.length ? <div className="mini-executions">{tasks.slice(0, 3).map((task) => <div key={task.id}><Status value={task.status}/><span><strong>{task.title}</strong><small>{relative(task.created_at)}{task.duration_ms ? ` · ${duration(task.duration_ms)}` : ''}</small></span></div>)}</div> : <p>No executions yet.</p>}</section>
    <section><h3>Model config</h3><div className="config-list"><span>LLM <strong>{agent.model}</strong></span><span>Temperature <strong>{agent.model_config?.temperature ?? 0.2}</strong></span><span>Max tokens <strong>{agent.model_config?.maxTokens ?? 4096}</strong></span></div></section>
  </aside>;
}
